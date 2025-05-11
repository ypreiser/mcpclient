// whatsappService.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
// import WhatsAppCredentials from "../models/WhatsAppCredentials.js"; // Potentially redundant
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";

const { Client, RemoteAuth } = pkg;

const PUPPETEER_AUTH_PATH = process.env.PUPPETEER_AUTH_PATH || "./.wwebjs_auth";
const PUPPETEER_CACHE_PATH = process.env.PUPPETEER_CACHE_PATH || "./.wwebjs_cache";


let mongoStoreInstance;
const getMongoStore = () => {
  if (!mongoStoreInstance) {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
        logger.error("MongoDB connection not ready for MongoStore for WhatsApp.");
        // This implies an issue with the main MongoDB connection initialization order.
        // For now, we'll throw, but in a robust system, you might retry or delay.
        throw new Error("MongoDB connection not available for WhatsApp session store.");
    }
    mongoStoreInstance = new MongoStore({
      mongoose: mongoose,
      collectionName: "whatsapp_sessions", // Customizable if needed
    });
    logger.info("MongoStore for WhatsApp initialized.");
  }
  return mongoStoreInstance;
}


class WhatsAppService {
  constructor() {
    this.sessions = new Map(); // Stores { client, status, qr, systemPromptName, aiInstance }
    // this.aiInstances = new Map(); // Merged into this.sessions
    // this.clients = new Map(); // Merged into this.sessions (client is part of session object)
  }

  async initializeSession(connectionName, systemPromptName) {
    logger.info(
      `Service: Initializing WhatsApp session. Connection: '${connectionName}', Prompt: '${systemPromptName}'`
    );
    try {
      const existingSession = this.sessions.get(connectionName);
      if (
        existingSession &&
        (existingSession.status === "initializing" ||
          existingSession.status === "qr_ready" ||
          existingSession.status === "connected" ||
          existingSession.status === "authenticated")
      ) {
        logger.warn(
          `Service: Session '${connectionName}' already exists with status ${existingSession.status}. Aborting new initialization.`
        );
        throw new Error(
          `Session '${connectionName}' is already being managed. Please disconnect first or use a different name.`
        );
      }

      // Fetch and prepare AI components first
      const systemPromptDoc = await SystemPrompt.findOne({
        name: systemPromptName,
      });
      if (!systemPromptDoc) {
        throw new Error(`System prompt "${systemPromptName}" not found`);
      }

      const aiInstance = await initializeAI(systemPromptName);
      const systemPromptText = systemPromptToNaturalLanguage(systemPromptDoc.toObject());
      aiInstance.systemPromptText = systemPromptText; // Add natural language prompt to AI instance
      aiInstance.chatHistory = []; // For AI context window

      const store = getMongoStore();

      const client = new Client({
        clientId: connectionName,
        authStrategy: new RemoteAuth({
          store: store,
          clientId: connectionName,
          backupSyncIntervalMs: 300000, // 5 minutes
          dataPath: `${PUPPETEER_AUTH_PATH}/session-${connectionName}`, // Ensure this directory is writable
        }),
        puppeteer: {
          headless: true, // Always true for production servers
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu",
            "--single-process", // May help in resource-constrained envs, monitor
          ],
          // executablePath: process.env.CHROME_EXECUTABLE_PATH, // Optional: if system Chrome/Chromium is preferred
        },
        webVersion: "2.2409.2", // Keep pinned, update deliberately
        webVersionCache: {
          type: "local", // Or 'remote' if preferred
          path: PUPPETEER_CACHE_PATH, // Ensure this directory is writable
        },
      });

      // Store session info immediately
      this.sessions.set(connectionName, {
        client,
        status: "initializing",
        qr: null,
        systemPromptName,
        aiInstance,
      });
      logger.info(`Service: Session entry created for '${connectionName}'. Status: initializing.`);

      // Event handlers
      client.on("qr", (qr) => {
        logger.info(`Service: QR Code received for '${connectionName}'.`);
        if (!qr || typeof qr !== "string" || qr.length === 0) {
          logger.error(`Service: Invalid QR code data received for '${connectionName}'.`);
          const current = this.sessions.get(connectionName);
          if (current) this.sessions.set(connectionName, { ...current, status: "qr_error" });
          return;
        }
        const current = this.sessions.get(connectionName);
        if (current) {
          this.sessions.set(connectionName, { ...current, qr, status: "qr_ready" });
          logger.info(`Service: Session for '${connectionName}' updated. Status: qr_ready.`);
        } else {
          logger.error(`Service Critical Error: '${connectionName}' not found in map when 'qr' event fired.`);
        }
      });

      client.on("ready", () => {
        logger.info(`Service: WhatsApp client is ready for '${connectionName}'.`);
        const current = this.sessions.get(connectionName);
        if (current) this.sessions.set(connectionName, { ...current, status: "connected", qr: null });
      });

      client.on("authenticated", () => {
        logger.info(`Service: WhatsApp client authenticated for '${connectionName}'.`);
        const current = this.sessions.get(connectionName);
        if (current) this.sessions.set(connectionName, { ...current, status: "authenticated", qr: null });
      });

      client.on("auth_failure", (errorMsg) => {
        logger.error(`Service: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`);
        const current = this.sessions.get(connectionName);
        if (current) this.sessions.set(connectionName, { ...current, status: "auth_failed" });
        // Consider automatic cleanup/retry logic here
        this.closeSession(connectionName).catch(err => logger.error({err}, `Error during auto-cleanup for ${connectionName} on auth_failure`));
      });

      client.on("disconnected", (reason) => {
        logger.warn(`Service: WhatsApp client disconnected for '${connectionName}'. Reason: ${reason}`);
        const current = this.sessions.get(connectionName);
        if (current) this.sessions.set(connectionName, { ...current, status: "disconnected" });
        // Aggressive cleanup on any disconnect to avoid zombie sessions
        this.closeSession(connectionName).catch(err => logger.error({err}, `Error during auto-cleanup for ${connectionName} on disconnect`));
      });

      client.on("message", async (message) => {
        if (message.fromMe || message.from === "status@broadcast") return;

        const currentSession = this.sessions.get(connectionName);
        if (!currentSession || !currentSession.aiInstance) {
          logger.error(`Service: AI not initialized or session not found for '${connectionName}' on message event.`);
          try {
            await message.reply("Sorry, the AI service for this connection is not properly configured.");
          } catch (replyErr) {
            logger.error({err: replyErr}, `Failed to send error reply for ${connectionName}`);
          }
          return;
        }
        
        const { aiInstance } = currentSession;
        const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText, chatHistory } = aiInstance;


        try {
          logger.info({ body: message.body, from: message.from, connectionName }, "Service: Received message");

          let chat = await Chat.findOne({ sessionId: message.from, "metadata.connectionName": connectionName });
          const contact = await message.getContact();
          const userName = contact.name || contact.pushname || message.from;

          if (!chat) {
            chat = new Chat({
              sessionId: message.from, // This is the user's chat ID (e.g. phone number)
              source: "whatsapp",
              metadata: {
                userName,
                connectionName, // Store which of our connections this chat belongs to
                lastActive: new Date(),
                tags: [],
                notes: "",
              },
              messages: [],
            });
          } else {
            chat.metadata.lastActive = new Date();
            if (chat.metadata.userName !== userName) chat.metadata.userName = userName;
          }

          const userMessageEntry = { role: "user", content: message.body, timestamp: new Date(), status: "sent" };
          chat.messages.push(userMessageEntry);
          
          // Manage AI chat history (e.g., keep last N messages for context)
          const MAX_HISTORY_LENGTH = 20; // Example: keep last 20 messages (user + assistant)
          chatHistory.push({ role: "user", content: message.body });
          if (chatHistory.length > MAX_HISTORY_LENGTH) {
            chatHistory.splice(0, chatHistory.length - MAX_HISTORY_LENGTH);
          }

          const response = await generateText({
            model: google(GEMINI_MODEL_NAME),
            tools,
            maxSteps: 10,
            system: systemPromptText,
            messages: chatHistory,
          });

          const assistantMessageEntry = { role: "assistant", content: response.text, timestamp: new Date(), status: "sent" };
          chat.messages.push(assistantMessageEntry);
          chatHistory.push({ role: "assistant", content: response.text }); // Also add assistant response to AI history
          
          chat.updatedAt = new Date();
          await chat.save();

          const sentMessage = await message.reply(response.text);
          // Update message status (simplified, could be more robust)
          const updateLastMessageStatus = async (status) => {
            const freshChat = await Chat.findById(chat._id);
            if (freshChat && freshChat.messages.length > 0) {
                const lastMsg = freshChat.messages[freshChat.messages.length - 1];
                if (lastMsg.role === 'assistant') { // Ensure it's the assistant's message
                    lastMsg.status = status;
                    freshChat.updatedAt = new Date();
                    await freshChat.save().catch(err => logger.error({err}, "Error saving chat on status update"));
                }
            }
          };
          // Note: 'delivered' and 'read' events on `sentMessage` are not reliably emitted for all message types or situations.
          // Relying on ack events might be better if available.
          // For now, this is a simple attempt.
          // setTimeout(() => updateLastMessageStatus("delivered"), 5000); // Optimistic delivered
          logger.info({ to: message.from, connectionName, responseText: response.text }, "Service: Sent AI response");

        } catch (error) {
          logger.error({ err: error, connectionName, from: message.from }, "Service: Error processing message");
          try {
            await message.reply("Sorry, I encountered an error processing your message.");
          } catch (replyErr) {
            logger.error({err: replyErr}, `Failed to send error reply after processing error for ${connectionName}`);
          }
        }
      });

      logger.info(`Service: Starting WhatsApp client.initialize() for '${connectionName}'...`);
      await client.initialize();
      logger.info(`Service: client.initialize() completed for '${connectionName}'.`);

      return client;
    } catch (error) {
      logger.error({ err: error, connectionName }, `Service: Error in initializeSession for '${connectionName}'`);
      // Ensure cleanup if initialization fails at any point
      const sessionToClean = this.sessions.get(connectionName);
      if (sessionToClean) {
        if (sessionToClean.client) {
          try {
            await sessionToClean.client.destroy();
            logger.info(`Service: Client for '${connectionName}' destroyed during error cleanup.`);
          } catch (destroyError) {
            logger.error({ err: destroyError, connectionName }, `Service: Error destroying client during cleanup for '${connectionName}'.`);
          }
        }
        if (sessionToClean.aiInstance && sessionToClean.aiInstance.closeMcpClients) {
            await sessionToClean.aiInstance.closeMcpClients();
        }
      }
      this.sessions.delete(connectionName);
      logger.info(`Service: Cleaned up session for '${connectionName}' due to initialization error.`);
      throw error;
    }
  }

  async getQRCode(connectionName) {
    const session = this.sessions.get(connectionName);
    if (!session) {
      logger.warn(`Service: getQRCode called for non-existent connection: '${connectionName}'.`);
      return null;
    }
    if (session.status !== 'qr_ready' || !session.qr || typeof session.qr !== "string" || session.qr.length === 0) {
      logger.warn(`Service: QR code not ready or invalid for '${connectionName}'. Status: ${session.status}.`);
      return null;
    }
    logger.info(`Service: Getting QR Code for '${connectionName}'. Status: ${session.status}.`);
    return session.qr;
  }

  async getStatus(connectionName) {
    const session = this.sessions.get(connectionName);
    if (!session) {
      return "not_found";
    }
    return session.status || "unknown";
  }

  async sendMessage(connectionName, to, messageText) {
    const session = this.sessions.get(connectionName);
    if (!session || !session.client) {
      throw new Error(`Connection client not found for '${connectionName}'.`);
    }
    if (session.status !== "connected" && session.status !== "authenticated") { // 'ready' is also a valid state
      throw new Error(
        `WhatsApp client for '${connectionName}' is not connected (status: ${session.status}).`
      );
    }
    logger.info({connectionName, to, messageText}, `Service: Sending message via '${connectionName}'.`);
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(connectionName) {
    logger.info(`Service: Attempting to close connection: '${connectionName}'.`);
    const session = this.sessions.get(connectionName);

    if (session) {
      if (session.client) {
        try {
          await session.client.logout();
          logger.info(`Service: WhatsApp client logged out for '${connectionName}'.`);
        } catch (logoutError) {
          logger.error({ err: logoutError, connectionName }, `Service: Error logging out client for '${connectionName}'. Attempting destroy.`);
        }
        try {
          await session.client.destroy();
          logger.info(`Service: WhatsApp client destroyed for '${connectionName}'.`);
        } catch (destroyError) {
          logger.error({ err: destroyError, connectionName }, `Service: Error destroying client for '${connectionName}'.`);
        }
      }
      if (session.aiInstance && session.aiInstance.closeMcpClients) {
        try {
            await session.aiInstance.closeMcpClients();
            logger.info(`Service: AI MCP clients closed for '${connectionName}'.`);
        } catch (aiCloseError) {
            logger.error({ err: aiCloseError, connectionName }, `Service: Error closing AI MCP clients for '${connectionName}'.`);
        }
      }
      this.sessions.delete(connectionName);
    }

    // If using a separate WhatsAppCredentials model and it's keyed by connectionName
    try {
      await WhatsAppCredentials.deleteOne({ connectionName: connectionName });
      logger.info(`Service: Removed credentials from MongoDB for '${connectionName}'.`);
    } catch (dbError) {
      logger.error({err: dbError, connectionName}, `Service: Error removing credentials for '${connectionName}'.`);
    }
    // Note: wwebjs-mongo RemoteAuth handles its own session data removal based on its logic.

    logger.info(`Service: All resources for connection '${connectionName}' cleaned up.`);
    return true;
  }
}

export default new WhatsAppService();