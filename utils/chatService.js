// chatService.js
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";

// Global sessions store
const sessions = new Map();

// Helper functions
const getSession = (sessionId) => {
  const session = sessions.get(sessionId);
  return session ? { status: session.status } : { status: "not_found" };
};

const validateSystemPrompt = async (systemPromptName, userId) => {
  const systemPromptDoc = await SystemPrompt.findOne({
    name: systemPromptName,
    userId: userId,
  });

  if (!systemPromptDoc) {
    const promptExists = await SystemPrompt.exists({ name: systemPromptName });
    if (promptExists) {
      logger.warn(
        { userId, systemPromptName },
        "Authorization Failed: User attempted to access system prompt they do not own."
      );
      const authError = new Error(
        `Access denied: You do not have permission for system prompt '${systemPromptName}'.`
      );
      authError.status = 403;
      throw authError;
    } else {
      logger.warn(
        { userId, systemPromptName },
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
      await sessionToClean.aiInstance.closeMcpClients();
    }
    sessions.delete(sessionId);
  }
};

const initializeSession = async (sessionId, systemPromptName, userId) => {
  try {
    const existingSession = sessions.get(sessionId);
    if (existingSession) {
      logger.warn(
        `Service: Session '${sessionId}' already exists. Aborting new initialization.`
      );
      throw new Error(
        `Session '${sessionId}' is already being managed. Please end the current session first.`
      );
    }

    const systemPromptDoc = await validateSystemPrompt(
      systemPromptName,
      userId
    );

    const aiInstance = await initializeAI(systemPromptName);
    const systemPromptText = systemPromptToNaturalLanguage(
      systemPromptDoc.toObject() // Consider handling ObjectIds more gracefully in json2llm if they are part of the text
    );

    Object.assign(aiInstance, {
      systemPromptText,
      validatedSystemName: systemPromptName,
      validatedUserId: userId,
    });

    sessions.set(sessionId, {
      aiInstance,
      status: "active",
      systemPromptName,
      userId,
    });

    logger.info(
      `Service: Chat session initialized for '${sessionId}' with system prompt '${systemPromptName}'`
    );

    return { status: "active" };
  } catch (error) {
    logger.error(
      { err: error, sessionId, systemPromptName },
      `Service: Error in initializeSession`
    );
    await cleanupSession(sessionId);
    throw error;
  }
};

const processMessage = async (sessionId, message, userId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    const notFoundError = new Error(
      "Chat session not found in memory. Please start a new chat."
    );
    notFoundError.status = 404;
    throw notFoundError;
  }

  if (session.status !== "active") {
    const inactiveError = new Error(
      `Chat session is not active (status: ${session.status})`
    );
    inactiveError.status = 400; // Or another appropriate status
    throw inactiveError;
  }

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    logger.warn(
      { sessionId, userId, message },
      "Received empty or invalid message content."
    );
    const invalidInputError = new Error("Message content cannot be empty.");
    invalidInputError.status = 400;
    throw invalidInputError;
  }

  const { aiInstance } = session;
  const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
    aiInstance;

  try {
    // Find chat history. For public chats, userId is prompt.userId.
    // The chat document should have been created by the /start endpoint.
    let chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId, // This is prompt.userId in the public chat flow
    });

    if (!chat) {
      // This indicates an inconsistency, as /start should create this.
      logger.error(
        { sessionId, userId, systemPromptName: session.systemPromptName },
        "CRITICAL: Chat document NOT FOUND in processMessage. This is unexpected if /start was called and succeeded."
      );
      const notFoundDbError = new Error(
        `Chat history not found for session ID ${sessionId}. Please try starting a new chat.`
      );
      notFoundDbError.status = 404;
      throw notFoundDbError;
    }

    // Add current user message to the in-memory chat object's messages array
    const userMessageEntry = {
      role: "user",
      content: message,
      timestamp: new Date(),
    };
    chat.messages.push(userMessageEntry);
    chat.updatedAt = new Date();
    await chat.save();

    const MessagesFromDB = chat.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const messagesForAI = [...MessagesFromDB];

    const response = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      maxSteps: 10,
      system: systemPromptText,
      messages: messagesForAI,
    });

    const assistantResponseText =
      response.text ?? "Error: No text in response from AI."; // Provide a clearer default
    const assistantMessageEntry = {
      role: "assistant",
      content: assistantResponseText,
      timestamp: new Date(),
    };
    chat.messages.push(assistantMessageEntry);

    chat.updatedAt = new Date();
    await chat.save();

    return {
      text: assistantResponseText,
      toolCalls: response.toolCalls,
    };
  } catch (error) {
    // Log the specific aiMessages that caused the error if it's an APICallError
    if (error.name === "AI_APICallError" && error.requestBodyValues) {
      logger.error(
        {
          err: error,
          sessionId,
          userId,
          failedAiMessages: error.requestBodyValues.contents,
        },
        "Error processing message - APICallError details"
      );
    } else {
      logger.error(
        { err: error, sessionId, userId },
        "Error processing message"
      );
    }
    throw error;
  }
};

const endSession = async (sessionId, userId) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: "not_found" };
  }

  if (session.userId !== userId) {
    const authError = new Error("Unauthorized access to chat session");
    authError.status = 403;
    throw authError;
  }

  try {
    await cleanupSession(sessionId);

    const chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId,
    });

    if (chat && chat.metadata && !chat.metadata.isArchived) {
      // Added chat.metadata check
      if (!chat.metadata) chat.metadata = {}; // Ensure metadata exists
      chat.metadata.isArchived = true;
      chat.updatedAt = new Date();
      await chat.save();
    }

    logger.info(`Service: Session '${sessionId}' ended successfully.`);
    return { status: "ended" };
  } catch (error) {
    logger.error({ err: error, sessionId }, "Service: Error ending session");
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
