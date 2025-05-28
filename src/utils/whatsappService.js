// src\utils\whatsappService.js
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import WhatsAppClientManager from "./whatsappClientManager.js";
import WhatsAppEventHandler from "./whatsappEventHandler.js";
import WhatsAppMessageProcessor from "./whatsappMessageProcessor.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";
import { initializeAI as initializeAIService } from "../mcpClient.js";
// BotProfile and WhatsAppConnection models are used by persistence layer, not directly here typically
// import BotProfile from "../models/botProfileModel.js";
import WhatsAppConnection from "../models/whatsAppConnectionModel.js";

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
    if (this.isShuttingDown) {
      logger.warn(
        `WhatsAppService: Shutdown in progress. Cannot initialize session ${connectionName}.`
      );
      throw new Error("Service is shutting down.");
    }
    logger.info(
      `WhatsAppService: Orchestrating session initialization for Conn: '${connectionName}', ProfileId: '${botProfileId}', User: '${userId}'${
        isRetry ? " (Retry)" : ""
      }`
    );

    try {
      // Define closeCallback here so it's in scope
      const closeCallback = async (force = false, fromAuthFail = false) => {
        // This `this` will correctly refer to the WhatsAppService instance
        // because initializeSession is an async method of the class.
        // If it were a standalone function, `this` would be different.
        return this.closeSession(connectionName, force, fromAuthFail);
      };

      await this.clientManager.createAndInitializeClient(
        connectionName,
        botProfileId,
        userId,
        isRetry,
        closeCallback // Now correctly passing the defined function
      );
      logger.info(
        `WhatsAppService: Session client initialization process initiated for ${connectionName}.`
      );
      // Status will be updated by event handlers.
    } catch (error) {
      logger.error(
        { err: error, connectionName, botProfileId, userId },
        `WhatsAppService: Error during session initialization orchestration for ${connectionName}.`
      );
      // The clientManager and persistence layers should handle detailed error state updates.
      throw error; // Re-throw for the caller (e.g., API route)
    }
  }

  async getQRCode(connectionName) {
    const session = this.clientManager.getSession(connectionName);
    if (!session) {
      logger.warn(
        `WhatsAppService: getQRCode for non-existent in-memory session: '${connectionName}'.`
      );
      return null;
    }
    if (session.status !== "qr_ready" || !session.qr) {
      logger.warn(
        `WhatsAppService: QR code not ready/invalid for '${connectionName}'. Status: ${session.status}.`
      );
      return null;
    }
    return session.qr;
  }

  async getStatus(connectionName, userId) {
    const session = this.clientManager.getSession(connectionName);
    if (
      session &&
      session.userId &&
      session.userId.toString() === userId.toString() &&
      session.status !== "new"
    ) {
      return session.status;
    }
    if (!userId) {
      logger.warn(
        `WhatsAppService: getStatus called for ${connectionName} without userId for DB lookup.`
      );
      // Check if a public session by this name exists if no userId (less common for WA)
      const publicSession = this.clientManager.getSession(connectionName);
      if (publicSession && !publicSession.userId) return publicSession.status; // E.g. a global, non-user-specific bot
      return "not_found";
    }
    const dbConn = await connectionPersistence.getByConnectionName(
      connectionName,
      userId
    );
    return dbConn ? dbConn.lastKnownStatus || "unknown_db_status" : "not_found";
  }

  async sendMessage(connectionName, userId, to, messageText) {
    const session = this.clientManager.getSession(connectionName);
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
    logger.info(
      { connectionName, to, userId },
      `WhatsAppService: Sending message via '${connectionName}'.`
    );
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(
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

    if (!session && !calledFromAuthFailure) {
      if (originalUserId) {
        const dbConn = await connectionPersistence.getByConnectionName(
          connectionName,
          originalUserId
        );
        if (dbConn) {
          originalBotProfileId = dbConn.botProfileId;
        } else {
          logger.warn(
            `WhatsAppService: No DB record found for ${connectionName} for user ${originalUserId} during close.`
          );
        }
      } else {
        // If calledFromAuthFailure, session might be partially set up or gone.
        // If not auth failure and no session AND no originalUserId context, it's hard to know which DB record to update.
        // We might need to find the connection by name if it's truly a global admin action without user context.
        // For now, this implies that if session doesn't exist AND it's not an auth failure, we need a userId context.
        // The route calling closeSession should provide this if it's a user action.
        logger.warn(
          `WhatsAppService: Cannot reliably fetch DB details for ${connectionName} to close without userId context or active session.`
        );
        // If we *must* close a connection by name without knowing the user (admin action),
        // we'd need a different DB query. For now, assuming user context or session exists.
      }
    } else if (session) {
      session.isReconnecting = false;
      originalUserId = session.userId;
      originalBotProfileId = session.botProfileId;
    }

    const finalStatus = await this.clientManager.destroyClient(
      connectionName,
      forceClose,
      calledFromAuthFailure
    );

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
      logger.warn(
        `WhatsAppService: Closing session ${connectionName} for user ${originalUserId} with possibly incomplete botProfileId. Persisting closure status.`
      );
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        originalUserId, // Pass userId here
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
    if (this.isShuttingDown) return;
    logger.info(
      "WhatsAppService: Loading and attempting to reconnect persisted sessions..."
    );
    try {
      const connectionsToReconnect =
        await connectionPersistence.getConnectionsToReconnect();
      if (connectionsToReconnect.length === 0) {
        logger.info(
          "WhatsAppService: No persisted sessions for auto-reconnection."
        );
        return;
      }
      logger.info(
        `WhatsAppService: Found ${connectionsToReconnect.length} sessions to attempt reconnection.`
      );

      for (const conn of connectionsToReconnect) {
        if (!conn.userId || !conn.botProfileId) {
          logger.error(
            { connectionName: conn.connectionName },
            "WhatsAppService: Persisted connection missing critical userId or botProfileId. Cannot reconnect."
          );
          continue;
        }

        const existingSession = this.clientManager.getSession(
          conn.connectionName
        );
        if (
          existingSession &&
          existingSession.userId &&
          existingSession.userId.toString() === conn.userId.toString() &&
          [
            "connected",
            "authenticated",
            "reconnecting",
            "initializing",
            "qr_ready",
          ].includes(existingSession.status)
        ) {
          logger.warn(
            `WhatsAppService: Session ${conn.connectionName} (User: ${conn.userId}) already managed. Skipping auto-reconnect.`
          );
          continue;
        }
        logger.info(
          `WhatsAppService: Attempting auto-reconnect for: ${conn.connectionName} with BotProfileID: ${conn.botProfileId} for UserID: ${conn.userId}`
        );
        try {
          await connectionPersistence.updateLastAttemptedReconnect(
            conn.connectionName,
            conn.userId
          );
          await this.initializeSession(
            conn.connectionName,
            conn.botProfileId,
            conn.userId,
            true
          ); // isRetry = true for startup reconnects
        } catch (initError) {
          logger.error(
            {
              err: initError,
              connectionName: conn.connectionName,
              userId: conn.userId,
            },
            `WhatsAppService: Failed to auto-reinitialize ${conn.connectionName} on startup.`
          );
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

  async gracefulShutdown() {
    this.isShuttingDown = true;
    logger.info("WhatsAppService: Starting graceful shutdown...");
    const activeSessions = Array.from(this.clientManager.sessions.keys());
    if (activeSessions.length > 0) {
      logger.info(
        `WhatsAppService: Closing ${activeSessions.length} active session(s)...`
      );
      await Promise.all(
        activeSessions.map((connectionName) =>
          this.closeSession(connectionName, false)
        )
      );
    }
    logger.info("WhatsAppService: Graceful shutdown completed.");
  }
}

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
