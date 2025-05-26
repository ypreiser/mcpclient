// routes/publicChatRoute.js
import express from "express";
import { v4 as uuidv4 } from "uuid";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import logger from "../utils/logger.js";
import chatService from "../utils/chatService.js"; // Ensure this path is correct

const router = express.Router();

// Helper: get and validate active SystemPrompt, ensuring it has an owner
async function getActiveSystemPrompt(systemPromptId) {
  if (!systemPromptId) {
    const err = new Error("System prompt ID is required.");
    err.status = 400;
    throw err;
  }

  // Populate userId to get the owner, which is needed for billing/token tracking
  const prompt = await SystemPrompt.findOne({
    _id: systemPromptId,
    isActive: true, // Only allow active prompts for public chat
  }).populate("userId", "_id"); // Select only the _id of the user

  if (!prompt) {
    const err = new Error(
      `System prompt not found or not active (ID: ${systemPromptId}).`
    );
    err.status = 404;
    throw err;
  }

  // CRITICAL: Ensure the prompt has a valid owner.
  if (!prompt.userId || !prompt.userId._id) {
    logger.error(
      { systemPromptId, promptName: prompt.name },
      "SystemPrompt is missing a valid owner (userId). Public chat cannot proceed for this prompt."
    );
    const err = new Error(
      `System prompt '${prompt.name}' is not configured correctly (missing owner). Cannot be used for public chat.`
    );
    err.status = 500; // Internal Server Error due to configuration issue
    throw err;
  }
  return prompt;
}

// GET /chat/prompts - Get all active system prompts for public use
router.get("/prompts", async (req, res, next) => {
  try {
    const prompts = await SystemPrompt.find({ isActive: true })
      .select("_id name description") // Only select necessary fields for the client
      .sort({ name: 1 });
    res.json(prompts);
  } catch (err) {
    logger.error({ err }, "Error fetching public system prompts");
    // Pass a generic error to the global error handler
    next(
      new Error(
        "Failed to fetch available system prompts. Please try again later."
      )
    );
  }
});

// GET /chat/:systemPromptId/history - Get chat history for a public session
router.get("/:systemPromptId/history", async (req, res, next) => {
  const { systemPromptId } = req.params;
  const { sessionId } = req.query; // sessionId should be a query parameter

  if (!sessionId) {
    return res
      .status(400)
      .json({ error: "Session ID is required in query parameters." });
  }
  if (!systemPromptId) {
    return res
      .status(400)
      .json({ error: "System Prompt ID is required in path." });
  }

  try {
    // Fetch the chat ensuring it matches the systemPromptId and source
    const chat = await Chat.findOne({
      sessionId,
      systemPromptId, // Ensure history is for the specified prompt
      source: "webapp", // Public chats are identified by 'webapp' source
    });

    if (!chat) {
      return res.status(404).json({
        error:
          "Chat session not found or does not match the provided system prompt.",
      });
    }

    // Return messages and relevant metadata.
    // Frontend expects attachments to be rendered from message.content if structured for AI,
    // or from message.attachments if stored separately.
    // The chatService prepares message.content for AI.
    res.json({
      messages: chat.messages.map((m) => ({
        role: m.role,
        content: m.content, // This content is what chatService stored (string or array of parts)
        // attachments: m.attachments, // Redundant if content field structures it, but can be sent if client uses it for UI hints
        toolCalls: m.toolCalls,
        timestamp: m.timestamp,
        status: m.status,
        _id: m._id?.toString(), // Ensure _id is a string
      })),
      metadata: chat.metadata,
    });
  } catch (err) {
    logger.error(
      { err, systemPromptId, sessionId },
      "Error fetching public chat history"
    );
    next(new Error("Failed to retrieve chat history."));
  }
});

// POST /chat/:systemPromptId/start - Start a new public chat session
router.post("/:systemPromptId/start", async (req, res, next) => {
  const { systemPromptId } = req.params;
  const clientSessionId = uuidv4(); // Generate a unique session ID for this chat

  try {
    const prompt = await getActiveSystemPrompt(systemPromptId); // Validates prompt and gets owner ID

    // Initialize AI session using chatService.
    // Tokens will be billed to prompt.userId._id (owner of the system prompt).
    await chatService.initializeSession(
      clientSessionId,
      prompt._id, // Pass the ObjectId, not the name
      prompt.userId._id
    );

    // Create the chat document in the database
    const chat = new Chat({
      sessionId: clientSessionId,
      systemPromptId: prompt._id,
      systemPromptName: prompt.name,
      source: "webapp",
      userId: prompt.userId._id, // Chat is associated with the prompt owner for billing/tracking
      messages: [], // Start with no messages
      metadata: {
        userName: "Public User", // Generic username for public chats
        lastActive: new Date(),
        isArchived: false,
      },
    });
    await chat.save();

    logger.info(
      {
        sessionId: clientSessionId,
        systemPromptId,
        systemPromptName: prompt.name,
        billedToUserId: prompt.userId._id,
      },
      "Public chat session started successfully"
    );
    res.status(201).json({ sessionId: clientSessionId }); // 201 Created
  } catch (err) {
    logger.error({ err, systemPromptId }, "Error starting public chat session");
    if (err.status) {
      // If error has a status (custom error from getActiveSystemPrompt or chatService)
      return res.status(err.status).json({ error: err.message });
    }
    next(new Error("Failed to start chat session. Please try again.")); // Generic error
  }
});

// POST /chat/:systemPromptId/msg - Send a message in a public chat session
router.post("/:systemPromptId/msg", async (req, res, next) => {
  const { systemPromptId } = req.params;
  // `message` is the text part, `attachments` is an array of file metadata objects from client
  const { sessionId, message, attachments } = req.body;

  // --- Input Validation ---
  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }
  const trimmedMessage = message?.trim() ?? "";
  // A message must have either text content or at least one attachment.
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

  // Log received data for debugging, especially the attachments structure
  logger.info(
    {
      requestId: req.id, // Assuming you have a request ID middleware
      sessionId,
      systemPromptId,
      messageReceived: trimmedMessage,
      attachmentsCount: attachments ? attachments.length : 0,
      // Log structure of the first attachment if present, to verify client format
      firstAttachmentDetail:
        attachments && attachments.length > 0 ? attachments[0] : "N/A",
    },
    "PUBLIC_CHAT_MSG_REQUEST: Received data"
  );

  try {
    const prompt = await getActiveSystemPrompt(systemPromptId); // Validates prompt and gets owner ID

    // Process message using chatService.
    // Tokens will be billed to prompt.userId._id (owner of the system prompt).
    const aiResponse = await chatService.processMessage(
      sessionId,
      trimmedMessage, // Pass the text message content
      prompt.userId._id, // User ID of the prompt owner for billing
      attachments || [] // Pass the attachments array (or empty array if undefined)
    );

    logger.info(
      {
        requestId: req.id,
        sessionId,
        systemPromptId,
        billedToUserId: prompt.userId._id,
        aiResponseTextLength: aiResponse.text?.length || 0,
      },
      "PUBLIC_CHAT_MSG_REQUEST: Message processed by chatService, AI response obtained."
    );

    // Send back the AI's direct response.
    // Client can fetch full history if needed, but this reduces payload size for msg endpoint.
    res.json({
      text: aiResponse.text,
      toolCalls: aiResponse.toolCalls,
      // usage: aiResponse.usage, // Optionally include usage if client needs it
    });
  } catch (err) {
    logger.error(
      {
        requestId: req.id,
        err,
        sessionId,
        systemPromptId,
        message: trimmedMessage,
        attachmentsCount: attachments?.length,
      },
      `PUBLIC_CHAT_MSG_REQUEST: Error processing message: ${err.message}`
    );
    if (err.status) {
      // If it's an error with a pre-defined status (e.g., from chatService validation)
      return res
        .status(err.status)
        .json({ error: err.message, details: err.details });
    }
    // For other errors, pass a generic message to the client
    const clientError = new Error(
      "Failed to send message. An unexpected error occurred."
    );
    // err.isAxiosError might indicate issues calling downstream services (like AI SDK)
    clientError.status = err.isAxiosError ? 502 : 500; // Bad Gateway for upstream issues
    next(clientError); // Pass to global error handler
  }
});

// POST /chat/:systemPromptId/end - End a public chat session
router.post("/:systemPromptId/end", async (req, res, next) => {
  const { systemPromptId } = req.params;
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }

  try {
    const prompt = await getActiveSystemPrompt(systemPromptId); // Validates prompt and gets owner ID

    await chatService.endSession(sessionId, prompt.userId._id);

    logger.info(
      { sessionId, systemPromptId, endedByPromptOwner: prompt.userId._id },
      "Public chat session ended successfully."
    );
    res.json({ message: "Chat session ended successfully." });
  } catch (err) {
    logger.error(
      { err, sessionId, systemPromptId },
      "Error ending public chat session"
    );
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    next(new Error("Failed to end chat session."));
  }
});

export default router;
