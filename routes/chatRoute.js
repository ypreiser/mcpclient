import express from "express";
import Chat from "../models/chatModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import { initializeAI } from "../mcpClient.js";

const router = express.Router();

// In-memory conversation histories (for demo; use DB in production)
const conversationHistories = new Map();

// Create a new chat session
router.post("/start", async (req, res) => {
  try {
    const { uuidv4 } = req.app.locals;
    const sessionId = uuidv4();
    console.log("Starting new chat session", sessionId);
    conversationHistories.set(sessionId, []);
    return res.json({ sessionId });
  } catch (error) {
    console.error("Error creating conversation:", error);
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

// Start a new chat session with a specific system prompt
router.post("/:systemname/start", async (req, res) => {
  console.log(
    "Starting new chat session with system prompt",
    req.params.systemname
  );
  try {
    const { uuidv4 } = req.app.locals;
    const sessionId = uuidv4();
    const { systemname } = req.params;

    // Fetch the system prompt by name
    const systemPromptDoc = await SystemPrompt.findOne({ name: systemname });
    if (!systemPromptDoc) {
      return res.status(404).json({ error: "System prompt not found" });
    }

    // Initialize AI with the specific system prompt
    const aiDependencies = await initializeAI(systemname);
    req.app.locals.ai = {
      ...aiDependencies,
      systemPrompt: systemPromptDoc.identity,
    };

    // Convert to natural language
    const systemPromptText = systemPromptToNaturalLanguage(systemPromptDoc);

    // Store session with its prompt in memory
    conversationHistories.set(sessionId, {
      messages: [],
      systemPrompt: systemPromptText,
    });

    return res.json({ sessionId });
  } catch (error) {
    console.error("Error creating conversation:", error);
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

// Handle chat messages
router.post("/message", async (req, res) => {
  const { sessionId, message } = req.body;
  console.log("Received message from client", sessionId, message);
  if (!sessionId || !message) {
    return res
      .status(400)
      .json({ error: "Session ID and message are required" });
  }
  const session = conversationHistories.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found in memory" });
  }
  try {
    // Ensure conversation exists in MongoDB
    let conversation = await Chat.findOne({ sessionId });
    if (!conversation) {
      conversation = new Chat({ sessionId, messages: [] });
      await conversation.save();
    }
    // Add user message to in-memory history
    const userMessage = {
      role: "user",
      content: message,
      timestamp: new Date(),
    };
    session.messages.push(userMessage);
    // Save user message to MongoDB
    await Chat.findOneAndUpdate(
      { sessionId },
      { $push: { messages: userMessage }, $set: { updatedAt: new Date() } },
      { new: true }
    );
    // Generate response using Gemini
    const { tools, google, GEMINI_MODEL_NAME, generateText } =
      req.app.locals.ai;
    const response = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      maxSteps: 10,
      system: session.systemPrompt,
      messages: session.messages,
    });
    const assistantResponse = response.text;
    // Add assistant response to conversation history
    const assistantMessage = {
      role: "assistant",
      content: assistantResponse,
      timestamp: new Date(),
    };
    session.messages.push(assistantMessage);
    // Save assistant message to MongoDB
    await Chat.findOneAndUpdate(
      { sessionId },
      {
        $push: { messages: assistantMessage },
        $set: { updatedAt: new Date() },
      },
      { new: true }
    );
    return res.json({
      response: assistantResponse,
      conversationHistory: session.messages,
    });
  } catch (error) {
    console.error("Error processing message:", error);
    return res.status(500).json({ error: "Failed to process message" });
  }
});

// End a chat session
router.post("/end", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }
  try {
    conversationHistories.delete(sessionId);
    await Chat.findOneAndUpdate(
      { sessionId },
      { $set: { updatedAt: new Date() } },
      { new: true }
    );
    res.json({ message: "Session ended successfully" });
  } catch (error) {
    console.error("Error ending session:", error);
    res.status(500).json({ error: "Failed to end session" });
  }
});

export default router;
