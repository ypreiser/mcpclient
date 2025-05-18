import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js"; // Import SSoT model
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";
import fs from "fs/promises"; // Import fs/promises for async file operations
import path from "path"; // Import path for path manipulation

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
        // Log the error but don't throw, allowing session cleanup to continue
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
    // Attach system prompt text to the AI instance for easy access during message processing
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
    // Attempt to clean up partial session state if initialization fails
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
  // Ensure the user processing the message is the same as the user who owns the session (and prompt)
  if (session.userId.toString() !== userIdForTokenBilling.toString()) {
    logger.error(
      {
        sessionId,
        messageUserId: userIdForTokenBilling,
        sessionUserId: session.userId,
      },
      "CRITICAL: User ID mismatch in processMessage for chatService. Potential security issue."
    );
    const authError = new Error(
      "User ID mismatch for session. Cannot process message."
    );
    authError.status = 403;
    throw authError;
  }
  if (!messageContent?.trim() && (!attachments || attachments.length === 0)) {
    // Allow message with only attachments
    const invalidInputError = new Error(
      "Message content cannot be empty if no attachments are provided."
    );
    invalidInputError.status = 400;
    throw invalidInputError;
  }

  const { aiInstance, systemPromptId, systemPromptName } = session;
  const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
    aiInstance;

  try {
    // Find the chat document linked to this session and the authorized user
    let chat = await Chat.findOne({
      sessionId,
      source: "webapp", // Assuming chat documents created by webapp sessions have source 'webapp'
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

    // Prepare content parts for the AI message, including text and files
    const contentParts = [];

    // Add text content part if messageContent is not empty
    if (messageContent?.trim()) {
      contentParts.push({ type: "text", text: messageContent });
    }

    // Add file content parts if attachments exist
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        try {
          // Validate file path to prevent directory traversal
          const uploadsDir = path.resolve(process.cwd(), "uploads");
          const filePath = path.join(uploadsDir, path.basename(att.url)); // Use path.basename for safety

          // Ensure the resolved path is actually inside the uploads directory
          if (!filePath.startsWith(uploadsDir)) {
            logger.warn(
              { filePath, uploadsDir },
              "Attempted to access file outside uploads directory."
            );
            continue; // Skip this attachment
          }

          // Read file as Buffer
          const fileBuffer = await fs.readFile(filePath);

          // Determine content type (image or file) based on mimeType
          const contentType = att.mimeType.startsWith("image/")
            ? "image"
            : "file";

          if (contentType === "image") {
            contentParts.push({
              type: "image",
              image: fileBuffer, // Pass Buffer directly
              mimeType: att.mimeType,
              // filename is not a standard part of ImagePart in AI SDK docs, omit it.
            });
            logger.info(
              { filename: att.originalName, mimeType: att.mimeType },
              "Image attachment added for AI processing."
            );
          } else {
            contentParts.push({
              type: "file",
              mimeType: att.mimeType,
              data: fileBuffer, // Pass Buffer directly
              filename: att.originalName, // Optional filename
            });
            logger.info(
              { filename: att.originalName, mimeType: att.mimeType },
              "File attachment added for AI processing."
            );
          }
        } catch (err) {
          // Log individual file errors but continue processing other attachments
          logger.error(
            { err, attachment: att },
            "Failed to load or process attachment for AI."
          );
          // Optionally add a text part to the message indicating a file failed to load
          contentParts.push({
            type: "text",
            text: `[Failed to load file: ${att.originalName}]`,
          });
        }
      }
    }

    // If no content parts were successfully prepared, throw an error
    if (contentParts.length === 0) {
      const noContentError = new Error(
        "No valid message content or attachments to process."
      );
      noContentError.status = 400;
      throw noContentError;
    }

    // Save user message (with attachments if any)
    chat.messages.push({
      role: "user",
      content: contentParts, // Store the multi-part content in the chat history
      timestamp: new Date(),
      // Store the original attachment metadata
      attachments:
        Array.isArray(attachments) && attachments.length > 0 ? attachments : [],
      status: "sent",
    });

    // Prepare messages for AI, using the last 20 messages
    // Ensure the content is correctly formatted as per AI SDK (string or array of parts)
    const messagesForAI = chat.messages
      .slice(-20) // Limit context to the last 20 messages
      .map((msg) => ({
        role: msg.role,
        // AI SDK expects content as string or Array<Part>
        content:
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((part) => {
                // Adapt the stored parts structure to AI SDK expected structure
                if (part.type === "text") {
                  return { type: "text", text: part.text };
                } else if (part.type === "image" && part.image) {
                  // Assuming 'part.image' in stored chat history is the buffer or sufficient info to reconstruct
                  // If storing buffer is not feasible, you might need to re-read the file here based on attachment metadata
                  // For this fix, assuming `part.image` if it exists in DB is the Buffer or compatible.
                  // If it's not, a more complex re-loading mechanism based on `attachments` would be needed here.
                  // For simplicity, let's assume the stored `content` array has the necessary data or structure.
                  // A safer approach for re-loading might be necessary in a real application if buffers aren't stored.
                  // For now, let's assume the stored `content` structure for file/image parts aligns with AI SDK input expectations
                  // or can be easily mapped.
                  // If chat.messages content is stored differently, this mapping logic needs adjustment.
                  // Based on the push above, we store the AI SDK format, so retrieving should be ok.
                  return {
                    type: "image",
                    image: part.image,
                    mimeType: part.mimeType,
                  };
                } else if (part.type === "file" && part.data) {
                  // Same assumption as image part regarding stored data
                  return {
                    type: "file",
                    mimeType: part.mimeType,
                    data: part.data,
                    filename: part.filename,
                  };
                }
                // Handle other potential part types or fallback for safety
                return { type: "text", text: "[Unsupported message part]" };
              }),
      }));

    // Call generateText with messages including the new multi-part user message
    // The separate 'files' parameter is removed as files are now in the 'messages' content.
    const response = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      maxSteps: 10,
      system: systemPromptText,
      messages: messagesForAI,
    });

    // Token usage logging (remains largely the same)
    if (response.usage) {
      const { promptTokens, completionTokens } = response.usage;
      // Check for valid numbers before logging
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
        // Ensure logTokenUsage methods handle potential absence of tokens if model didn't return them
        await User.logTokenUsage({
          userId: userIdForTokenBilling,
          promptTokens: promptTokens || 0,
          completionTokens: completionTokens || 0,
        });
        await SystemPrompt.logTokenUsage({
          systemPromptId,
          promptTokens: promptTokens || 0,
          completionTokens: completionTokens || 0,
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
          "Invalid or missing token usage data from AI SDK."
        );
      }
    } else {
      logger.warn(
        { userId: userIdForTokenBilling, source: "webapp" },
        "Token usage data not available from AI SDK response."
      );
    }

    const assistantResponseText = response.text ?? "AI response was empty.";
    chat.messages.push({
      role: "assistant",
      content: assistantResponseText, // Assuming assistant responses are text-only for now
      timestamp: new Date(),
      toolCalls: response.toolCalls, // Keep tool calls if present
    });
    chat.updatedAt = new Date();
    await chat.save();

    // Return the AI response data
    return {
      text: assistantResponseText,
      toolCalls: response.toolCalls, // Include tool calls in the response to the caller
      usage: response.usage, // Include usage data
    };
  } catch (error) {
    logger.error(
      {
        err: error,
        sessionId,
        userId: userIdForTokenBilling,
        source: "webapp",
      },
      `Service: Error processing webapp message: ${error.message}` // Include error message
    );
    // Re-throw the error after logging
    throw error;
  }
};

const endSession = async (sessionId, userIdAuthorizedToEnd) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: "not_found", message: `Session ${sessionId} not found.` };
  }
  // Verify the user attempting to end the session is the owner
  if (session.userId.toString() !== userIdAuthorizedToEnd.toString()) {
    const authError = new Error("Unauthorized to end this chat session.");
    authError.status = 403;
    throw authError;
  }

  try {
    // Perform in-memory session cleanup
    await cleanupSession(sessionId);

    // Find the chat document and archive it
    const chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId: userIdAuthorizedToEnd,
    });

    if (chat) {
      // Ensure metadata object exists before setting properties
      if (!chat.metadata) {
        chat.metadata = {};
      }
      // Archive the chat document if it's not already archived
      if (!chat.metadata.isArchived) {
        chat.metadata.isArchived = true;
        chat.updatedAt = new Date(); // Update timestamp on archive
        await chat.save();
        logger.info(
          `Service: Chat document for session '${sessionId}' archived.`
        );
      } else {
        logger.info(
          `Service: Chat document for session '${sessionId}' was already archived.`
        );
      }
    } else {
      logger.warn(
        `Service: Chat document for session '${sessionId}' not found during endSession.`
      );
    }

    logger.info(
      `Service: Session '${sessionId}' ended by user '${userIdAuthorizedToEnd}'.`
    );
    return { status: "ended", message: `Session ${sessionId} ended.` };
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: userIdAuthorizedToEnd },
      `Service: Error ending session: ${error.message}` // Include error message
    );
    // Re-throw the error after logging
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
