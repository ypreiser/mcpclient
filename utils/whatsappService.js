// whatsappService.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import logger from "../utils/logger.js";

const { Client, RemoteAuth } = pkg;

const PUPPETEER_AUTH_PATH = process.env.PUPPETEER_AUTH_PATH || "./.wwebjs_auth";
const PUPPETEER_CACHE_PATH =
  process.env.PUPPETEER_CACHE_PATH || "./.wwebjs_cache";

const MAX_RECONNECT_ATTEMPTS = 5; // Max number of times to try reconnecting
const RECONNECT_INITIAL_DELAY_MS = 5000; // Initial delay for first reconnect attempt (e.g., 5 seconds)
// Subsequent delays will be RECONNECT_INITIAL_DELAY_MS * attemptNumber

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
    this.sessions = new Map();
    // Stores { client, status, qr, systemPromptName, systemPromptId, aiInstance, userId,
    //          isReconnecting: false, reconnectAttempts: 0 }
  }

  async initializeSession(
    connectionName,
    systemPromptName,
    userId,
    isRetry = false
  ) {
    const sessionInfoLog = `Conn: '${connectionName}', Prompt: '${systemPromptName}', User: '${userId}'`;
    logger.info(
      `Service: Initializing WhatsApp. ${sessionInfoLog}${
        isRetry
          ? ` (Retry Attempt ${
              this.sessions.get(connectionName)?.reconnectAttempts || 0
            })`
          : ""
      }`
    );

    if (!userId) {
      logger.error(
        `Service: User ID is required for WhatsApp session '${connectionName}'.`
      );
      throw new Error("User ID is required for session initialization.");
    }

    const existingSession = this.sessions.get(connectionName);

    try {
      if (existingSession && !isRetry) {
        if (
          [
            "initializing",
            "qr_ready",
            "connected",
            "authenticated",
            "reconnecting",
          ].includes(existingSession.status)
        ) {
          logger.warn(
            `Service: Session '${connectionName}' already managed (status: ${existingSession.status}). Not a retry.`
          );
          throw new Error(
            `Session '${connectionName}' is already active, being initialized, or reconnecting.`
          );
        }
      }
      // If it's not a retry, but the session thinks it's reconnecting, something is odd.
      // This might happen if a manual init is attempted while an auto-reconnect is scheduled.
      if (existingSession && existingSession.isReconnecting && !isRetry) {
        logger.warn(
          `Service: Session '${connectionName}' is already in a reconnection process. Aborting new manual initialization.`
        );
        throw new Error(
          `Session '${connectionName}' is currently attempting to reconnect. Please wait or close the session first.`
        );
      }

      const systemPromptDoc = await SystemPrompt.findOne({
        name: systemPromptName,
        userId: userId,
      });
      if (!systemPromptDoc) {
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

      const aiInstance = await initializeAI(systemPromptName);
      aiInstance.systemPromptText = systemPromptToNaturalLanguage(
        systemPromptDoc.toObject()
      );

      const store = getMongoStore();
      const client = new Client({
        clientId: connectionName,
        authStrategy: new RemoteAuth({
          store: store,
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
        webVersion: "2.2409.2", // Pin version
        webVersionCache: { type: "local", path: PUPPETEER_CACHE_PATH },
      });

      if (!isRetry || !existingSession) {
        this.sessions.set(connectionName, {
          client,
          status: "initializing",
          qr: null,
          systemPromptName,
          systemPromptId: systemPromptDoc._id,
          aiInstance,
          userId,
          isReconnecting: isRetry, // if first attempt of retry, set to true
          reconnectAttempts: isRetry
            ? existingSession?.reconnectAttempts || 1
            : 0, // Start with 1 if it's the first retry call
        });
      } else {
        // It's a retry, update existing session entry
        existingSession.client = client;
        existingSession.status = "initializing"; // Reset status for re-initialization
        // reconnectAttempts is managed by handleDisconnect
        // isReconnecting should already be true if we are in a retry
      }
      logger.info(
        `Service: Session entry ${
          isRetry ? "updated for retry" : "created"
        } for '${connectionName}'. User: ${userId}`
      );

      this.registerClientEventHandlers(client, connectionName);

      logger.info(
        `Service: Starting WhatsApp client.initialize() for '${connectionName}'...`
      );
      await client.initialize(); // This can take time

      // If initialize completes without error, it's considered a step towards connection.
      // Actual 'connected' or 'authenticated' status comes from events.
      // If this was a retry, reset attempts as initialization itself was successful.
      const current = this.sessions.get(connectionName);
      if (current && isRetry) {
        // Successful initialization during a retry cycle means we can reset attempts for *this* cycle.
        // The 'ready' or 'authenticated' event will fully clear the 'isReconnecting' flag.
        logger.info(
          `Client.initialize() succeeded for retry of ${connectionName}. Waiting for ready/auth event.`
        );
      }
      logger.info(
        `Service: client.initialize() completed for '${connectionName}'. Status will update via events.`
      );
      return client;
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId, isRetry },
        `Service: Error in initializeSession for '${connectionName}'`
      );
      const sessionBeingHandled = this.sessions.get(connectionName);
      // If it's not a retry OR if it is a retry but the session is no longer marked as reconnecting (e.g., QR shown), then cleanup.
      if (
        sessionBeingHandled &&
        (!isRetry || !sessionBeingHandled.isReconnecting)
      ) {
        await this.cleanupSessionResources(
          connectionName,
          error.message.includes("Timeout")
        );
      } else if (
        sessionBeingHandled &&
        isRetry &&
        sessionBeingHandled.isReconnecting
      ) {
        logger.warn(
          `Initialize failed during reconnect for ${connectionName}. Reconnect attempt ${sessionBeingHandled.reconnectAttempts} failed. HandleDisconnect will manage further retries.`
        );
      }
      throw error; // Re-throw so the caller (or retry logic in handleDisconnect) knows it failed
    }
  }

  registerClientEventHandlers(client, connectionName) {
    client.on("qr", (qr) => {
      logger.info(
        `Service: QR Code received for '${connectionName}'. Manual scan required.`
      );
      const current = this.sessions.get(connectionName);
      if (current) {
        current.qr = qr;
        current.status = "qr_ready";
        current.isReconnecting = false; // QR means session lost, stop auto-reconnect cycle
        current.reconnectAttempts = 0; // Reset attempts
        logger.info(
          `Session ${connectionName} status updated to qr_ready. Reconnection attempts stopped.`
        );
      } else {
        logger.error(
          `CRITICAL: Session '${connectionName}' not found in map when 'qr' event fired.`
        );
      }
    });

    client.on("ready", () => {
      logger.info(`Service: WhatsApp client is ready for '${connectionName}'.`);
      const current = this.sessions.get(connectionName);
      if (current) {
        current.status = "connected";
        current.qr = null;
        current.isReconnecting = false;
        current.reconnectAttempts = 0;
      }
    });

    client.on("authenticated", () => {
      logger.info(
        `Service: WhatsApp client authenticated for '${connectionName}'.`
      );
      const current = this.sessions.get(connectionName);
      if (current) {
        current.status = "authenticated";
        current.qr = null;
        current.isReconnecting = false;
        current.reconnectAttempts = 0;
      }
    });

    client.on("auth_failure", async (errorMsg) => {
      logger.error(
        `Service: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`
      );
      const current = this.sessions.get(connectionName);
      if (current) {
        current.status = "auth_failed";
        current.isReconnecting = false; // Stop reconnection attempts
      }
      // Auth failure usually requires manual intervention (new QR scan)
      await this.closeSession(connectionName, true); // forceClose = true
    });

    client.on("disconnected", (reason) => {
      // This is a critical event for reconnection
      logger.warn(
        `Service: WhatsApp client disconnected for '${connectionName}'. Reason: ${reason}`
      );
      this.handleDisconnect(connectionName, reason);
    });

    client.on("message", async (message) =>
      this.handleIncomingMessage(message, connectionName)
    );
  }

  async handleDisconnect(connectionName, reason) {
    const session = this.sessions.get(connectionName);

    // If session doesn't exist, or was intentionally closed/failed auth, or already handling a reconnect cycle.
    if (
      !session ||
      session.status === "closed" ||
      session.status === "closed_forced" ||
      session.status === "auth_failed"
    ) {
      logger.info(
        `HandleDisconnect: Session ${connectionName} not found, already closed, or auth failed. No reconnect action. Status: ${session?.status}`
      );
      return;
    }

    // If already in a reconnecting state and this is just another disconnect event for the failing client, let the existing loop handle it.
    // However, if it's a new disconnect event for a previously stable session, then proceed.
    if (
      session.isReconnecting &&
      (session.status === "reconnecting" || session.status === "initializing")
    ) {
      logger.info(
        `HandleDisconnect: Session ${connectionName} is already in a reconnect/init cycle. Ignoring duplicate disconnect event.`
      );
      return;
    }

    session.status = "reconnecting";
    session.isReconnecting = true;
    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

    logger.info(
      `Session ${connectionName} disconnected. Attempting reconnect ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}. Reason: ${reason}`
    );

    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `Failed to reconnect ${connectionName} after ${MAX_RECONNECT_ATTEMPTS} attempts. Giving up.`
      );
      session.isReconnecting = false;
      session.status = "disconnected_permanent"; // Indicate final failure
      await this.closeSession(connectionName, true); // forceClose after max attempts
      return;
    }

    // Destroy the old client instance before attempting to create a new one
    if (session.client) {
      try {
        await session.client.destroy();
        logger.info(
          `Old client for ${connectionName} destroyed before reconnect attempt ${session.reconnectAttempts}.`
        );
      } catch (e) {
        logger.error(
          { err: e },
          `Error destroying old client for ${connectionName} during reconnect prep.`
        );
      }
      session.client = null; // Clear the reference
    }

    const delay = RECONNECT_INITIAL_DELAY_MS * session.reconnectAttempts; // Simple exponential backoff
    logger.info(
      `Scheduling reconnect attempt for ${connectionName} in ${
        delay / 1000
      } seconds.`
    );

    setTimeout(async () => {
      const currentSessionState = this.sessions.get(connectionName);
      // Check if session still exists and is still marked for reconnection
      if (!currentSessionState || !currentSessionState.isReconnecting) {
        logger.info(
          `Reconnect attempt for ${connectionName} aborted: Session removed or reconnection flag cleared (e.g., QR shown, or manually closed).`
        );
        return;
      }
      try {
        logger.info(
          `Executing scheduled reconnect for ${connectionName} (Attempt ${currentSessionState.reconnectAttempts})`
        );
        await this.initializeSession(
          connectionName,
          currentSessionState.systemPromptName,
          currentSessionState.userId,
          true
        );
        // If initializeSession succeeds, it (or subsequent ready/auth events) will reset isReconnecting & reconnectAttempts.
      } catch (error) {
        logger.error(
          { err: error },
          `Scheduled reconnect attempt ${currentSessionState.reconnectAttempts} for ${connectionName} failed during initializeSession.`
        );
        // If initializeSession itself fails during a retry, the 'disconnected' event might not fire again immediately.
        // We need to ensure the loop continues or stops.
        // We can call handleDisconnect again to re-evaluate, but this must be done carefully to avoid tight loops.
        // For now, if initializeSession throws, the error is logged. The next 'disconnected' event (if the broken client causes one)
        // or a manual intervention would be the next step. A more advanced system might have a max duration for the 'reconnecting' state.
        // Let's assume that if init fails, it might eventually lead to another 'disconnected' or the user intervenes.
        // The `isReconnecting` flag stays true, so if another disconnect event happens, `handleDisconnect` will pick it up.
        // If `initializeSession` failed catastrophically, it should have cleaned up its own client.
      }
    }, delay);
  }

  async handleIncomingMessage(message, connectionName) {
    if (message.fromMe || message.from === "status@broadcast") return;
    // Basic check, more detailed check inside the try block
    const currentSessionCheck = this.sessions.get(connectionName);
    if (
      !currentSessionCheck ||
      !["connected", "authenticated"].includes(currentSessionCheck.status)
    ) {
      logger.warn(
        `Message for ${connectionName} from ${message.from} received but session not in connected/authenticated state (Status: ${currentSessionCheck?.status}). Ignoring.`
      );
      return;
    }

    logger.info(
      `Service: Message received for ${connectionName} from ${message.from}`
    );

    const currentSession = this.sessions.get(connectionName); // Re-fetch, though likely same
    if (
      !currentSession ||
      !currentSession.aiInstance ||
      !currentSession.userId ||
      !currentSession.systemPromptId
    ) {
      logger.error(
        `Service: Critical - Session data invalid for '${connectionName}' on message event. (AI: ${!!currentSession?.aiInstance}, UserID: ${!!currentSession?.userId}, PromptID: ${!!currentSession?.systemPromptId})`
      );
      try {
        await message.reply(
          "Sorry, the AI service for this connection is not properly configured. Please contact support."
        );
      } catch (replyErr) {
        logger.error(
          { err: replyErr },
          `Failed to send config error reply for ${connectionName}`
        );
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
            "metadata.userName": userName,
            messages: [],
          },
          $set: {
            "metadata.lastActive": new Date(),
            "metadata.userName": userName,
          }, // Ensure userName is updated
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
            userId: userId,
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
        await message.reply(
          "Sorry, I encountered an error processing your message."
        );
      } catch (replyErr) {
        logger.error(
          { err: replyErr },
          `Failed to send processing error reply for ${connectionName}`
        );
      }
    }
  }

  async cleanupSessionResources(connectionName, isPuppeteerTimeout = false) {
    const session = this.sessions.get(connectionName);
    if (session) {
      if (session.client) {
        if (isPuppeteerTimeout) {
          logger.warn(
            `Puppeteer timeout for ${connectionName}, client.destroy() will be skipped to avoid hanging.`
          );
        } else {
          try {
            await session.client.destroy();
            logger.info(
              `Service: Client for '${connectionName}' destroyed during resource cleanup.`
            );
          } catch (destroyError) {
            logger.error(
              { err: destroyError, connectionName },
              `Service: Error destroying client during resource cleanup.`
            );
          }
        }
        session.client = null; // Clear client reference
      }
      if (session.aiInstance?.closeMcpClients) {
        try {
          await session.aiInstance.closeMcpClients();
          logger.info(
            `MCP Clients closed for ${connectionName} during resource cleanup.`
          );
        } catch (e) {
          logger.error(
            { err: e, connectionName },
            "Error closing MCP clients during resource cleanup."
          );
        }
      }
      // Only delete from map if not actively trying to reconnect or if it's a final "giving up" state
      if (
        !session.isReconnecting ||
        session.status === "disconnected_permanent" ||
        session.status === "closed_forced" ||
        session.status === "auth_failed"
      ) {
        this.sessions.delete(connectionName);
        logger.info(
          `Service: Session '${connectionName}' removed from map during resource cleanup.`
        );
      } else {
        logger.info(
          `Service: Resources partially cleaned for '${connectionName}'. Session kept in map as isReconnecting=${session.isReconnecting}, status=${session.status}.`
        );
      }
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
    if (session.status !== "qr_ready" || !session.qr) {
      logger.warn(
        `Service: QR code not ready or invalid for '${connectionName}'. Status: ${session.status}.`
      );
      return null;
    }
    return session.qr;
  }

  async getStatus(connectionName) {
    const session = this.sessions.get(connectionName);
    return session ? session.status : "not_found";
  }

  async sendMessage(connectionName, to, messageText) {
    const session = this.sessions.get(connectionName);
    if (
      !session ||
      !session.client ||
      !["connected", "authenticated"].includes(session.status)
    ) {
      throw new Error(
        `WhatsApp client for '${connectionName}' is not ready (status: ${
          session?.status || "N/A"
        }). Cannot send message.`
      );
    }
    logger.info(
      { connectionName, to },
      `Service: Sending message via '${connectionName}'.`
    );
    return session.client.sendMessage(to, messageText);
  }

  async closeSession(connectionName, forceClose = false) {
    logger.info(
      `Service: Attempting to close connection: '${connectionName}'. Force close: ${forceClose}`
    );
    const session = this.sessions.get(connectionName);

    if (session) {
      session.isReconnecting = false; // Explicitly stop any reconnection attempts
      session.status = forceClose ? "closed_forced" : "closing";

      if (session.client) {
        try {
          if (!forceClose && typeof session.client.logout === "function") {
            // Check if logout exists
            await session.client.logout();
            logger.info(
              `Service: WhatsApp client logged out for '${connectionName}'.`
            );
          } else if (forceClose) {
            logger.info(
              `Service: Force close, skipping logout for '${connectionName}'.`
            );
          }
        } catch (logoutError) {
          logger.error(
            { err: logoutError, connectionName },
            `Error logging out client for '${connectionName}'. Proceeding to destroy.`
          );
        }
        try {
          if (typeof session.client.destroy === "function") {
            // Check if destroy exists
            await session.client.destroy();
            logger.info(
              `Service: WhatsApp client destroyed for '${connectionName}'.`
            );
          }
        } catch (destroyError) {
          logger.error(
            { err: destroyError, connectionName },
            `Error destroying client for '${connectionName}'.`
          );
        }
        session.client = null; // Clear client reference
      }

      if (
        session.aiInstance &&
        typeof session.aiInstance.closeMcpClients === "function"
      ) {
        try {
          await session.aiInstance.closeMcpClients();
          logger.info(
            `Service: AI MCP clients closed for '${connectionName}'.`
          );
        } catch (aiCloseError) {
          logger.error(
            { err: aiCloseError, connectionName },
            `Error closing AI MCP clients for '${connectionName}'.`
          );
        }
      }
      // Final removal from map
      this.sessions.delete(connectionName);
      logger.info(
        `Service: Connection '${connectionName}' fully closed, resources cleaned, and removed from map.`
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
