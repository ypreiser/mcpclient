// whatsappService.js
import pkg from "whatsapp-web.js";
import { MongoStore } from "wwebjs-mongo";
import mongoose from "mongoose";
import { initializeAI } from "../mcpClient.js";
import WhatsAppCredentials from "../models/WhatsAppCredentials.js";
import SystemPrompt from "../models/systemPromptModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";

const { Client, RemoteAuth } = pkg;

const store = new MongoStore({
  mongoose: mongoose,
  collectionName: "whatsapp_sessions", // Ensure this collection exists and is writable
});

class WhatsAppService {
  constructor() {
    this.sessions = new Map();
    this.aiInstances = new Map(); // Store AI instances per session
  }

  async initializeSession(sessionId, systemPromptName) {
    console.log(
      "Service: Initializing WhatsApp session with ID:",
      sessionId,
      "and prompt:",
      systemPromptName
    );
    try {
      // Fetch the system prompt by name
      const systemPromptDoc = await SystemPrompt.findOne({
        name: systemPromptName,
      });
      if (!systemPromptDoc) {
        throw new Error("System prompt not found");
      }

      // Initialize AI with the specific system prompt
      const aiDependencies = await initializeAI(systemPromptName);
      const systemPromptText = systemPromptToNaturalLanguage(systemPromptDoc);

      // Store AI instance for this session with all required dependencies
      this.aiInstances.set(sessionId, {
        ...aiDependencies,
        systemPrompt: systemPromptText,
        messages: [], // Initialize empty message history
      });

      const client = new Client({
        clientId: sessionId, // Important for RemoteAuth to distinguish sessions
        authStrategy: new RemoteAuth({
          store: store,
          backupSyncIntervalMs: 300000,
          dataPath: `./.wwebjs_auth/session-${sessionId}`, // Ensure unique path per session if not using clientId for store segregation
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
            "--single-process", // Often helpful in resource-constrained environments
            "--disable-gpu",
          ],
        },
        webVersion: "2.2409.2", // Be mindful that this can become outdated
        webVersionCache: {
          type: "local",
          path: "./.wwebjs_cache",
        },
      });

      // Create session entry in the map BEFORE initializing or attaching listeners
      // This ensures event handlers can find and update this session entry.
      this.sessions.set(sessionId, {
        client,
        status: "initializing",
        qr: null, // Initialize QR as null
        systemPromptName, // Store if needed
      });
      console.log(
        "Service: Initial session entry created for",
        sessionId,
        this.sessions.get(sessionId)
      );

      client.on("qr", (qr) => {
        console.log(
          "Service: QR Code received for session:",
          sessionId,
          "QR data length:",
          qr ? qr.length : "N/A"
        );
        // console.log("Service: QR Data:", qr); // Uncomment for debugging if QR is short/invalid

        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          this.sessions.set(sessionId, {
            ...currentSession,
            qr,
            status: "qr_ready",
          });
          console.log(
            "Service: Session updated with QR code for",
            sessionId,
            "New status: qr_ready"
          );
        } else {
          console.error(
            "Service Critical Error: Session",
            sessionId,
            "not found in map when 'qr' event fired."
          );
        }
      });

      client.on("ready", () => {
        console.log(
          "Service: WhatsApp client is ready for session:",
          sessionId
        );
        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          this.sessions.set(sessionId, {
            ...currentSession,
            status: "connected",
            qr: null, // QR code is no longer needed once connected
          });
          console.log(
            "Service: Session status updated to connected for",
            sessionId
          );
        }
      });

      client.on("authenticated", () => {
        console.log(
          "Service: WhatsApp client authenticated for session:",
          sessionId
        );
        // You might want to update status here too, e.g., "authenticated"
        // and clear QR if not already done by "ready"
        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          this.sessions.set(sessionId, {
            ...currentSession,
            status: "authenticated", // Or keep as "connected" if "ready" is preferred
            qr: null,
          });
        }
      });

      client.on("auth_failure", (error) => {
        console.error(
          "Service: WhatsApp authentication failed for session:",
          sessionId,
          "Error:",
          error
        );
        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          this.sessions.set(sessionId, {
            ...currentSession,
            status: "auth_failed",
          });
        }
      });

      client.on("disconnected", (reason) => {
        console.log(
          "Service: WhatsApp client disconnected for session:",
          sessionId,
          "Reason:",
          reason
        );
        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          this.sessions.set(sessionId, {
            ...currentSession,
            status: "disconnected",
          });
          // Optionally, attempt to clean up or re-initialize, or rely on user to reconnect
        }
      });

      client.on("message", async (message) => {
        if (!message.fromMe && message.from !== "status@broadcast") {
          try {
            console.log(
              "Service: Received message:",
              message.body,
              "from:",
              message.from,
              "for session:",
              sessionId
            );

            const sessionAI = this.aiInstances.get(sessionId);
            if (sessionAI) {
              const { tools, google, GEMINI_MODEL_NAME, generateText } =
                sessionAI;

              // Add user message to history
              sessionAI.messages.push({
                role: "user",
                content: message.body,
                timestamp: new Date(),
              });

              // Generate response
              const response = await generateText({
                model: google(GEMINI_MODEL_NAME),
                tools,
                maxSteps: 10,
                system: sessionAI.systemPrompt,
                messages: sessionAI.messages,
              });

              // Add assistant response to history
              sessionAI.messages.push({
                role: "assistant",
                content: response.text,
                timestamp: new Date(),
              });

              await message.reply(response.text);
              console.log(
                "Service: Sent AI response to:",
                message.from,
                "for session:",
                sessionId
              );
            } else {
              console.error(
                "Service: AI not initialized for session",
                sessionId,
                "cannot process message."
              );
              await message.reply(
                "Sorry, the AI is not available at the moment."
              );
            }
          } catch (error) {
            console.error(
              "Service: Error processing message for session",
              sessionId,
              ":",
              error
            );
            await message.reply(
              "Sorry, I encountered an error processing your message."
            );
          }
        }
      });

      console.log(
        "Service: Starting WhatsApp client.initialize() for session:",
        sessionId
      );
      await client.initialize(); // This is an async call that will trigger the events above
      console.log(
        "Service: client.initialize() promise resolved for session:",
        sessionId
      );
      // The session status should have been updated by one of the events ('qr', 'ready', 'auth_failure') by now.
      // The function returns; the QR code (if generated) is in the session map.
    } catch (error) {
      console.error(
        "Service: Error in initializeSession for session ID",
        sessionId,
        ":",
        error
      );
      // Clean up if session was partially added
      if (this.sessions.has(sessionId)) {
        const sessionToClean = this.sessions.get(sessionId);
        if (sessionToClean && sessionToClean.client) {
          try {
            await sessionToClean.client.destroy();
          } catch (destroyError) {
            console.error(
              "Service: Error destroying client during cleanup for session",
              sessionId,
              ":",
              destroyError
            );
          }
        }
        this.sessions.delete(sessionId);
        console.log(
          "Service: Cleaned up session entry for",
          sessionId,
          "due to initialization error."
        );
      }
      throw error; // Re-throw to be caught by the route handler
    }
  }

  async getQRCode(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(
        "Service: getQRCode called for non-existent session:",
        sessionId
      );
      // throw new Error("Session not found"); // Or return null to let route handle 404
      return null;
    }
    console.log(
      "Service: Getting QR Code for session:",
      sessionId,
      "Current status:",
      session.status,
      "QR available:",
      !!session.qr
    );
    return session.qr; // This will be null until the 'qr' event updates it
  }

  async getStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(
        "Service: getStatus called for non-existent session:",
        sessionId
      );
      return "not_found"; // Or throw error
    }
    console.log(
      "Service: Getting status for session:",
      sessionId,
      "Status:",
      session.status
    );
    return session.status || "unknown";
  }

  async sendMessage(sessionId, to, message) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.client) {
      throw new Error("Session not found or client not available");
    }
    if (
      session.status !== "connected" &&
      session.status !== "authenticated" &&
      session.status !== "ready"
    ) {
      // 'ready' is also a connected state
      console.warn(
        "Service: Attempt to send message while client not connected. Session:",
        sessionId,
        "Status:",
        session.status
      );
      throw new Error(
        `WhatsApp client is not connected (status: ${session.status})`
      );
    }
    console.log("Service: Sending message via session:", sessionId, "To:", to);
    return session.client.sendMessage(to, message);
  }

  async closeSession(sessionId) {
    console.log("Service: Attempting to close session:", sessionId);
    const session = this.sessions.get(sessionId);
    if (session && session.client) {
      try {
        await session.client.logout();
        console.log(
          "Service: WhatsApp client logged out for session:",
          sessionId
        );
      } catch (error) {
        console.error(
          "Service: Error logging out WhatsApp client for session",
          sessionId,
          ":",
          error,
          "Attempting destroy."
        );
      }
      try {
        await session.client.destroy();
        console.log(
          "Service: WhatsApp client destroyed for session:",
          sessionId
        );
      } catch (error) {
        console.error(
          "Service: Error destroying WhatsApp client for session",
          sessionId,
          ":",
          error
        );
      }
    }

    // Clean up AI instance
    this.aiInstances.delete(sessionId);

    // Remove from credentials model
    try {
      await WhatsAppCredentials.deleteOne({ sessionId: sessionId });
      console.log(
        "Service: Removed credentials from MongoDB for session:",
        sessionId
      );
    } catch (dbError) {
      console.error(
        "Service: Error removing credentials from MongoDB for session",
        sessionId,
        ":",
        dbError
      );
    }

    this.sessions.delete(sessionId);
    console.log("Service: Session removed from map:", sessionId);
  }
}

export default new WhatsAppService();
