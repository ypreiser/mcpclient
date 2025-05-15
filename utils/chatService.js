// chatService.js
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js"; // Import SSoT model
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";

const sessions = new Map();

const getSession = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return { status: "not_found" };
  return {
    status: session.status,
    systemPromptName: session.systemPromptName,
    userId: session.userId,
  };
};

const validateSystemPrompt = async (systemPromptName, userIdExpectedOwner) => {
  const systemPromptDoc = await SystemPrompt.findOne({
    name: systemPromptName,
    userId: userIdExpectedOwner, // The user who should own this prompt
  });

  if (!systemPromptDoc) {
    const promptExists = await SystemPrompt.exists({ name: systemPromptName });
    if (promptExists) {
      logger.warn(
        { userIdExpectedOwner, systemPromptName },
        "Authorization Failed: User attempted to access system prompt they do not own or was expected to own."
      );
      const authError = new Error(
        `Access denied or ownership mismatch for system prompt '${systemPromptName}'.`
      );
      authError.status = 403;
      throw authError;
    } else {
      logger.warn(
        { userIdExpectedOwner, systemPromptName },
        "Not Found: System prompt requested does not exist."
      );
      const notFoundError = new Error(
        `System prompt '${systemPromptName}' not found.`
      );
      notFoundError.status = 404;
      throw notFoundError;
    }
  }
  return systemPromptDoc;
};

const cleanupSession = async (sessionId) => {
  const sessionToClean = sessions.get(sessionId);
  if (sessionToClean) {
    if (sessionToClean.aiInstance?.closeMcpClients) {
      try {
        await sessionToClean.aiInstance.closeMcpClients();
        logger.info(`MCP clients for session '${sessionId}' closed.`);
      } catch (err) {
        logger.error(
          { err, sessionId },
          "Error closing MCP clients during session cleanup."
        );
      }
    }
    sessions.delete(sessionId);
    logger.info(`In-memory session '${sessionId}' cleaned up.`);
  }
};

const initializeSession = async (
  sessionId,
  systemPromptName,
  userIdForTokenBilling
) => {
  try {
    if (!userIdForTokenBilling) {
      logger.error(
        { sessionId, systemPromptName },
        "Cannot initialize chat session: userIdForTokenBilling is undefined."
      );
      throw new Error(
        "User ID for token billing is required to initialize chat session."
      );
    }

    if (sessions.has(sessionId)) {
      logger.warn(
        `Service: Session '${sessionId}' already exists. Aborting new initialization.`
      );
      const err = new Error(`Session '${sessionId}' is already active.`);
      err.status = 409;
      throw err;
    }

    // For chatService (typically webapp), userIdForTokenBilling is the prompt owner's ID.
    const systemPromptDoc = await validateSystemPrompt(
      systemPromptName,
      userIdForTokenBilling
    );

    const aiInstance = await initializeAI(systemPromptName);
    const systemPromptText = systemPromptToNaturalLanguage(
      systemPromptDoc.toObject()
    );
    Object.assign(aiInstance, { systemPromptText });

    sessions.set(sessionId, {
      aiInstance,
      status: "active",
      systemPromptName,
      userId: userIdForTokenBilling, // User whose tokens will be counted
      systemPromptId: systemPromptDoc._id, // Store ID for logging
    });

    logger.info(
      `Service: Chat session initialized for '${sessionId}' with prompt '${systemPromptName}'. Tokens billed to user '${userIdForTokenBilling}'.`
    );
    return { status: "active", sessionId, systemPromptName };
  } catch (error) {
    logger.error(
      {
        err: error,
        sessionId,
        systemPromptName,
        userId: userIdForTokenBilling,
      },
      `Service: Error in initializeSession`
    );
    await cleanupSession(sessionId);
    throw error;
  }
};

const processMessage = async (
  sessionId,
  messageContent,
  userIdForTokenBilling,
  attachments = [] // Accept attachments
) => {
  const session = sessions.get(sessionId);
  if (!session) {
    const notFoundError = new Error(
      `Chat session not found (ID: ${sessionId}). Please start new chat.`
    );
    notFoundError.status = 404;
    throw notFoundError;
  }
  if (session.status !== "active") {
    const inactiveError = new Error(
      `Chat session '${sessionId}' is not active (status: ${session.status})`
    );
    inactiveError.status = 400;
    throw inactiveError;
  }
  if (session.userId.toString() !== userIdForTokenBilling.toString()) {
    logger.error(
      {
        sessionId,
        messageUserId: userIdForTokenBilling,
        sessionUserId: session.userId,
      },
      "CRITICAL: User ID mismatch in processMessage for chatService."
    );
    const authError = new Error(
      "User ID mismatch for session. Cannot process message."
    );
    authError.status = 403;
    throw authError;
  }
  if (!messageContent?.trim()) {
    const invalidInputError = new Error("Message content cannot be empty.");
    invalidInputError.status = 400;
    throw invalidInputError;
  }

  const { aiInstance, systemPromptId, systemPromptName } = session;
  const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
    aiInstance;

  try {
    let chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId: userIdForTokenBilling, // Chat doc associated with prompt owner
    });

    if (!chat) {
      logger.error(
        { sessionId, userId: userIdForTokenBilling },
        "CRITICAL: Chat document NOT FOUND in processMessage for webapp."
      );
      const notFoundDbError = new Error(
        `Chat history could not be loaded for session ${sessionId}.`
      );
      notFoundDbError.status = 404;
      throw notFoundDbError;
    }

    // Prepare files for AI if attachments exist
    let filesForAI = [];
    const fs = await import("fs/promises");
    const path = await import("path");
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        try {
          // Only allow files from uploads dir, sanitize filename
          const uploadsDir = path.resolve(process.cwd(), "uploads");
          const filePath = path.join(uploadsDir, path.basename(att.url));
          // Read file as Buffer
          const fileBuffer = await fs.readFile(filePath);
          filesForAI.push({
            name: att.originalName,
            mimeType: att.mimeType,
            buffer: fileBuffer,
          });
        } catch (err) {
          logger.error({ err, att }, "Failed to load attachment for AI");
        }
      }
    }

    // Save user message (with attachments if any)
    chat.messages.push({
      role: "user",
      content: messageContent,
      timestamp: new Date(),
      attachments:
        Array.isArray(attachments) && attachments.length > 0 ? attachments : [],
      status: "sent",
    });
    const messagesForAI = chat.messages
      .slice(-20)
      .map((msg) => ({ role: msg.role, content: msg.content }));

    // Prepare ai-sdk files argument if any
    let aiFilesArg = undefined;
    if (filesForAI.length > 0) {
      // ai-sdk expects: [{ name, mimeType, data }]
      aiFilesArg = filesForAI.map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        data: f.buffer,
      }));
    }

    const response = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      maxSteps: 10,
      system: systemPromptText,
      messages: messagesForAI,
      ...(aiFilesArg ? { files: aiFilesArg } : {}),
    });

    if (response.usage) {
      const { promptTokens, completionTokens } = response.usage;
      if (
        typeof promptTokens === "number" &&
        typeof completionTokens === "number"
      ) {
        const totalTokens = promptTokens + completionTokens;
        const usageRecord = new TokenUsageRecord({
          userId: userIdForTokenBilling,
          systemPromptId: systemPromptId,
          systemPromptName: systemPromptName,
          chatId: chat._id,
          source: "webapp",
          modelName: GEMINI_MODEL_NAME, // Assuming GEMINI_MODEL_NAME is the actual model used
          promptTokens,
          completionTokens,
          totalTokens,
          timestamp: new Date(),
        });
        await usageRecord.save();

        // Update denormalized counters
        await User.logTokenUsage({
          userId: userIdForTokenBilling,
          promptTokens,
          completionTokens,
        });
        await SystemPrompt.logTokenUsage({
          systemPromptId,
          promptTokens,
          completionTokens,
        });
        // Optionally update Chat model counters if you add them there

        logger.info(
          {
            userId: userIdForTokenBilling,
            systemPromptId,
            promptTokens,
            completionTokens,
            totalTokens,
            source: "webapp",
          },
          "Token usage logged."
        );
      } else {
        logger.warn(
          {
            userId: userIdForTokenBilling,
            usage: response.usage,
            source: "webapp",
          },
          "Invalid token usage data from AI SDK."
        );
      }
    } else {
      logger.warn(
        { userId: userIdForTokenBilling, source: "webapp" },
        "Token usage data not available from AI SDK."
      );
    }

    const assistantResponseText = response.text ?? "AI response was empty.";
    chat.messages.push({
      role: "assistant",
      content: assistantResponseText,
      timestamp: new Date(),
      toolCalls: response.toolCalls,
    });
    chat.updatedAt = new Date();
    await chat.save();

    return {
      text: assistantResponseText,
      toolCalls: response.toolCalls,
      usage: response.usage,
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        sessionId,
        userId: userIdForTokenBilling,
        source: "webapp",
      },
      "Error processing webapp message"
    );
    throw error;
  }
};

const endSession = async (sessionId, userIdAuthorizedToEnd) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: "not_found", message: `Session ${sessionId} not found.` };
  }
  if (session.userId.toString() !== userIdAuthorizedToEnd.toString()) {
    const authError = new Error("Unauthorized to end this chat session.");
    authError.status = 403;
    throw authError;
  }

  try {
    await cleanupSession(sessionId);
    const chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId: userIdAuthorizedToEnd,
    });
    if (chat) {
      if (!chat.metadata) chat.metadata = {};
      if (!chat.metadata.isArchived) {
        chat.metadata.isArchived = true;
        chat.updatedAt = new Date();
        await chat.save();
      }
    }
    logger.info(
      `Service: Session '${sessionId}' ended by user '${userIdAuthorizedToEnd}'.`
    );
    return { status: "ended", message: `Session ${sessionId} ended.` };
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: userIdAuthorizedToEnd },
      "Service: Error ending session"
    );
    throw error;
  }
};

const chatService = {
  initializeSession,
  getSession,
  processMessage,
  endSession,
};
export default chatService;
export { initializeSession, getSession, processMessage, endSession };
