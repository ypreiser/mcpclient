// whatsappService.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js"; // Import SSoT model
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";

const { Client, RemoteAuth } = pkg;
const PUPPETEER_AUTH_PATH = process.env.PUPPETEER_AUTH_PATH || "./.wwebjs_auth";
const PUPPETEER_CACHE_PATH =
  process.env.PUPPETEER_CACHE_PATH || "./.wwebjs_cache";

let mongoStoreInstance;
const getMongoStore = () => {
  if (!mongoStoreInstance) {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      logger.error("MongoDB connection not ready for MongoStore for WhatsApp.");
      throw new Error(
        "MongoDB connection not available for WhatsApp session store."
      );
    }
    mongoStoreInstance = new MongoStore({ mongoose: mongoose });
    logger.info("MongoStore for WhatsApp initialized.");
  }
  return mongoStoreInstance;
};

class WhatsAppService {
  constructor() {
    this.sessions = new Map(); // Stores { client, status, qr, systemPromptName, systemPromptId, aiInstance, userId }
  }

  async initializeSession(connectionName, systemPromptName, userId) {
    logger.info(
      `Service: Initializing WhatsApp. Conn: '${connectionName}', Prompt: '${systemPromptName}', User: '${userId}'`
    );
    if (!userId) {
      logger.error(
        `Service: User ID is required for WhatsApp session '${connectionName}'.`
      );
      throw new Error("User ID is required for session initialization.");
    }

    try {
      if (this.sessions.has(connectionName)) {
        const existing = this.sessions.get(connectionName);
        if (
          ["initializing", "qr_ready", "connected", "authenticated"].includes(
            existing.status
          )
        ) {
          logger.warn(
            `Service: Session '${connectionName}' already managed (status: ${existing.status}).`
          );
          throw new Error(
            `Session '${connectionName}' is already active or being initialized.`
          );
        }
      }

      const systemPromptDoc = await SystemPrompt.findOne({
        name: systemPromptName,
        userId: userId,
      });
      if (!systemPromptDoc) {
        // Check if prompt exists but owner is different for a more specific error
        const promptExistsWithOwner = await SystemPrompt.findOne({
          name: systemPromptName,
        });
        if (promptExistsWithOwner) {
          logger.warn(
            { userId, systemPromptName, owner: promptExistsWithOwner.userId },
            "User attempting to use a WhatsApp connection with a system prompt they do not own."
          );
          throw new Error(
            `Access denied: You do not own system prompt '${systemPromptName}'.`
          );
        }
        throw new Error(
          `System prompt "${systemPromptName}" not found or not owned by user.`
        );
      }

      const aiInstance = await initializeAI(systemPromptName); // Relies on systemPromptName being unique
      aiInstance.systemPromptText = systemPromptToNaturalLanguage(
        systemPromptDoc.toObject()
      );

      const store = getMongoStore();
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
          ],
        },
        webVersion: "2.2409.2",
        webVersionCache: { type: "local", path: PUPPETEER_CACHE_PATH },
      });

      this.sessions.set(connectionName, {
        client,
        status: "initializing",
        qr: null,
        systemPromptName,
        systemPromptId: systemPromptDoc._id, // Store systemPromptId
        aiInstance,
        userId,
      });
      logger.info(
        `Service: Session entry created for '${connectionName}'. User: ${userId}`
      );

      this.registerClientEventHandlers(client, connectionName);

      logger.info(
        `Service: Starting WhatsApp client.initialize() for '${connectionName}'...`
      );
      await client.initialize(); // This can take time
      logger.info(
        `Service: client.initialize() potentially completed for '${connectionName}'. Status will update via events.`
      );
      return client; // Or just an indication of success, status is tracked internally
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId },
        `Service: Error in initializeSession for '${connectionName}'`
      );
      await this.cleanupSessionResources(
        connectionName,
        error.message.includes("Timeout")
      );
      throw error;
    }
  }

  registerClientEventHandlers(client, connectionName) {
    client.on("qr", (qr) => {
      logger.info(`Service: QR Code for '${connectionName}'.`);
      const current = this.sessions.get(connectionName);
      if (current)
        this.sessions.set(connectionName, {
          ...current,
          qr,
          status: "qr_ready",
        });
      else
        logger.error(`Critical: '${connectionName}' not in map on 'qr' event.`);
    });
    client.on("ready", () => {
      logger.info(`Service: WhatsApp client ready for '${connectionName}'.`);
      const current = this.sessions.get(connectionName);
      if (current)
        this.sessions.set(connectionName, {
          ...current,
          status: "connected",
          qr: null,
        });
    });
    client.on("authenticated", () => {
      logger.info(
        `Service: WhatsApp client authenticated for '${connectionName}'.`
      );
      const current = this.sessions.get(connectionName);
      if (current)
        this.sessions.set(connectionName, {
          ...current,
          status: "authenticated",
          qr: null,
        });
    });
    client.on("auth_failure", (msg) => {
      logger.error(`Service: Auth failure for '${connectionName}': ${msg}`);
      const current = this.sessions.get(connectionName);
      if (current)
        this.sessions.set(connectionName, {
          ...current,
          status: "auth_failed",
        });
      this.closeSession(connectionName).catch((err) =>
        logger.error(
          { err },
          `Cleanup error for ${connectionName} on auth_failure`
        )
      );
    });
    client.on("disconnected", (reason) => {
      logger.warn(
        `Service: Client disconnected for '${connectionName}'. Reason: ${reason}`
      );
      const current = this.sessions.get(connectionName);
      // If status is already 'closing' or 'closed', don't overwrite to 'disconnected'
      if (current && !["closing", "closed"].includes(current.status)) {
        this.sessions.set(connectionName, {
          ...current,
          status: "disconnected",
        });
      }
      this.closeSession(connectionName).catch((err) =>
        logger.error(
          { err },
          `Cleanup error for ${connectionName} on disconnect`
        )
      );
    });
    client.on("message", async (message) =>
      this.handleIncomingMessage(message, connectionName)
    );
  }

  async handleIncomingMessage(message, connectionName) {
    if (message.fromMe || message.from === "status@broadcast") return;
    logger.info(
      `Service: Message received for ${connectionName} from ${message.from}`
    );

    const currentSession = this.sessions.get(connectionName);
    if (
      !currentSession ||
      !currentSession.aiInstance ||
      !currentSession.userId ||
      !currentSession.systemPromptId
    ) {
      logger.error(
        `Service: AI not init, session invalid, or IDs missing for '${connectionName}' on message.`
      );
      try {
        await message.reply(
          "AI service misconfiguration. Please contact support."
        );
      } catch (e) {
        logger.error({ e }, "Failed to send config error reply");
      }
      return;
    }

    const { aiInstance, userId, systemPromptId, systemPromptName } =
      currentSession;
    const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
      aiInstance;
    const userNumber = message.from.split("@")[0];

    try {
      const contact = await message.getContact();
      const userName = contact.name || contact.pushname || message.from;

      let chat = await Chat.findOneAndUpdate(
        {
          sessionId: userNumber,
          "metadata.connectionName": connectionName,
          source: "whatsapp",
          userId: userId,
        },
        {
          $setOnInsert: {
            sessionId: userNumber,
            source: "whatsapp",
            userId: userId,
            systemPromptId: systemPromptId,
            systemPromptName: systemPromptName,
            "metadata.connectionName": connectionName,
            messages: [],
          },
          $set: {
            "metadata.lastActive": new Date(),
            "metadata.userName": userName,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      chat.messages.push({
        role: "user",
        content: message.body,
        timestamp: new Date(),
        status: "delivered",
      });
      const messagesForAI = chat.messages
        .slice(-20)
        .map((msg) => ({ role: msg.role, content: msg.content }));
      // Add contextual message if needed

      const response = await generateText({
        model: google(GEMINI_MODEL_NAME),
        tools,
        maxSteps: 10,
        system: systemPromptText,
        messages: messagesForAI,
      });

      if (response.usage) {
        const { promptTokens, completionTokens } = response.usage;
        if (
          typeof promptTokens === "number" &&
          typeof completionTokens === "number"
        ) {
          const totalTokens = promptTokens + completionTokens;
          const usageRecord = new TokenUsageRecord({
            userId: userId, // User who owns the WA connection
            systemPromptId: systemPromptId,
            systemPromptName: systemPromptName,
            chatId: chat._id,
            source: "whatsapp",
            modelName: GEMINI_MODEL_NAME,
            promptTokens,
            completionTokens,
            totalTokens,
            timestamp: new Date(),
          });
          await usageRecord.save();

          await User.logTokenUsage({ userId, promptTokens, completionTokens });
          await SystemPrompt.logTokenUsage({
            systemPromptId,
            promptTokens,
            completionTokens,
          });
          logger.info(
            {
              userId,
              systemPromptId,
              promptTokens,
              completionTokens,
              source: "whatsapp",
            },
            "Token usage logged for WhatsApp."
          );
        } else {
          logger.warn(
            { userId, usage: response.usage, source: "whatsapp" },
            "Invalid token usage data from AI SDK for WhatsApp."
          );
        }
      } else {
        logger.warn(
          { userId, source: "whatsapp" },
          "Token usage data not available from AI SDK for WhatsApp."
        );
      }

      const assistantResponseText =
        response.text || "No text response from AI.";
      chat.messages.push({
        role: "assistant",
        content: assistantResponseText,
        timestamp: new Date(),
        status: "sent",
      });
      chat.updatedAt = new Date();
      await chat.save();
      await message.reply(assistantResponseText);
      logger.info(
        { to: userNumber, connectionName },
        "Service: Sent AI response via WhatsApp"
      );
    } catch (error) {
      logger.error(
        { err: error, connectionName, from: userNumber, userId },
        "Service: Error processing WhatsApp message"
      );
      try {
        await message.reply("Error processing your message.");
      } catch (e) {
        logger.error({ e }, "Failed to send processing error reply");
      }
    }
  }
  async cleanupSessionResources(connectionName, isTimeout = false) {
    const session = this.sessions.get(connectionName);
    if (session) {
      if (session.client) {
        try {
          if (!isTimeout) {
            // If it's a timeout, client.destroy() might hang
            await session.client.destroy();
          }
          logger.info(
            `Service: Client for '${connectionName}' destroyed during cleanup.`
          );
        } catch (destroyError) {
          logger.error(
            { err: destroyError, connectionName },
            `Service: Error destroying client during cleanup.`
          );
        }
      }
      if (session.aiInstance?.closeMcpClients) {
        await session.aiInstance.closeMcpClients();
      }
      this.sessions.delete(connectionName);
      logger.info(
        `Service: Cleaned up session resources for '${connectionName}'.`
      );
    }
  }

  async getQRCode(connectionName) {
    const session = this.sessions.get(connectionName);
    if (!session) return null;
    if (session.status !== "qr_ready" || !session.qr) return null;
    return session.qr;
  }

  async getStatus(connectionName) {
    const session = this.sessions.get(connectionName);
    return session ? session.status : "not_found";
  }

  async sendMessage(connectionName, to, messageText) {
    const session = this.sessions.get(connectionName);
    if (
      !session?.client ||
      !["connected", "authenticated"].includes(session.status)
    ) {
      throw new Error(
        `WhatsApp client for '${connectionName}' not ready (status: ${
          session?.status || "N/A"
        }).`
      );
    }
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(connectionName) {
    logger.info(
      `Service: Attempting to close connection: '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);

    if (session) {
      session.status = "closing"; // Mark as closing
      if (session.client) {
        try {
          await session.client.logout(); // Graceful logout
          logger.info(
            `Service: WhatsApp client logged out for '${connectionName}'.`
          );
        } catch (logoutError) {
          logger.error(
            { err: logoutError, connectionName },
            `Error logging out client, will proceed to destroy.`
          );
        }
        try {
          await session.client.destroy(); // Destroy client resources
          logger.info(
            `Service: WhatsApp client destroyed for '${connectionName}'.`
          );
        } catch (destroyError) {
          logger.error(
            { err: destroyError, connectionName },
            `Error destroying client for '${connectionName}'.`
          );
        }
      }
      if (session.aiInstance?.closeMcpClients) {
        try {
          await session.aiInstance.closeMcpClients();
          logger.info(
            `Service: AI MCP clients closed for '${connectionName}'.`
          );
        } catch (aiCloseError) {
          logger.error(
            { err: aiCloseError, connectionName },
            `Error closing AI MCP clients.`
          );
        }
      }
      session.status = "closed";
      this.sessions.delete(connectionName); // Remove from map
      logger.info(
        `Service: Connection '${connectionName}' fully closed and resources cleaned.`
      );
    } else {
      logger.warn(
        `Service: Attempted to close non-existent or already cleaned session '${connectionName}'.`
      );
    }
    return true;
  }
}

export default new WhatsAppService();
