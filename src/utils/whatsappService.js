// src\utils\whatsappService.js
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import WhatsAppClientManager from "./whatsappClientManager.js";
import WhatsAppEventHandler from "./whatsappEventHandler.js";
import WhatsAppMessageProcessor from "./whatsappMessageProcessor.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";
import { initializeAI as initializeAIService } from "../mcpClient.js";
import BotProfile from "../models/botProfileModel.js"; // For fetching botProfileName if needed
import WhatsAppConnection from "../models/whatsAppConnectionModel.js"; // For fetching connection if details missing

class WhatsAppService {
  constructor() {
    const boundInitializeSession = this.initializeSession.bind(this);
    this.messageProcessor = new WhatsAppMessageProcessor(initializeAIService);
    this.eventHandler = new WhatsAppEventHandler(
      null,
      this.messageProcessor,
      boundInitializeSession
    );
    this.clientManager = new WhatsAppClientManager(this.eventHandler);
    this.eventHandler.sessions = this.clientManager.sessions;
    this.isShuttingDown = false;
  }

  async initializeSession(
    connectionName,
    botProfileId,
    userId,
    isRetry = false
  ) {
    // ... (initial checks remain the same) ...
    logger.info(
      `WhatsAppService: Orchestrating session initialization for Conn: '${connectionName}', ProfileId: '${botProfileId}', User: '${userId}'${
        isRetry ? " (Retry)" : ""
      }`
    );

    try {
      // ... (closeCallback definition) ...
      await this.clientManager.createAndInitializeClient(
        connectionName,
        botProfileId,
        userId,
        isRetry,
        closeCallback
      );
      // ...
    } catch (error) {
      // ... (error logging) ...
      throw error;
    }
  }

  async getQRCode(connectionName) {
    const session = this.clientManager.getSession(connectionName);
    if (!session) {
      logger.warn(
        `WhatsAppService: getQRCode for non-existent in-memory session: '${connectionName}'.`
      );
      // If no in-memory session, there's no live QR code.
      // Checking DB for 'qr_pending_scan' is informative but doesn't yield a QR.
      // const dbConn = await connectionPersistence.getByConnectionName(connectionName, SOME_USER_ID_IF_KNOWN_CONTEXT);
      // This needs userId if getByConnectionName is strictly scoped.
      // For QR, it's usually for a connection that *is* being actively set up by a user.
      return null;
    }
    // ... (rest of QR logic remains same) ...
    if (session.status !== "qr_ready" || !session.qr) {
      logger.warn(
        `WhatsAppService: QR code not ready/invalid for '${connectionName}'. Status: ${session.status}.`
      );
      return null;
    }
    return session.qr;
  }

  async getStatus(connectionName, userId) {
    // ADDED userId for DB lookup if session not in memory
    const session = this.clientManager.getSession(connectionName);
    // Check if the in-memory session belongs to the requesting user
    if (
      session &&
      session.userId &&
      session.userId.toString() === userId.toString() &&
      session.status !== "new"
    ) {
      return session.status;
    }
    // If no in-memory session for this user, or it's 'new', check DB
    if (!userId) {
      // Should not happen if called from an authenticated route
      logger.warn(
        `WhatsAppService: getStatus called for ${connectionName} without userId for DB lookup.`
      );
      return "not_found"; // Or some other appropriate status
    }
    const dbConn = await connectionPersistence.getByConnectionName(
      connectionName,
      userId
    );
    return dbConn ? dbConn.lastKnownStatus || "unknown_db_status" : "not_found";
  }

  async sendMessage(connectionName, userId, to, messageText) {
    // ADDED userId
    const session = this.clientManager.getSession(connectionName);
    // Crucially, verify that the session belongs to the user attempting to send the message
    if (
      !session ||
      !session.client ||
      session.userId?.toString() !== userId.toString() ||
      !["connected", "authenticated"].includes(session.status)
    ) {
      const currentStatus = session
        ? session.status
        : await this.getStatus(connectionName, userId);
      logger.warn(
        { connectionName, userId, to, currentStatus },
        `WhatsAppService: Attempt to send message but client not ready or ownership mismatch.`
      );
      throw new Error(
        `WhatsApp client for '${connectionName}' is not ready for your account (Status: ${currentStatus}). Cannot send message.`
      );
    }
    // ... (rest of sendMessage logic) ...
    logger.info(
      { connectionName, to, userId },
      `WhatsAppService: Sending message via '${connectionName}'.`
    );
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(
    userId,
    connectionName,
    forceClose = false,
    calledFromAuthFailure = false
  ) {
    logger.info(
      `WhatsAppService: Attempting to close session: '${connectionName}'. Force: ${forceClose}, AuthFailure: ${calledFromAuthFailure}`
    );
    const session = this.clientManager.getSession(connectionName);

    let originalBotProfileId = session?.botProfileId;
    let originalUserId = session?.userId;
    if (userId != originalUserId) {
      logger.warn(
        `WhatsAppService: User ID mismatch for session '${connectionName}'. Expected: ${originalUserId}, Provided: ${userId}.`
      );
      return false; // User ID mismatch, cannot proceed
    }

    if (!session && !calledFromAuthFailure) {
      // If we need to fetch from DB, we MUST have a userId context for getByConnectionName
      // This part is tricky if closeSession is called without a specific user context (e.g., admin action).
      // For user-initiated close, req.user._id would be the userId.
      // Let's assume for now this method is called in a context where `originalUserId` can be determined
      // or the operation is more about the connection name itself regardless of user if it's a cleanup.
      // This implies `getByConnectionName` might need to be less strict or we need different close strategies.
      // For now, if we can't get originalUserId here, persistence might be partial.
      if (originalUserId) {
        // Only query DB if we know which user's connection to look for
        const dbConn = await connectionPersistence.getByConnectionName(
          connectionName,
          originalUserId
        );
        if (dbConn) {
          originalBotProfileId = dbConn.botProfileId;
          // originalUserId is already set
        } else {
          logger.warn(
            `WhatsAppService: No DB record found for ${connectionName} for user ${originalUserId} during close.`
          );
          // If no session and no DB record, effectively nothing to close from persistence.
        }
      } else if (!calledFromAuthFailure) {
        logger.warn(
          `WhatsAppService: Cannot reliably fetch DB details for ${connectionName} to close without userId context.`
        );
      }
    } else if (session) {
      session.isReconnecting = false;
      originalUserId = session.userId; // Ensure originalUserId is from the live session if it exists
      originalBotProfileId = session.botProfileId;
    }

    const finalStatus = await this.clientManager.destroyClient(
      connectionName,
      forceClose,
      calledFromAuthFailure
    );

    // Only attempt to save connection details if we have the necessary IDs
    if (originalBotProfileId && originalUserId) {
      await connectionPersistence.saveConnectionDetails(
        connectionName,
        originalBotProfileId,
        originalUserId,
        finalStatus === "not_found" && calledFromAuthFailure
          ? "auth_failed"
          : finalStatus,
        false
      );
    } else if (
      connectionName &&
      finalStatus !== "not_found" &&
      originalUserId
    ) {
      // If we have userId, we can at least update status
      logger.warn(
        `WhatsAppService: Closing session ${connectionName} for user ${originalUserId} with possibly incomplete botProfileId. Persisting closure status.`
      );
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        originalUserId,
        finalStatus === "not_found" && calledFromAuthFailure
          ? "auth_failed"
          : finalStatus,
        false // autoReconnect false
      );
    } else {
      logger.warn(
        `WhatsAppService: Could not persist final closure status for ${connectionName} due to missing userId or botProfileId.`
      );
    }

    this.clientManager.removeSession(connectionName);
    logger.info(
      `WhatsAppService: Session '${connectionName}' fully processed for closure. Final status: ${finalStatus}`
    );
    return true;
  }

  async loadAndReconnectPersistedSessions() {
    // ... (initial log) ...
    try {
      const connectionsToReconnect =
        await connectionPersistence.getConnectionsToReconnect();
      // ... (check length) ...
      for (const conn of connectionsToReconnect) {
        // conn already includes botProfileId and userId from the modified getConnectionsToReconnect
        if (!conn.userId || !conn.botProfileId) {
          logger.error(
            { connection: conn },
            "WhatsAppService: Persisted connection missing critical userId or botProfileId. Cannot reconnect."
          );
          continue;
        }
        // ... (skip if already managed logic) ...
        logger.info(
          `WhatsAppService: Attempting auto-reconnect for: ${conn.connectionName} with BotProfileID: ${conn.botProfileId} for UserID: ${conn.userId}`
        );
        try {
          // Pass userId to updateLastAttemptedReconnect
          await connectionPersistence.updateLastAttemptedReconnect(
            conn.connectionName,
            conn.userId
          );
          await this.initializeSession(
            conn.connectionName,
            conn.botProfileId,
            conn.userId,
            false
          );
        } catch (initError) {
          // ... (error logging, ensure updateConnectionStatus also gets userId) ...
          const isAuthError =
            initError.message.toLowerCase().includes("auth") ||
            initError.message.toLowerCase().includes("qr") ||
            initError.message.toLowerCase().includes("access denied") ||
            initError.message.toLowerCase().includes("not found");
          if (isAuthError) {
            await connectionPersistence.updateConnectionStatus(
              conn.connectionName,
              conn.userId,
              `reconnect_failed_startup: ${initError.message.substring(0, 50)}`,
              false
            );
          }
        }
      }
    } catch (error) {
      logger.error(
        { err: error },
        "WhatsAppService: Critical error during persisted session loading."
      );
    }
  }

  // ... (gracefulShutdown remains the same) ...
}

// ... (instance creation and export remain the same) ...
const whatsappServiceInstance = new WhatsAppService();

setImmediate(async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      logger.warn(
        "MongoDB connection not yet ready. Waiting briefly before loading WhatsApp sessions..."
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (mongoose.connection.readyState !== 1) {
        logger.error(
          "MongoDB connection still not ready. WhatsApp auto-reconnect may encounter issues."
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await whatsappServiceInstance.loadAndReconnectPersistedSessions();
  } catch (error) {
    logger.fatal(
      { err: error },
      "Failed to initialize critical WhatsApp services on startup."
    );
  }
});

global.whatsappServiceInstance = whatsappServiceInstance;
export default whatsappServiceInstance;
