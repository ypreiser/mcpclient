import mongoose from "mongoose";
import logger from "../utils/logger.js";
import WhatsAppClientManager from "./whatsappClientManager.js";
import WhatsAppEventHandler from "./whatsappEventHandler.js";
import WhatsAppMessageProcessor from "./whatsappMessageProcessor.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";
import { initializeAI as initializeAIService } from "../mcpClient.js"; // Assuming mcpClient exports this

class WhatsAppService {
  constructor() {
    // The main initializeSession function needs to be passed around for reconnect logic
    const boundInitializeSession = this.initializeSession.bind(this);

    this.messageProcessor = new WhatsAppMessageProcessor(initializeAIService); // Or pass AI factory
    this.eventHandler = new WhatsAppEventHandler(
      null,
      this.messageProcessor,
      boundInitializeSession
    ); // sessionsMap will be set later
    this.clientManager = new WhatsAppClientManager(this.eventHandler);
    this.eventHandler.sessions = this.clientManager.sessions; // Link sessions map after clientManager is created
    this.isShuttingDown = false;
  }

  // This is the primary method for creating or retrying a session's client
  async initializeSession(
    connectionName,
    systemPromptName,
    userId, // Expect ObjectId
    isRetry = false
  ) {
    if (this.isShuttingDown) {
      logger.warn(
        `WhatsAppService: Shutdown in progress. Cannot initialize session ${connectionName}.`
      );
      throw new Error("Service is shutting down.");
    }
    const sessionInfoLog = `Conn: '${connectionName}', Prompt: '${systemPromptName}', User: '${userId}'`;
    logger.info(
      `WhatsAppService: Orchestrating session initialization. ${sessionInfoLog}${
        isRetry ? " (Retry)" : ""
      }`
    );

    try {
      // The closeCallback function passed to clientManager
      const closeCallback = async (force = false, fromAuthFail = false) => {
        return this.closeSession(connectionName, force, fromAuthFail);
      };

      await this.clientManager.createAndInitializeClient(
        connectionName,
        systemPromptName,
        userId,
        isRetry,
        closeCallback
      );
      logger.info(
        `WhatsAppService: Session client initialization process initiated for ${connectionName}.`
      );
      // Actual status (connected, qr_ready, etc.) will be set by event handlers
    } catch (error) {
      logger.error(
        { err: error, connectionName },
        `WhatsAppService: Error during session initialization orchestration for ${connectionName}.`
      );
      // Detailed error handling and persistence updates are within ClientManager
      throw error; // Re-throw for the caller (API route or startup reconnect)
    }
  }

  async getQRCode(connectionName) {
    const session = this.clientManager.getSession(connectionName);
    if (!session) {
      logger.warn(
        `WhatsAppService: getQRCode for non-existent in-memory session: '${connectionName}'.`
      );
      const dbConn = await connectionPersistence.getByConnectionName(
        connectionName
      );
      if (dbConn && dbConn.lastKnownStatus === "qr_pending_scan") {
        logger.warn(
          `WhatsAppService: DB indicates ${connectionName} needs QR scan. Re-init may be needed if no live QR available.`
        );
      }
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

  async getStatus(connectionName) {
    const session = this.clientManager.getSession(connectionName);
    if (session && session.status !== "new") return session.status; // 'new' is an internal pre-init state

    const dbConn = await connectionPersistence.getByConnectionName(
      connectionName
    );
    return dbConn ? dbConn.lastKnownStatus || "unknown_db_status" : "not_found";
  }

  async sendMessage(connectionName, to, messageText) {
    const session = this.clientManager.getSession(connectionName);
    if (
      !session ||
      !session.client ||
      !["connected", "authenticated"].includes(session.status)
    ) {
      const currentStatus = session
        ? session.status
        : await this.getStatus(connectionName);
      throw new Error(
        `WhatsApp client for '${connectionName}' is not ready (Status: ${currentStatus}). Cannot send message.`
      );
    }
    logger.info(
      { connectionName, to },
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
    let originalSystemPromptName = session?.systemPromptName;
    let originalUserId = session?.userId;

    if (!session && !calledFromAuthFailure) {
      // If called from auth failure, session might be gone or partial
      const dbConn = await connectionPersistence.getByConnectionName(
        connectionName
      );
      if (dbConn) {
        originalSystemPromptName = dbConn.systemPromptName;
        originalUserId = dbConn.userId;
      } else {
        logger.warn(
          `WhatsAppService: No session or DB record found for ${connectionName} during close.`
        );
        return true; // Nothing to close
      }
    } else if (session) {
      session.isReconnecting = false; // Stop any reconnections
    }

    const finalStatus = await this.clientManager.destroyClient(
      connectionName,
      forceClose,
      calledFromAuthFailure
    );

    if (originalSystemPromptName && originalUserId) {
      await connectionPersistence.saveConnectionDetails(
        connectionName,
        originalSystemPromptName,
        originalUserId,
        finalStatus === "not_found" && calledFromAuthFailure
          ? "auth_failed"
          : finalStatus, // ensure auth_failed is persisted
        false // Disable auto-reconnect
      );
    } else if (connectionName && finalStatus !== "not_found") {
      // Attempt to update DB even if some details are missing, to mark as non-reconnecting
      logger.warn(
        `WhatsAppService: Closing session ${connectionName} with incomplete details. Persisting closure status.`
      );
      const tempSystemPrompt = "N/A_Closed";
      const tempUserId = new mongoose.Types.ObjectId(); // Placeholder, ideally find from DB
      await connectionPersistence.saveConnectionDetails(
        connectionName,
        tempSystemPrompt,
        tempUserId,
        finalStatus,
        false
      );
    }

    this.clientManager.removeSession(connectionName); // Ensure removal from map
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
      // MongoStore instance is managed by ClientManager now, ensure it's ready (implicitly by first client init)
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
        if (
          this.clientManager.getSession(conn.connectionName) &&
          [
            "connected",
            "authenticated",
            "reconnecting",
            "initializing",
            "qr_ready",
          ].includes(this.clientManager.getSession(conn.connectionName).status)
        ) {
          logger.warn(
            `WhatsAppService: Session ${conn.connectionName} already managed. Skipping auto-reconnect.`
          );
          continue;
        }
        logger.info(
          `WhatsAppService: Attempting auto-reconnect for: ${conn.connectionName}`
        );
        try {
          await connectionPersistence.updateLastAttemptedReconnect(
            conn.connectionName
          );
          await this.initializeSession(
            conn.connectionName,
            conn.systemPromptName,
            conn.userId,
            false
          );
        } catch (initError) {
          logger.error(
            { err: initError, connectionName: conn.connectionName },
            `WhatsAppService: Failed to auto-reinitialize ${conn.connectionName} on startup.`
          );
          // Persistence update for init_failed is handled within ClientManager/initializeSession
          // but ensure autoReconnect is correctly set if it's an auth/QR issue.
          const isAuthError =
            initError.message.toLowerCase().includes("auth") ||
            initError.message.toLowerCase().includes("qr");
          if (isAuthError) {
            await connectionPersistence.updateConnectionStatus(
              conn.connectionName,
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
        ) // Attempt graceful close
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
    // Ensure MongoStore is initialized before loading sessions that will use it.
    // The first call to getMongoStore() in ClientManager will handle this.
    // A small delay might still be wise if MongoStore init is slow.
    await new Promise((resolve) => setTimeout(resolve, 500)); // Short delay for safety
    await whatsappServiceInstance.loadAndReconnectPersistedSessions();
  } catch (error) {
    logger.fatal(
      { err: error },
      "Failed to initialize critical WhatsApp services on startup."
    );
  }
});

// Handle process termination signals for graceful shutdown
const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await whatsappServiceInstance.gracefulShutdown();
    process.exit(0);
  });
});

export default whatsappServiceInstance;
