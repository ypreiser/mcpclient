// whatsappService.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
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
    mongoStoreInstance = new MongoStore({
      mongoose: mongoose,
      // collectionName: "whatsapp_sessions",
    });
    logger.info("MongoStore for WhatsApp initialized.");
  }
  return mongoStoreInstance;
};

class WhatsAppService {
  constructor() {
    this.sessions = new Map(); // Stores { client, status, qr, systemPromptName, aiInstance }
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
      const systemPromptText = systemPromptToNaturalLanguage(
        systemPromptDoc.toObject()
      );
      aiInstance.systemPromptText = systemPromptText;

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
          headless: true,
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
      logger.info(
        `Service: Session entry created for '${connectionName}'. Status: initializing.`
      );

      // Event handlers
      client.on("qr", (qr) => {
        logger.info(`Service: QR Code received for '${connectionName}'.`);
        if (!qr || typeof qr !== "string" || qr.length === 0) {
          logger.error(
            `Service: Invalid QR code data received for '${connectionName}'.`
          );
          const current = this.sessions.get(connectionName);
          if (current)
            this.sessions.set(connectionName, {
              ...current,
              status: "qr_error",
            });
          return;
        }
        const current = this.sessions.get(connectionName);
        if (current) {
          this.sessions.set(connectionName, {
            ...current,
            qr,
            status: "qr_ready",
          });
          logger.info(
            `Service: Session for '${connectionName}' updated. Status: qr_ready.`
          );
        } else {
          logger.error(
            `Service Critical Error: '${connectionName}' not found in map when 'qr' event fired.`
          );
        }
      });

      client.on("ready", () => {
        logger.info(
          `Service: WhatsApp client is ready for '${connectionName}'.`
        );
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

      client.on("auth_failure", (errorMsg) => {
        logger.error(
          `Service: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`
        );
        const current = this.sessions.get(connectionName);
        if (current)
          this.sessions.set(connectionName, {
            ...current,
            status: "auth_failed",
          });
        this.closeSession(connectionName).catch((err) =>
          logger.error(
            { err },
            `Error during auto-cleanup for ${connectionName} on auth_failure`
          )
        );
      });

      client.on("disconnected", (reason) => {
        logger.warn(
          `Service: WhatsApp client disconnected for '${connectionName}'. Reason: ${reason}`
        );
        const current = this.sessions.get(connectionName);
        if (current)
          this.sessions.set(connectionName, {
            ...current,
            status: "disconnected",
          });
        this.closeSession(connectionName).catch((err) =>
          logger.error(
            { err },
            `Error during auto-cleanup for ${connectionName} on disconnect`
          )
        );
      });

      client.on("message", async (message) => {
        if (message.fromMe || message.from === "status@broadcast") return;
        logger.info("Service: Message received");

        const currentSession = this.sessions.get(connectionName);
        if (!currentSession || !currentSession.aiInstance) {
          logger.error(
            `Service: AI not initialized or session not found for '${connectionName}' on message event.`
          );
          try {
            await message.reply(
              "Sorry, the AI service for this connection is not properly configured."
            );
          } catch (replyErr) {
            logger.error(
              { err: replyErr },
              `Failed to send error reply for ${connectionName}`
            );
          }
          return;
        }

        const {
          tools,
          google,
          GEMINI_MODEL_NAME,
          generateText,
          systemPromptText,
        } = currentSession.aiInstance; // chatHistory is no longer part of aiInstance state here

        let userNumber; // Declare userNumber outside the try block

        try {
          const contact = await message.getContact();
          const userName = contact.name || contact.pushname || message.from;
          userNumber = message.from.split("@")[0]; // Assign value inside the try block
          logger.info({ contact, userName, userNumber }, "msg metadata");

          let chat = await Chat.findOneAndUpdate(
            {
              sessionId: userNumber, // Use the unique user WhatsApp ID
              "metadata.connectionName": connectionName,
            },
            {
              // ---- START OF CORRECTED UPDATE OBJECT ----
              $setOnInsert: {
                sessionId: userNumber,
                source: "whatsapp",
                "metadata.connectionName": connectionName,
                "metadata.tags": [],
                "metadata.notes": "", // Notes initialized as an empty string
                messages: [], // Initialize with an empty messages array
              },
              $set: {
                "metadata.lastActive": new Date(),
                "metadata.userName": userName, // Update username, it might change
              },
            }, // ---- END OF CORRECTED UPDATE OBJECT ----
            {
              upsert: true,
              new: true,
              setDefaultsOnInsert: true,
            }
          );

          const userMessageEntry = {
            role: "user",
            content: message.body,
            timestamp: new Date(),
            status: "delivered", // Status of the incoming message
          };
          chat.messages.push(userMessageEntry);
          // Note: chat object is saved after AI response is added.

          // Prepare chat history for the AI from the database
          const MAX_CONVERSATIONAL_TURNS_FOR_AI = 20; // Number of recent messages (user + assistant) for AI context
          const recentMessagesFromDB = chat.messages
            .slice(-MAX_CONVERSATIONAL_TURNS_FOR_AI) // Get last N messages
            .map((msg) => ({ role: msg.role, content: msg.content })); // Format for AI

          // Construct the contextual metadata message to inform the AI
          const chatNotes = chat.metadata.notes || "No notes available.";
          const contextualMetadataMessage = {
            role: "assistant", // Per requirement, to provide context *to* the assistant
            content: `You are messaging on WhatsApp with ${userName} (Number: ${userNumber.slice(
              "@"
            )}). Associated notes: ${chatNotes}`,
          };

          // Combine metadata message with recent conversation history for the AI
          // The current user's message is already included in recentMessagesFromDB
          const messagesForAI = [
            contextualMetadataMessage,
            ...recentMessagesFromDB,
          ];

          const response = await generateText({
            model: google(GEMINI_MODEL_NAME),
            tools,
            maxSteps: 10, // This is an existing value, ensure it's appropriate for your tools
            system: systemPromptText,
            messages: messagesForAI, // Pass the combined list to the AI
          });

          const assistantMessageEntry = {
            role: "assistant",
            content: response.text,
            timestamp: new Date(),
            status: "sent", // Initial status for the outgoing message
          };
          chat.messages.push(assistantMessageEntry);

          chat.updatedAt = new Date(); // Explicitly set updatedAt
          await chat.save();

          await message.reply(response.text);

          logger.info(
            { to: userNumber, connectionName, responseText: response.text },
            "Service: Sent AI response"
          );
        } catch (error) {
          logger.error(
            { err: error, connectionName, from: userNumber }, // userNumber is now accessible
            "Service: Error processing message"
          );
          try {
            await message.reply(
              "Sorry, I encountered an error processing your message."
            );
          } catch (replyErr) {
            logger.error(
              { err: replyErr },
              `Failed to send error reply after processing error for ${connectionName}`
            );
          }
        }
      });

      logger.info(
        `Service: Starting WhatsApp client.initialize() for '${connectionName}'...`
      );
      await client.initialize();
      logger.info(
        `Service: client.initialize() completed for '${connectionName}'.`
      );

      return client;
    } catch (error) {
      logger.error(
        { err: error, connectionName },
        `Service: Error in initializeSession for '${connectionName}'`
      );
      const sessionToClean = this.sessions.get(connectionName);
      if (sessionToClean) {
        if (sessionToClean.client) {
          try {
            await sessionToClean.client.destroy();
            logger.info(
              `Service: Client for '${connectionName}' destroyed during error cleanup.`
            );
          } catch (destroyError) {
            logger.error(
              { err: destroyError, connectionName },
              `Service: Error destroying client during cleanup for '${connectionName}'.`
            );
          }
        }
        if (
          sessionToClean.aiInstance &&
          sessionToClean.aiInstance.closeMcpClients
        ) {
          await sessionToClean.aiInstance.closeMcpClients();
        }
      }
      this.sessions.delete(connectionName);
      logger.info(
        `Service: Cleaned up session for '${connectionName}' due to initialization error.`
      );
      throw error;
    }
  }

  async getQRCode(connectionName) {
    const session = this.sessions.get(connectionName);
    if (!session) {
      logger.warn(
        `Service: getQRCode called for non-existent connection: '${connectionName}'.`
      );
      return null;
    }
    if (
      session.status !== "qr_ready" ||
      !session.qr ||
      typeof session.qr !== "string" ||
      session.qr.length === 0
    ) {
      logger.warn(
        `Service: QR code not ready or invalid for '${connectionName}'. Status: ${session.status}.`
      );
      return null;
    }
    logger.info(
      `Service: Getting QR Code for '${connectionName}'. Status: ${session.status}.`
    );
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
    if (session.status !== "connected" && session.status !== "authenticated") {
      throw new Error(
        `WhatsApp client for '${connectionName}' is not connected (status: ${session.status}).`
      );
    }
    logger.info(
      { connectionName, to, messageText },
      `Service: Sending message via '${connectionName}'.`
    );
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(connectionName) {
    logger.info(
      `Service: Attempting to close connection: '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);

    if (session) {
      if (session.client) {
        try {
          await session.client.logout();
          logger.info(
            `Service: WhatsApp client logged out for '${connectionName}'.`
          );
        } catch (logoutError) {
          logger.error(
            { err: logoutError, connectionName },
            `Service: Error logging out client for '${connectionName}'. Attempting destroy.`
          );
        }
        try {
          await session.client.destroy();
          logger.info(
            `Service: WhatsApp client destroyed for '${connectionName}'.`
          );
        } catch (destroyError) {
          logger.error(
            { err: destroyError, connectionName },
            `Service: Error destroying client for '${connectionName}'.`
          );
        }
      }
      if (session.aiInstance && session.aiInstance.closeMcpClients) {
        try {
          await session.aiInstance.closeMcpClients();
          logger.info(
            `Service: AI MCP clients closed for '${connectionName}'.`
          );
        } catch (aiCloseError) {
          logger.error(
            { err: aiCloseError, connectionName },
            `Service: Error closing AI MCP clients for '${connectionName}'.`
          );
        }
      }
      this.sessions.delete(connectionName);
    }

    logger.info(
      `Service: All resources for connection '${connectionName}' cleaned up.`
    );
    return true;
  }
}

export default new WhatsAppService();
