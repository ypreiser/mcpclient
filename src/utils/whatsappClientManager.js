// mcpclient/utils/whatsappClientManager.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import BotProfile from "../models/botProfileModel.js"; // Ensure this is used
import { botProfileToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";

const { Client, RemoteAuth } = pkg;

const PUPPETEER_AUTH_PATH = process.env.PUPPETEER_AUTH_PATH || "./.wwebjs_auth";
const PUPPETEER_CACHE_PATH =
  process.env.PUPPETEER_CACHE_PATH || "./.wwebjs_cache";

let mongoStoreInstance;
let mongoStoreInitializationPromise = null;

const getMongoStore = async () => {
  if (mongoStoreInstance) return mongoStoreInstance;
  if (mongoStoreInitializationPromise) return mongoStoreInitializationPromise;

  mongoStoreInitializationPromise = new Promise((resolve, reject) => {
    const checkConnection = () => {
      if (mongoose.connection.readyState === 1) {
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
          "ClientManager: MongoDB connection not ready for MongoStore. Waiting..."
        );
        const timeoutId = setTimeout(() => {
          mongoose.connection.off("connected", connectedListener);
          mongoose.connection.off("error", errorListener);
          reject(
            new Error("Timeout waiting for MongoDB connection for MongoStore.")
          );
        }, 30000);
        const connectedListener = () => {
          clearTimeout(timeoutId);
          mongoose.connection.off("error", errorListener);
          checkConnection();
        };
        const errorListener = (err) => {
          clearTimeout(timeoutId);
          mongoose.connection.off("connected", connectedListener);
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
    this.sessions = new Map();
    this.eventHandler = eventHandler;
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
        botProfileId: null, // Will be ObjectId
        aiInstance: null,
        userId: null, // Will be ObjectId
        isReconnecting: false,
        reconnectAttempts: 0,
        ...defaults,
      });
    }
    return this.sessions.get(connectionName);
  }

  async createAndInitializeClient(
    connectionName,
    botProfileId, // ObjectId
    userId, // ObjectId
    isRetry = false,
    closeCallback
  ) {
    logger.info(
      `ClientManager: Initializing client for Conn: '${connectionName}', ProfileId: '${botProfileId}', User: '${userId}'${
        isRetry ? " (Retry)" : ""
      }`
    );

    const sessionEntry = this.getOrCreateSessionEntry(connectionName, {
      botProfileId,
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
        `ClientManager: Session '${connectionName}' client already managed (Status: ${sessionEntry.status}).`
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
      const botProfileDoc = await BotProfile.findOne({
        _id: botProfileId,
        userId: userId,
        isEnabled: true,
      }); // Check ownership and if enabled
      if (!botProfileDoc) {
        const profileExistsForUser = await BotProfile.exists({
          _id: botProfileId,
          userId: userId,
        });
        const profileExistsAnyUser = await BotProfile.exists({
          _id: botProfileId,
        });

        let errorMsg = `Bot profile with ID "${botProfileId}" not found.`;
        if (profileExistsAnyUser && !profileExistsForUser) {
          errorMsg = `Access denied: You do not own bot profile with ID '${botProfileId}'.`;
        } else if (
          profileExistsForUser &&
          !(await BotProfile.findOne({ _id: botProfileId, userId: userId }))
            .isEnabled
        ) {
          errorMsg = `Bot profile with ID '${botProfileId}' is disabled.`;
        }
        logger.error(`ClientManager: ${errorMsg} for user ${userId}`);
        throw new Error(errorMsg);
      }
      // Store the actual name from the loaded document for logging/display
      sessionEntry.botProfileName = botProfileDoc.name;

      const aiInstance = await initializeAI(botProfileDoc._id); // Use the actual _id
      aiInstance.botProfileText = botProfileToNaturalLanguage(
        botProfileDoc.toObject()
      );

      const store = await getMongoStore();
      const client = new Client({
        clientId: connectionName,
        authStrategy: new RemoteAuth({
          store,
          clientId: connectionName,
          backupSyncIntervalMs: 300000,
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
        webVersion: "2.2409.2",
        webVersionCache: { type: "local", path: PUPPETEER_CACHE_PATH },
      });

      sessionEntry.client = client;
      sessionEntry.status = "initializing";
      sessionEntry.botProfileId = botProfileDoc._id; // Ensure it's the ObjectId
      sessionEntry.aiInstance = aiInstance;
      sessionEntry.userId = userId; // Ensure it's the ObjectId
      sessionEntry.isReconnecting = isRetry;
      sessionEntry.reconnectAttempts = isRetry
        ? (sessionEntry.reconnectAttempts || 0) +
          (sessionEntry.status !== "reconnecting" ? 1 : 0)
        : 0;
      sessionEntry.closeCallback = closeCallback;

      if (!isRetry) {
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          botProfileDoc._id,
          userId,
          "initializing",
          true
        );
      }

      this.eventHandler.registerEventHandlers(client, connectionName);
      await client.initialize();

      let phoneNumber = client.info?.wid?.user || null;
      if (phoneNumber) {
        logger.info(
          `ClientManager: Phone number for ${connectionName} is ${phoneNumber}`
        );
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          botProfileDoc._id,
          userId,
          sessionEntry.status,
          true,
          new Date(),
          phoneNumber
        );
      }

      return client;
    } catch (error) {
      logger.error(
        {
          err: error,
          connectionName,
          botProfileIdFromArg: botProfileId,
          userId,
          isRetry,
        },
        `ClientManager: Error in createAndInitializeClient`
      );
      sessionEntry.status = "init_failed";
      const isAuthRelatedError =
        error.message.toLowerCase().includes("auth") ||
        error.message.toLowerCase().includes("qr");
      const shouldDisableReconnect =
        isAuthRelatedError ||
        error.message.includes("Access denied") ||
        error.message.includes("not found") ||
        error.message.includes("disabled");

      if (!isRetry || !sessionEntry.isReconnecting) {
        await this.cleanupClientResources(
          connectionName,
          error.message.includes("Timeout")
        );
        await connectionPersistence.saveConnectionDetails(
          connectionName,
          botProfileId,
          userId,
          `init_failed: ${error.message.substring(0, 50)}`,
          !shouldDisableReconnect
        );
      } else if (isRetry && sessionEntry.isReconnecting) {
        logger.warn(
          `ClientManager: Initialize failed during reconnect for ${connectionName}. Attempt ${sessionEntry.reconnectAttempts}.`
        );
      }
      throw error;
    }
  }

  async cleanupClientResources(connectionName, isPuppeteerTimeout = false) {
    const session = this.sessions.get(connectionName);
    if (session) {
      if (session.client) {
        if (!isPuppeteerTimeout) {
          // Only destroy if not a puppeteer timeout
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
        } else {
          logger.warn(
            `ClientManager: Puppeteer timeout for ${connectionName}, client.destroy() skipped to avoid hangs.`
          );
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
    return "not_found";
  }
}

export default WhatsAppClientManager;
