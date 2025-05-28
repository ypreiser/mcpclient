// src\utils\sessionService.js
import { initializeAI } from "../mcpClient.js";
import BotProfile from "../models/botProfileModel.js";
import Chat from "../models/chatModel.js"; // Not directly used in this file, but often related
// import User from "../models/userModel.js"; // Not directly used
// import TokenUsageRecord from "../models/tokenUsageRecordModel.js"; // Not directly used
// import { botProfileToNaturalLanguage } from "../utils/json2llm.js"; // No longer needed here
import logger from "../utils/logger.js";
// import { isUrl, validateBotProfile } from "./chatUtils.js"; // Not directly used here

const sessions = new Map(); // In-memory session store

const getSession = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return { status: "not_found" };
  // Return only necessary, non-sensitive info if this is for client status checks
  return {
    status: session.status,
    botProfileName: session.botProfileName, // Name for display
    userId: session.userId, // Owner ID for context
    // Do not return aiInstance or sensitive parts of it
  };
};

const cleanupSession = async (sessionId) => {
  const sessionToClean = sessions.get(sessionId);
  if (sessionToClean) {
    if (sessionToClean.aiInstance?.closeMcpClients) {
      // aiInstance might be null if init failed early
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
  botProfileId, // This is the ObjectId
  userIdForTokenBilling // This is the BotProfile owner's ObjectId
) => {
  if (!userIdForTokenBilling) {
    logger.error(
      { sessionId, botProfileId },
      "Critical: userIdForTokenBilling is undefined in initializeSession."
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
    err.status = 409; // Conflict
    throw err;
  }

  try {
    // Fetch the bot profile to get its name and verify ownership & enabled status
    // This is important even though initializeAI also fetches it,
    // as sessionService needs the name and to confirm billing user owns it.
    const botProfileDoc = await BotProfile.findOne({
      _id: botProfileId,
      userId: userIdForTokenBilling, // Ensure the billing user actually owns this profile
      // isEnabled: true, // initializeAI will also effectively check this by trying to use it
    }).lean(); // Use .lean()

    if (!botProfileDoc) {
      // Check if profile exists at all, or if it exists but doesn't match userId, or is not enabled
      const profileExistsAnyUser = await BotProfile.findById(botProfileId)
        .select("_id userId isEnabled")
        .lean();
      let errorMsg;
      if (!profileExistsAnyUser) {
        errorMsg = `Bot profile with ID '${botProfileId}' not found.`;
      } else if (
        profileExistsAnyUser.userId.toString() !==
        userIdForTokenBilling.toString()
      ) {
        errorMsg = `Access denied: You do not own bot profile with ID '${botProfileId}'.`;
      } else if (!profileExistsAnyUser.isEnabled) {
        errorMsg = `Bot profile '${
          profileExistsAnyUser.name || botProfileId
        }' is currently disabled.`;
      } else {
        errorMsg = `Bot profile '${botProfileId}' could not be loaded for an unknown reason.`;
      }
      logger.warn(
        { userIdExpectedOwner: userIdForTokenBilling, botProfileId },
        `Bot profile validation failed in sessionService: ${errorMsg}`
      );
      const err = new Error(errorMsg);
      err.status = 404; // Or 403 for access denied
      throw err;
    }

    if (!botProfileDoc.isEnabled) {
      // Explicit check here too
      logger.warn(
        { botProfileId, name: botProfileDoc.name },
        `Attempt to initialize session with disabled bot profile.`
      );
      const err = new Error(
        `Bot profile '${botProfileDoc.name}' is currently disabled.`
      );
      err.status = 403; // Forbidden
      throw err;
    }

    const aiInstance = await initializeAI(botProfileDoc._id); // Pass the ObjectId

    sessions.set(sessionId, {
      aiInstance,
      status: "active",
      botProfileId: botProfileDoc._id,
      botProfileName: botProfileDoc.name,
      userId: userIdForTokenBilling,
    });

    logger.info(
      `ChatService: Session initialized for '${sessionId}' with profile id '${botProfileDoc._id}' (name: ${botProfileDoc.name}). Tokens billed to user '${userIdForTokenBilling}'.`
    );
    return {
      status: "active",
      sessionId,
      botProfileId: botProfileDoc._id,
      botProfileName: botProfileDoc.name,
    };
  } catch (error) {
    logger.error(
      { err: error, sessionId, botProfileId, userId: userIdForTokenBilling },
      "ChatService: Error during session initialization."
    );
    await cleanupSession(sessionId); // Ensure cleanup if init fails
    throw error; // Re-throw to caller
  }
};

const endSession = async (sessionId, userIdAuthorizedToEnd) => {
  const session = sessions.get(sessionId);
  if (!session) {
    return { status: "not_found", message: `Session ${sessionId} not found.` };
  }
  // Ensure the user ending the session is the one who owns the bot profile (and thus the session)
  if (session.userId.toString() !== userIdAuthorizedToEnd.toString()) {
    logger.warn(
      {
        sessionId,
        sessionOwner: session.userId,
        attemptingUser: userIdAuthorizedToEnd,
      },
      "Unauthorized attempt to end chat session."
    );
    const err = new Error("Unauthorized to end this chat session.");
    err.status = 403; // Forbidden
    throw err;
  }

  try {
    await cleanupSession(sessionId);

    // Archive the chat document in the database
    const chat = await Chat.findOneAndUpdate(
      {
        sessionId,
        source: "webapp", // Assuming webapp for now, source might need to be more dynamic
        userId: userIdAuthorizedToEnd, // Ensure user owns the chat record
        "metadata.isArchived": false, // Only archive if not already archived
      },
      { $set: { "metadata.isArchived": true, updatedAt: new Date() } },
      { new: true } // Return the updated document
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
