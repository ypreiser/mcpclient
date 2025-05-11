import express from "express";
import Chat from "../models/chatModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import { initializeAI } from "../mcpClient.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Store active AI instances per session (sessionId -> aiInstance)
// This is still in-memory for this example. For true production with multiple server instances,
// this would need a distributed cache (like Redis) or AI would be re-initialized per request,
// if initialization is lightweight enough. For now, we assume single server instance or sticky sessions.
const activeAISessions = new Map();

// Helper to get or initialize AI for a session
async function getAIForSession(sessionId, systemName) {
  if (activeAISessions.has(sessionId)) {
    return activeAISessions.get(sessionId);
  }

  if (!systemName) {
    // Fallback to a default system prompt or handle error
    // For this example, let's assume a default if none is provided during session start
    // This logic might need refinement based on application requirements
    const defaultPromptName = process.env.DEFAULT_WEB_CHAT_PROMPT || "DefaultPrompt"; // Ensure this default exists
    logger.warn(`No systemName for session ${sessionId}, using default: ${defaultPromptName}`);
    systemName = defaultPromptName;
  }
  
  const systemPromptDoc = await SystemPrompt.findOne({ name: systemName });
  if (!systemPromptDoc) {
    throw new Error(`System prompt '${systemName}' not found for web chat.`);
  }
  
  const aiInstance = await initializeAI(systemName);
  aiInstance.systemPromptText = systemPromptToNaturalLanguage(systemPromptDoc.toObject());
  activeAISessions.set(sessionId, aiInstance);
  return aiInstance;
}


// Start a new chat session (optionally with a specific system prompt)
router.post("/start", async (req, res, next) => {
  try {
    const { uuidv4 } = req.app.locals;
    const sessionId = uuidv4();
    const { systemName } = req.body; // Client can specify system prompt name

    logger.info({ sessionId, systemName }, "Starting new web chat session");

    // Pre-initialize AI for the session if systemName is provided
    // Otherwise, it will be initialized on the first message using a default.
    if (systemName) {
        await getAIForSession(sessionId, systemName); // This populates activeAISessions
    }
    // No chat history in DB until first message

    return res.json({ sessionId });
  } catch (error) {
    logger.error({ err: error }, "Error creating web chat conversation:");
    next(error);
  }
});


// Handle chat messages
router.post("/message", async (req, res, next) => {
  const { sessionId, message, systemName } = req.body; // systemName can be passed to ensure AI is correct
  
  logger.info({ sessionId, messageBody: message }, "Received web chat message");

  if (!sessionId || !message) {
    return res.status(400).json({ error: "Session ID and message are required" });
  }

  try {
    const ai = await getAIForSession(sessionId, systemName); // Ensures AI is initialized
    const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } = ai;

    let conversation = await Chat.findOne({ sessionId: sessionId, source: "webapp" });
    if (!conversation) {
      conversation = new Chat({
        sessionId,
        source: "webapp",
        metadata: { userName: `WebAppUser-${sessionId.substring(0,6)}` }, // Simple default username
        messages: [],
      });
    }

    const userMessageEntry = { role: "user", content: message, timestamp: new Date() };
    conversation.messages.push(userMessageEntry);

    // Prepare AI context from stored messages
    // For production, limit the number of messages sent to the AI
    const MAX_AI_HISTORY = 20; // Example: last 20 messages (user + assistant)
    const aiMessages = conversation.messages
        .slice(-MAX_AI_HISTORY)
        .map(msg => ({ role: msg.role, content: msg.content }));


    const response = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      maxSteps: 10,
      system: systemPromptText,
      messages: aiMessages,
    });
    
    const assistantResponseText = response.text;
    const assistantMessageEntry = { role: "assistant", content: assistantResponseText, timestamp: new Date() };
    conversation.messages.push(assistantMessageEntry);
    
    conversation.updatedAt = new Date();
    await conversation.save();

    return res.json({
      response: assistantResponseText,
      conversationHistory: conversation.messages.map(m => ({role: m.role, content: m.content, timestamp: m.timestamp})), // Send back simplified history
    });
  } catch (error) {
    logger.error({ err: error, sessionId }, "Error processing web chat message:");
    next(error);
  }
});

// End a chat session
router.post("/end", async (req, res, next) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }
  try {
    logger.info({ sessionId }, "Ending web chat session");
    const aiInstance = activeAISessions.get(sessionId);
    if (aiInstance && aiInstance.closeMcpClients) {
        await aiInstance.closeMcpClients();
    }
    activeAISessions.delete(sessionId);
    
    // Optionally, mark chat as ended or archive it in DB
    await Chat.findOneAndUpdate(
      { sessionId: sessionId, source: "webapp" },
      { $set: { "metadata.isArchived": true, updatedAt: new Date() } },
      { new: true }
    );
    res.json({ message: "Session ended successfully" });
  } catch (error) {
    logger.error({ err: error, sessionId }, "Error ending web chat session:");
    next(error);
  }
});

// Get chat history for a session
router.get("/:sessionId/history", async (req, res, next) => {
  const { sessionId } = req.params;
  try {
    const conversation = await Chat.findOne({ sessionId: sessionId, source: "webapp" }).select("messages sessionId metadata.userName");
    if (!conversation) {
      return res.status(404).json({ error: "Chat session not found" });
    }
    res.json(conversation);
  } catch (error) {
    logger.error({ err: error, sessionId }, "Error fetching chat history:");
    next(error);
  }
});


export default router;