import express from "express";
import { v4 as uuidv4 } from "uuid";
import SystemPrompt from "../models/systemPromptModel.js";
import Chat from "../models/chatModel.js";
import logger from "../utils/logger.js";
import chatService from "../utils/chatService.js";

const router = express.Router();

// Helper: get and validate active SystemPrompt
async function getActiveSystemPrompt(systemPromptId) {
  let prompt;
  try {
    if (!systemPromptId) {
      throw new Error("System prompt ID is required.");
    }

    prompt = await SystemPrompt.findOne({
      _id: systemPromptId,
      isActive: true,
    });
    if (!prompt) {
      throw new Error("System prompt not found or not active.");
    }
  } catch (err) {
    logger.error({ err }, "Error fetching system prompt");
    throw new Error("Failed to fetch system prompt.");
  }

  return prompt;
}

// Get all active system prompts
router.get("/prompts", async (req, res) => {
  try {
    const prompts = await SystemPrompt.find({ isActive: true })
      .select("_id name description")
      .sort({ name: 1 });
    res.json(prompts);
  } catch (err) {
    logger.error({ err }, "Error fetching public prompts");
    res.status(500).json({ error: "Failed to fetch system prompts" });
  }
});

// Get chat history
router.get("/:systemPromptId/history", async (req, res) => {
  try {
    const { systemPromptId } = req.params;
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required." });
    }

    const chat = await Chat.findOne({ sessionId, systemPromptId });
    if (!chat) {
      return res.status(404).json({ error: "Chat session not found." });
    }

    res.json({
      messages: chat.messages,
      metadata: chat.metadata,
    });
  } catch (err) {
    logger.error({ err }, "Error fetching chat history");
    res.status(400).json({ error: err.message });
  }
});

// Start a new chat session
router.post("/:systemPromptId/start", async (req, res) => {
  try {
    const { systemPromptId } = req.params;
    const sessionId = uuidv4();
    const prompt = await getActiveSystemPrompt(systemPromptId);

    // Initialize session using chatService with prompt creator's userId
    await chatService.initializeSession(sessionId, prompt.name, prompt.userId);

    const chat = new Chat({
      sessionId,
      systemPromptId,
      systemPromptName: prompt.name,
      source: "webapp",
      userId: prompt.userId, // Use prompt creator's userId
      messages: [],
      metadata: { userName: "Anonymous" },
    });
    await chat.save();
    res.json({ sessionId });
  } catch (err) {
    logger.error({ err }, "Error starting public chat");
    res.status(400).json({ error: err.message });
  }
});

// Send a message
router.post("/:systemPromptId/msg", async (req, res) => {
  try {
    const { systemPromptId } = req.params;
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res
        .status(400)
        .json({ error: "Session ID and message required." });
    }
    const prompt = await getActiveSystemPrompt(systemPromptId);
    const response = await chatService.processMessage(
      sessionId,
      message,
      prompt.userId // Use prompt creator's userId
    );

    res.json({ response: response.text });
  } catch (err) {
    logger.error({ err }, "Error in public chat message");
    res.status(400).json({ error: err.message });
  }
});

// End a chat session
router.post("/:systemPromptId/end", async (req, res) => {
  try {
    const { systemPromptId } = req.params;
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "Session ID required." });
    }
    const prompt = await getActiveSystemPrompt(systemPromptId);
    let chat = await Chat.findOne({ sessionId, systemPromptId });
    if (!chat) {
      return res.status(404).json({ error: "Chat session not found." });
    }

    // End session using chatService with prompt creator's userId
    await chatService.endSession(sessionId, prompt.userId);

    res.json({ message: "Session ended." });
  } catch (err) {
    logger.error({ err }, "Error ending public chat");
    res.status(400).json({ error: err.message });
  }
});

export default router;
