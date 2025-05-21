//mcpclient/utils/whatsappClientManager.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";
import connectionPersistence from "./whatsappConnectionPersistence.js"; // For initial persistence

const { Client, RemoteAuth } = pkg;

const PUPPETEER_AUTH_PATH = process.env.PUPPETEER_AUTH_PATH || "./.wwebjs_auth";
const PUPPETEER_CACHE_PATH =
  process.env.PUPPETEER_CACHE_PATH || "./.wwebjs_cache";

let mongoStoreInstance;
let mongoStoreInitializationPromise = null;

/**
 * Asynchronously gets or initializes the MongoStore instance.
 * Ensures that MongoStore is initialized only after a successful Mongoose connection.
 * @returns {Promise<MongoStore>} A promise that resolves with the MongoStore instance.
 */
const getMongoStore = async () => {
  if (mongoStoreInstance) {
    return mongoStoreInstance;
  }

  if (mongoStoreInitializationPromise) {
    return mongoStoreInitializationPromise;
  }

  mongoStoreInitializationPromise = new Promise((resolve, reject) => {
    const checkConnection = () => {
      if (mongoose.connection.readyState === 1) {
        // 1 === connected
        logger.info(
          "ClientManager: MongoDB connection is active. Initializing MongoStore."
        );
        try {
          mongoStoreInstance = new MongoStore({ mongoose: mongoose });
          logger.info(
            "ClientManager: MongoStore for WhatsApp initialized successfully."
          );
          resolve(mongoStoreInstance);
        } catch (error) {
          logger.error(
            { err: error },
            "ClientManager: Failed to initialize MongoStore."
          );
          reject(error);
        }
      } else {
        logger.warn(
          "ClientManager: MongoDB connection not yet ready for MongoStore. Waiting..."
        );
        // Listen for 'connected' or 'error' events to avoid an infinite loop or long hangs
        const timeoutId = setTimeout(() => {
          mongoose.connection.off("connected", connectedListener);
          mongoose.connection.off("error", errorListener);
          logger.error(
            "ClientManager: Timeout waiting for MongoDB connection for MongoStore."
          );
          reject(
            new Error("Timeout waiting for MongoDB connection for MongoStore.")
          );
        }, 30000); // 30-second timeout

        const connectedListener = () => {
          clearTimeout(timeoutId);
          mongoose.connection.off("error", errorListener); // Clean up error listener
          logger.info(
            "ClientManager: MongoDB connected event received. Retrying MongoStore initialization."
          );
          checkConnection(); // Retry initialization
        };
        const errorListener = (err) => {
          clearTimeout(timeoutId);
          mongoose.connection.off("connected", connectedListener); // Clean up connected listener
          logger.error(
            { err },
            "ClientManager: MongoDB connection error while waiting for MongoStore initialization."
          );
          reject(err);
        };
        mongoose.connection.once("connected", connectedListener);
        mongoose.connection.once("error", errorListener);
      }
    };
    checkConnection();
  });
  return mongoStoreInitializationPromise;
};

class WhatsAppClientManager {
  constructor(eventHandler) {
    this.sessions = new Map(); // connectionName -> { client, status, qr, systemPromptName, ... }
    this.eventHandler = eventHandler; // Instance of WhatsAppEventHandler
  }

  getSession(connectionName) {
    return this.sessions.get(connectionName);
  }

  getOrCreateSessionEntry(connectionName, defaults = {}) {
    if (!this.sessions.has(connectionName)) {
      this.sessions.set(connectionName, {
        client: null,
        status: "new",
        qr: null,
        systemPromptName: null,
        systemPromptId: null,
        aiInstance: null,
        userId: null,
        isReconnecting: false,
        reconnectAttempts: 0,
        ...defaults,
      });
    }
    return this.sessions.get(connectionName);
  }

  async createAndInitializeClient(
    connectionName,
    systemPromptId, // Now expects ObjectId
    userId, // Should be ObjectId
    isRetry = false,
    closeCallback // Function to call full session closure
  ) {
    logger.info(
      `ClientManager: Initializing client for Conn: '${connectionName}', PromptId: '${systemPromptId}', User: '${userId}'${
        isRetry ? " (Retry)" : ""
      }`
    );

    const sessionEntry = this.getOrCreateSessionEntry(connectionName, {
      systemPromptId,
      userId,
      closeCallback,
    });

    if (
      sessionEntry.client &&
      !isRetry &&
      [
        "initializing",
        "connected",
        "authenticated",
        "reconnecting",
        "qr_ready",
      ].includes(sessionEntry.status)
    ) {
      logger.warn(
        `ClientManager: Session '${connectionName}' client already exists or is being managed (Status: ${sessionEntry.status}).`
      );
      throw new Error(
        `Session '${connectionName}' is already active or being initialized.`
      );
    }
    if (sessionEntry.isReconnecting && !isRetry) {
      logger.warn(
        `ClientManager: Session '${connectionName}' is in reconnection process. Aborting new manual init.`
      );
      throw new Error(
        `Session '${connectionName}' is currently attempting to reconnect.`
      );
    }

    try {
      // Always lookup by _id and userId
      const systemPromptDoc = await SystemPrompt.findOne({
        _id: systemPromptId,
        userId,
      });
      if (!systemPromptDoc) {
        // Check if prompt exists for any user (by _id)
        const promptExists = await SystemPrompt.exists({ _id: systemPromptId });
        const errorMsg = promptExists
          ? `Access denied: You do not own system prompt with id '${systemPromptId}'.`
          : `System prompt with id "${systemPromptId}" not found.`;
        logger.error(`ClientManager: ${errorMsg} for user ${userId}`);
        throw new Error(errorMsg);
      }

      const aiInstance = await initializeAI(systemPromptId);
      aiInstance.systemPromptText = systemPromptToNaturalLanguage(
        systemPromptDoc.toObject()
      );

      // Crucially wait for MongoStore to be ready
      logger.info(
        `ClientManager: Attempting to get MongoStore for session ${connectionName}.`
      );
      const store = await getMongoStore();
      logger.info(
        `ClientManager: MongoStore obtained for session ${connectionName}. Proceeding with client creation.`
      );

      const client = new Client({
        clientId: connectionName, // This is critical for RemoteAuth to identify the session
        authStrategy: new RemoteAuth({
          store: store,
          clientId: connectionName,
          backupSyncIntervalMs: 300000, // e.g., 5 minutes, for syncing session state
          dataPath: `${PUPPETEER_AUTH_PATH}/session-${connectionName}`,
        }),
        puppeteer: {
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--single-process",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
          ],
        },
        webVersion: "2.2409.2", // Pin version for stability
        webVersionCache: {
          type: "local",
          path: PUPPETEER_CACHE_PATH, // Local cache for WhatsApp Web version
        },
      });

      sessionEntry.client = client;
      sessionEntry.status = "initializing";
      sessionEntry.systemPromptId = systemPromptDoc._id;
      sessionEntry.aiInstance = aiInstance;
      sessionEntry.userId = userId;
      sessionEntry.isReconnecting = isRetry;
      sessionEntry.reconnectAttempts = isRetry
        ? (sessionEntry.reconnectAttempts || 0) +
          (sessionEntry.status !== "reconnecting" ? 1 : 0)
        : 0;
      sessionEntry.closeCallback = closeCallback;

      if (!isRetry) {
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          systemPromptId, // Save the id
          userId,
          "initializing",
          true
        );
      }

      this.eventHandler.registerEventHandlers(client, connectionName);

      logger.info(
        `ClientManager: Starting WhatsApp client.initialize() for '${connectionName}'...`
      );
      await client.initialize(); // This can take time and is where RemoteAuth tries to load the session
      logger.info(
        `ClientManager: client.initialize() completed for '${connectionName}'. Status updates via events.`
      );

      // Extract phone number after successful initialization
      let phoneNumber = null;
      if (client.info && client.info.wid && client.info.wid.user) {
        phoneNumber = client.info.wid.user;
        logger.info(
          `ClientManager: Phone number for ${connectionName} is ${phoneNumber}`
        );
        // Persist phone number in DB
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          systemPromptId,
          userId,
          "connected",
          true,
          new Date(),
          phoneNumber
        );
      }

      if (isRetry) {
        logger.info(
          `ClientManager: client.initialize() succeeded for retry of ${connectionName}.`
        );
      }

      return client;
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId, isRetry },
        `ClientManager: Error in createAndInitializeClient for '${connectionName}'`
      );
      sessionEntry.status = "init_failed";
      if (!isRetry || !sessionEntry.isReconnecting) {
        await this.cleanupClientResources(
          connectionName,
          error.message.includes("Timeout")
        );
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          systemPromptId,
          userId,
          `init_failed: ${error.message.substring(0, 50)}`,
          false
        );
      } else if (isRetry && sessionEntry.isReconnecting) {
        logger.warn(
          `ClientManager: Initialize failed during reconnect for ${connectionName}. Attempt ${sessionEntry.reconnectAttempts}. EventHandler manages further retries.`
        );
      }
      throw error;
    }
  }

  async cleanupClientResources(connectionName, isPuppeteerTimeout = false) {
    const session = this.sessions.get(connectionName);
    if (session) {
      if (session.client) {
        if (isPuppeteerTimeout) {
          logger.warn(
            `ClientManager: Puppeteer timeout for ${connectionName}, client.destroy() skipped.`
          );
        } else {
          try {
            await session.client.destroy();
            logger.info(
              `ClientManager: Client for '${connectionName}' destroyed.`
            );
          } catch (destroyError) {
            logger.error(
              { err: destroyError, connectionName },
              `ClientManager: Error destroying client.`
            );
          }
        }
        session.client = null;
      }
      if (session.aiInstance?.closeMcpClients) {
        try {
          await session.aiInstance.closeMcpClients();
          logger.info(
            `ClientManager: MCP Clients closed for ${connectionName}.`
          );
        } catch (e) {
          logger.error(
            { err: e, connectionName },
            "ClientManager: Error closing MCP clients."
          );
        }
      }
      logger.info(
        `ClientManager: Client resources cleaned for ${connectionName}. In-memory session status: ${session.status}`
      );
    }
  }

  removeSession(connectionName) {
    if (this.sessions.has(connectionName)) {
      this.sessions.delete(connectionName);
      logger.info(
        `ClientManager: Session ${connectionName} removed from in-memory map.`
      );
    }
  }

  async destroyClient(
    connectionName,
    forceClose = false,
    calledFromAuthFailure = false
  ) {
    logger.info(
      `ClientManager: Destroying client for connection: '${connectionName}'. Force: ${forceClose}`
    );
    const session = this.sessions.get(connectionName);

    if (session) {
      session.isReconnecting = false;
      const finalStatus = forceClose
        ? calledFromAuthFailure
          ? "auth_failed"
          : "closed_forced"
        : "closed_manual";
      session.status = finalStatus;
      await this.cleanupClientResources(connectionName, false);
      return finalStatus;
    }
    logger.warn(
      `ClientManager: Attempted to destroy client for non-existent session '${connectionName}'.`
    );
    return "not_found";
  }
}

export default WhatsAppClientManager;
