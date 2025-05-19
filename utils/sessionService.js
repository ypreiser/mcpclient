// sessionService.js
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";
import { isUrl, validateSystemPrompt } from "./chatUtils.js";

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

const cleanupSession = async (sessionId) => {
  const sessionToClean = sessions.get(sessionId);
  if (sessionToClean) {
    if (sessionToClean.aiInstance?.closeMcpClients) {
      try {
        await sessionToClean.aiInstance.closeMcpClients();
        logger.info(
          `MCP clients for chat session '${sessionId}' closed successfully.`
        );
      } catch (err) {
        logger.error(
          { err, sessionId },
          "Error closing MCP clients during chat session cleanup."
        );
      }
    }
    sessions.delete(sessionId);
    logger.info(`In-memory chat session '${sessionId}' cleaned up.`);
  }
};

const initializeSession = async (
  sessionId,
  systemPromptName,
  userIdForTokenBilling
) => {
  if (!userIdForTokenBilling) {
    logger.error(
      { sessionId, systemPromptName },
      "Critical: userIdForTokenBilling is undefined in initializeSession. Cannot bill tokens."
    );
    const err = new Error(
      "User ID for token billing is required to initialize chat session."
    );
    err.status = 400;
    throw err;
  }

  if (sessions.has(sessionId)) {
    logger.warn(
      `ChatService: Session '${sessionId}' already exists. Aborting new initialization.`
    );
    const err = new Error(`Session '${sessionId}' is already active.`);
    err.status = 409;
    throw err;
  }

  try {
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
      userId: userIdForTokenBilling,
      systemPromptId: systemPromptDoc._id,
    });

    logger.info(
      `ChatService: Session initialized for '${sessionId}' with prompt '${systemPromptName}'. Tokens billed to user '${userIdForTokenBilling}'.`
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
      "ChatService: Error during session initialization."
    );
    await cleanupSession(sessionId);
    throw error;
  }
};

const endSession = async (sessionId, userIdAuthorizedToEnd) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: "not_found", message: `Session ${sessionId} not found.` };
  }
  if (session.userId.toString() !== userIdAuthorizedToEnd.toString()) {
    const err = new Error("Unauthorized to end this chat session.");
    err.status = 403;
    throw err;
  }

  try {
    await cleanupSession(sessionId);

    const chat = await Chat.findOneAndUpdate(
      {
        sessionId,
        source: "webapp",
        userId: userIdAuthorizedToEnd,
        "metadata.isArchived": false,
      },
      {
        $set: { "metadata.isArchived": true, updatedAt: new Date() },
      },
      { new: true }
    );

    if (chat) {
      logger.info(
        `ChatService: Chat document for session '${sessionId}' archived.`
      );
    } else {
      logger.warn(
        `ChatService: Chat document for session '${sessionId}' not found for archiving or already archived.`
      );
    }

    logger.info(
      `ChatService: Session '${sessionId}' ended by user '${userIdAuthorizedToEnd}'.`
    );
    return { status: "ended", message: `Session ${sessionId} ended.` };
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: userIdAuthorizedToEnd },
      `ChatService: Error ending session: ${error.message}`
    );
    const serviceError = new Error(
      "An internal error occurred while ending the session."
    );
    serviceError.status = 500;
    throw serviceError;
  }
};

export { initializeSession, getSession, endSession, cleanupSession, sessions };
