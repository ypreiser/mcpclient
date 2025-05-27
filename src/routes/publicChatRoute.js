// src\routes\publicChatRoute.js
import express from "express";
import { v4 as uuidv4 } from "uuid";
import BotProfile from "../models/botProfileModel.js"; // UPDATED
import Chat from "../models/chatModel.js";
import logger from "../utils/logger.js";
import chatService from "../utils/chatService.js";
import mongoose from "mongoose"; // For ObjectId validation

const router = express.Router();

/**
 * Helper function to get and validate an active BotProfile.
 * Ensures the profile exists, is enabled, and has a valid owner for billing.
 * @param {string} botProfileId - The ObjectId of the BotProfile.
 * @returns {Promise<BotProfileDocument>} The validated BotProfile document.
 * @throws {Error} If validation fails (e.g., not found, not enabled, no owner).
 */
async function getActiveBotProfile(botProfileId) {
  if (!botProfileId || !mongoose.Types.ObjectId.isValid(botProfileId)) {
    const err = new Error("A valid Bot Profile ID is required.");
    err.status = 400; // Bad Request
    throw err;
  }

  // Populate userId to get the owner, which is needed for billing/token tracking
  const botProfileDoc = await BotProfile.findOne({
    _id: botProfileId,
    // No longer checking isPubliclyListed, only isEnabled for general operational status
  }).populate("userId", "_id"); // Select only the _id of the user

  if (!botProfileDoc) {
    const err = new Error(`Bot profile not found (ID: ${botProfileId}).`);
    err.status = 404; // Not Found
    throw err;
  }

  if (!botProfileDoc.isEnabled) {
    logger.warn(
      { botProfileId, name: botProfileDoc.name },
      "Attempt to use a disabled bot profile for public chat."
    );
    const err = new Error(
      `Bot profile '${botProfileDoc.name}' is currently disabled and cannot be used.`
    );
    err.status = 403; // Forbidden
    throw err;
  }

  if (!botProfileDoc.userId || !botProfileDoc.userId._id) {
    logger.error(
      { botProfileId, name: botProfileDoc.name },
      "BotProfile is missing a valid owner (userId). Public chat cannot proceed."
    );
    const err = new Error(
      `Bot profile '${botProfileDoc.name}' is not configured correctly (missing owner).`
    );
    err.status = 500; // Internal Server Error (configuration issue)
    throw err;
  }
  return botProfileDoc;
}

// GET /chat/profiles - Get all enabled bot profiles for public selection
// Renamed from /prompts to /profiles for clarity with BotProfile
router.get("/profiles", async (req, res, next) => {
  try {
    // Only fetch profiles that are enabled.
    // Frontend can use description and tags for display.
    const profiles = await BotProfile.find({ isEnabled: true })
      .select("_id name description tags communicationStyle")
      .sort({ name: 1 });
    res.json(profiles);
  } catch (err) {
    logger.error({ err }, "Error fetching public bot profiles");
    next(
      new Error(
        "Failed to fetch available bot profiles. Please try again later."
      )
    );
  }
});

// GET /chat/:botProfileId/history - Get chat history for a public session
router.get("/:botProfileId/history", async (req, res, next) => {
  const { botProfileId } = req.params;
  const { sessionId } = req.query;

  if (!sessionId) {
    return res
      .status(400)
      .json({ error: "Session ID is required in query parameters." });
  }
  if (!botProfileId || !mongoose.Types.ObjectId.isValid(botProfileId)) {
    return res
      .status(400)
      .json({ error: "A valid Bot Profile ID is required in the path." });
  }

  try {
    // Fetch the chat ensuring it matches the botProfileId and source
    const chat = await Chat.findOne({
      sessionId,
      botProfileId, // Ensure history is for the specified profile
      source: "webapp", // Public chats are identified by 'webapp' source
    }).populate("userId", "name email"); // Optionally populate some user details (owner of bot)

    if (!chat) {
      return res.status(404).json({
        error:
          "Chat session not found or does not match the provided bot profile.",
      });
    }

    res.json({
      messages: chat.messages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        timestamp: m.timestamp,
        status: m.status,
        _id: m._id?.toString(),
      })),
      metadata: chat.metadata,
      botProfileName: chat.botProfileName, // Send back bot name for context
      // user: chat.userId // Send back limited owner info if needed by frontend context
    });
  } catch (err) {
    logger.error(
      { err, botProfileId, sessionId },
      "Error fetching public chat history"
    );
    next(new Error("Failed to retrieve chat history."));
  }
});

// POST /chat/:botProfileId/start - Start a new public chat session
router.post("/:botProfileId/start", async (req, res, next) => {
  const { botProfileId } = req.params;
  const clientSessionId = uuidv4();

  try {
    const botProfile = await getActiveBotProfile(botProfileId); // Validates profile and gets owner ID

    await chatService.initializeSession(
      clientSessionId,
      botProfile._id,
      botProfile.userId._id // User ID of the bot owner for billing
    );

    const chat = new Chat({
      sessionId: clientSessionId,
      botProfileId: botProfile._id,
      botProfileName: botProfile.name, // Denormalize name for easier display
      source: "webapp", // Public chats
      userId: botProfile.userId._id,
      messages: [],
      metadata: {
        userName: "Public User",
        lastActive: new Date(),
        isArchived: false,
      },
    });
    await chat.save();

    logger.info(
      {
        sessionId: clientSessionId,
        botProfileId,
        botProfileName: botProfile.name,
        billedToUserId: botProfile.userId._id,
      },
      "Public chat session started successfully"
    );
    res.status(201).json({
      sessionId: clientSessionId,
      botProfileName: botProfile.name, // Send name back for frontend convenience
    });
  } catch (err) {
    logger.error({ err, botProfileId }, "Error starting public chat session");
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(new Error("Failed to start chat session. Please try again."));
  }
});

// POST /chat/:botProfileId/msg - Send a message in a public chat session
router.post("/:botProfileId/msg", async (req, res, next) => {
  const { botProfileId } = req.params;
  const { sessionId, message, attachments } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }
  const trimmedMessage = message?.trim() ?? "";
  if (
    !trimmedMessage &&
    (!attachments || !Array.isArray(attachments) || attachments.length === 0)
  ) {
    return res
      .status(400)
      .json({ error: "Message content or attachments are required." });
  }
  if (attachments && !Array.isArray(attachments)) {
    return res
      .status(400)
      .json({ error: "Attachments, if provided, must be an array." });
  }
  if (!botProfileId || !mongoose.Types.ObjectId.isValid(botProfileId)) {
    return res
      .status(400)
      .json({ error: "A valid Bot Profile ID is required in the path." });
  }

  const requestId = req.id || uuidv4(); // Assuming req.id might be set by a middleware, else generate one

  logger.info(
    {
      requestId,
      sessionId,
      botProfileId,
      messageReceived: trimmedMessage,
      attachmentsCount: attachments?.length || 0,
    },
    "PUBLIC_CHAT_MSG_REQUEST: Received data"
  );

  try {
    const botProfile = await getActiveBotProfile(botProfileId);

    const aiResponse = await chatService.processMessage(
      sessionId,
      trimmedMessage,
      botProfile.userId._id, // User ID of the bot owner for billing
      attachments || []
    );

    logger.info(
      {
        requestId,
        sessionId,
        botProfileId,
        billedToUserId: botProfile.userId._id,
        responseTextLength: aiResponse.text?.length || 0,
      },
      "PUBLIC_CHAT_MSG_REQUEST: Message processed by chatService, AI response obtained."
    );

    res.json({
      text: aiResponse.text,
      toolCalls: aiResponse.toolCalls,
    });
  } catch (err) {
    logger.error(
      {
        requestId,
        errName: err.name,
        errMsg: err.message,
        errStatus: err.status,
        sessionId,
        botProfileId,
        message: trimmedMessage,
      },
      `PUBLIC_CHAT_MSG_REQUEST: Error processing message`
    );
    if (err.status) {
      return res
        .status(err.status)
        .json({ error: err.message, details: err.details });
    }
    const clientError = new Error(
      "Failed to send message. An unexpected error occurred."
    );
    clientError.status = err.isAxiosError ? 502 : 500;
    next(clientError);
  }
});

// POST /chat/:botProfileId/end - End a public chat session
router.post("/:botProfileId/end", async (req, res, next) => {
  const { botProfileId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }
  if (!botProfileId || !mongoose.Types.ObjectId.isValid(botProfileId)) {
    return res
      .status(400)
      .json({ error: "A valid Bot Profile ID is required in the path." });
  }

  try {
    const botProfile = await getActiveBotProfile(botProfileId);

    await chatService.endSession(sessionId, botProfile.userId._id);

    logger.info(
      { sessionId, botProfileId, endedByBotOwnerId: botProfile.userId._id },
      "Public chat session ended successfully."
    );
    res.json({ message: "Chat session ended successfully." });
  } catch (err) {
    logger.error(
      { err, sessionId, botProfileId },
      "Error ending public chat session"
    );
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(new Error("Failed to end chat session."));
  }
});

export default router;
