// --- START OF FILE chatRoute.js ---

import express from "express";
import Chat from "../models/chatModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import { systemPromptToNaturalLanguage } from "../utils/json2llm.js";
import { initializeAI } from "../mcpClient.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Store active AI instances per session (sessionId -> aiInstance)
const activeAISessions = new Map();

// Helper to get or initialize AI for a session, now checks ownership
async function getAIForSession(sessionId, systemName, userId) {
  // Validate inputs
  if (!userId) {
    logger.error(
      { sessionId, systemName },
      "User ID missing in getAIForSession call"
    );
    throw new Error("User ID is required to get AI for session.");
  }
  if (!systemName) {
    logger.error(
      { sessionId, userId },
      "System name missing in getAIForSession call"
    );
    // Decide if a default system prompt is allowed or if it's always required.
    // For strict ownership, require a name.
    throw new Error("System name is required to get AI for session.");
  }

  // Check cache first
  const cachedAI = activeAISessions.get(sessionId);
  // If cached, ensure it was initialized with the *correct* system prompt and user implicitly owned it then.
  // If systemName is provided now, we could optionally verify it matches the cached AI's systemName.
  if (cachedAI && cachedAI.validatedSystemName === systemName) {
    // logger.debug({ sessionId, systemName, userId }, "Returning cached AI instance.");
    return cachedAI;
  }
  // If cached AI exists but systemName differs or wasn't stored, we might need re-initialization or error.
  // For now, proceed to fetch/initialize if cache miss or mismatch.

  // Fetch the system prompt AND verify ownership in a single query
  const systemPromptDoc = await SystemPrompt.findOne({
    name: systemName,
    userId: userId, // <<< Authorization check here!
  });

  if (!systemPromptDoc) {
    // To give a better error, check if the prompt exists at all
    const promptExists = await SystemPrompt.exists({ name: systemName });
    if (promptExists) {
      // Prompt exists, but not for this user
      logger.warn(
        { userId, systemName, sessionId },
        "Authorization Failed: User attempted to access system prompt they do not own."
      );
      // Throw a specific error type or message for the route handler to catch
      const authError = new Error(
        `Access denied: You do not have permission for system prompt '${systemName}'.`
      );
      authError.status = 403; // Forbidden
      throw authError;
    } else {
      // Prompt doesn't exist at all
      logger.warn(
        { userId, systemName, sessionId },
        "Not Found: System prompt requested does not exist."
      );
      const notFoundError = new Error(
        `System prompt '${systemName}' not found.`
      );
      notFoundError.status = 404; // Not Found
      throw notFoundError;
    }
  }

  // If found and ownership verified, initialize AI
  logger.info(
    { userId, systemName, sessionId },
    "Initializing new AI instance for session."
  );
  const aiInstance = await initializeAI(systemName); // Assuming initializeAI uses name internally
  aiInstance.systemPromptText = systemPromptToNaturalLanguage(
    systemPromptDoc.toObject()
  );
  // Store the validated systemName on the instance for consistency checks
  aiInstance.validatedSystemName = systemName;
  aiInstance.validatedUserId = userId; // Maybe store userId too?

  activeAISessions.set(sessionId, aiInstance);
  return aiInstance;
}

// Start a new chat session (requires a specific system prompt owned by the user)
router.post("/start", async (req, res, next) => {
  try {
    const { uuidv4 } = req.app.locals;
    const sessionId = uuidv4();
    const { systemName } = req.body; // Client MUST specify system prompt name
    const { user } = req; // Get authenticated user from middleware

    if (!user) {
      // This should ideally be caught by auth middleware, but double-check
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (
      !systemName ||
      typeof systemName !== "string" ||
      systemName.trim() === ""
    ) {
      return res.status(400).json({
        error:
          "System prompt name (systemName) is required and must be a non-empty string to start a chat.",
      });
    }

    logger.info(
      { sessionId, systemName, userId: user._id },
      `Attempting to start new web chat session with system prompt '${systemName}'`
    );

    // getAIForSession will now:
    // 1. Find the SystemPrompt by name AND userId (ownership check)
    // 2. Throw 404 if not found, 403 if found but not owned by user._id
    // 3. Initialize AI and cache it if successful
    await getAIForSession(sessionId, systemName, user._id);

    // If the above line doesn't throw, the user is authorized for this system prompt.
    logger.info(
      { sessionId, systemName, userId: user._id },
      "Successfully authorized and initialized AI for new web chat session"
    );

    // Optionally: Create the Chat document here to store metadata immediately
    // const newChat = new Chat({
    //     userId: user._id,
    //     sessionId,
    //     source: "webapp",
    //     metadata: { systemPromptName: systemName }, // Store the validated name
    //     messages: [],
    // });
    // await newChat.save();
    // logger.info({ sessionId, chatId: newChat._id }, "Chat document created for session.");

    return res.json({ sessionId });
  } catch (error) {
    logger.error(
      { err: error, userId: req.user?._id, systemName: req.body?.systemName },
      "Error starting web chat session"
    );
    // Send specific HTTP status codes based on the error thrown by getAIForSession
    if (error.status === 403) {
      return res.status(403).json({ error: error.message });
    }
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    // Handle other potential errors (e.g., AI initialization failure)
    next(error); // Pass to generic error handler
  }
});

// Handle chat messages
router.post("/message", async (req, res, next) => {
  const { sessionId, message, systemName: systemNameFromRequest } = req.body; // Client might re-send systemName
  const { user } = req; // Assuming user is authenticated and req.user is set

  if (!user) {
    return res.status(401).json({ error: "User not authenticated" });
  }
  if (!sessionId || !message) {
    return res
      .status(400)
      .json({ error: "Session ID and message are required" });
  }

  logger.info(
    { sessionId, userId: user._id, systemNameFromRequest },
    "Received web chat message"
  );

  try {
    let ai;
    let sessionSystemName; // The definitive system name for this session

    // --- Determine the correct systemName for this session ---
    const cachedAI = activeAISessions.get(sessionId);

    if (
      cachedAI &&
      cachedAI.validatedSystemName &&
      cachedAI.validatedUserId === user._id.toString()
    ) {
      // Use cached AI if it exists and belongs to the current user
      sessionSystemName = cachedAI.validatedSystemName;
      logger.debug(
        { sessionId, userId: user._id },
        "Using cached AI instance."
      );

      // Optional: Strict check if client sent a *different* systemName
      if (
        systemNameFromRequest &&
        systemNameFromRequest !== sessionSystemName
      ) {
        logger.warn(
          {
            sessionId,
            userId: user._id,
            requested: systemNameFromRequest,
            actual: sessionSystemName,
          },
          "Client sent different systemName in message, ignoring and using session's systemName."
        );
        // You could choose to error out here if changing prompts isn't allowed:
        // return res.status(400).json({ error: `Session is fixed to system prompt '${sessionSystemName}'. Cannot use '${systemNameFromRequest}'.` });
      }
      ai = cachedAI;
    } else {
      // AI not cached, or cache belongs to different user (shouldn't happen with UUIDs), or cache missing systemName.
      // Need to determine the systemName and validate ownership again.
      // Option 1: Look up the Chat document metadata
      let conversationForLookup = await Chat.findOne({
        sessionId: sessionId,
        source: "webapp",
        userId: user._id, // Ensure we only look up chats belonging to the user
      }).select("metadata.systemPromptName");

      if (
        conversationForLookup &&
        conversationForLookup.metadata?.systemPromptName
      ) {
        sessionSystemName = conversationForLookup.metadata.systemPromptName;
        logger.debug(
          { sessionId, userId: user._id, systemName: sessionSystemName },
          "Retrieved systemName from existing Chat document."
        );
      } else if (systemNameFromRequest) {
        // If no chat history or stored name, but client provided one (e.g., first message after '/start')
        sessionSystemName = systemNameFromRequest;
        logger.debug(
          { sessionId, userId: user._id, systemName: sessionSystemName },
          "Using systemName provided in the current message request."
        );
      } else {
        // Cannot determine the system prompt. This might happen if '/start' didn't store it
        // and the client didn't send it with the message.
        logger.error(
          { sessionId, userId: user._id },
          "Failed to determine system prompt for session. No cached AI, no stored name in DB, and not provided in request."
        );
        return res.status(400).json({
          error:
            "Could not determine the system prompt for this session. Ensure the session was started correctly or provide 'systemName'.",
        });
      }

      // Now get/initialize AI using the determined systemName, performing the ownership check.
      logger.debug(
        { sessionId, userId: user._id, systemName: sessionSystemName },
        "Attempting to get/initialize AI with determined systemName."
      );
      ai = await getAIForSession(sessionId, sessionSystemName, user._id);
    }

    // --- Proceed with message processing using the validated AI instance ---
    const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
      ai;

    // Find or create the chat document, ensuring it belongs to the user
    let conversation = await Chat.findOne({
      sessionId: sessionId,
      source: "webapp",
      userId: user._id, // <<< Crucial check
    });

    if (!conversation) {
      // If conversation doesn't exist for this user/session, create it.
      // Double-check session ID isn't used by another user (paranoid check, UUIDs should prevent)
      const existingChatOtherUser = await Chat.exists({
        sessionId: sessionId,
        source: "webapp",
        userId: { $ne: user._id },
      });
      if (existingChatOtherUser) {
        logger.error(
          { sessionId, userId: user._id },
          "CRITICAL: Session ID collision or unauthorized access attempt detected."
        );
        return res.status(403).json({ error: "Session ID conflict." });
      }

      logger.info(
        { sessionId, userId: user._id, systemName: sessionSystemName },
        "Creating new Chat document for session."
      );
      conversation = new Chat({
        userId: user._id,
        sessionId,
        source: "webapp",
        metadata: {
          userName: user.name || `WebAppUser-${sessionId.substring(0, 6)}`, // Use user's name if available
          systemPromptName: sessionSystemName, // Store the validated system prompt name
        },
        messages: [],
      });
    } else {
      // If conversation exists, ensure metadata is consistent (optional check)
      if (!conversation.metadata) conversation.metadata = {}; // Ensure metadata object exists
      if (conversation.metadata.systemPromptName !== sessionSystemName) {
        logger.warn(
          {
            sessionId,
            userId: user._id,
            dbName: conversation.metadata.systemPromptName,
            sessionName: sessionSystemName,
          },
          "SystemPromptName mismatch between DB and session AI. Updating DB."
        );
        conversation.metadata.systemPromptName = sessionSystemName; // Keep DB consistent
      }
      // Ensure userName is set if missing
      if (!conversation.metadata.userName && user.name) {
        conversation.metadata.userName = user.name;
      }
    }

    // Add user message
    const userMessageEntry = {
      role: "user",
      content: message,
      timestamp: new Date(),
    };
    conversation.messages.push(userMessageEntry);

    // Prepare AI context (limited history)
    const MAX_AI_HISTORY = 20;
    const aiMessages = conversation.messages
      .slice(-MAX_AI_HISTORY)
      .map((msg) => ({ role: msg.role, parts: [{ text: msg.content }] })); // Adjust format if needed for Gemini

    // Call the AI
    const response = await generateText({
      model: google(GEMINI_MODEL_NAME), // Ensure 'google' and GEMINI_MODEL_NAME are correctly imported/available from 'ai'
      tools, // Ensure 'tools' are correctly formatted and passed from 'ai'
      maxSteps: 10,
      system: systemPromptText, // Ensure systemPromptText is correctly extracted/formatted from 'ai'
      messages: aiMessages,
    });

    // Add assistant response
    const assistantResponseText = response.text ?? "Error: No text in response"; // Handle cases where response.text might be missing
    const assistantMessageEntry = {
      role: "assistant",
      content: assistantResponseText,
      timestamp: new Date(),
      // Include toolCalls if present in response: toolCalls: response.toolCalls
    };
    conversation.messages.push(assistantMessageEntry);

    // Update timestamp and save
    conversation.updatedAt = new Date();
    conversation.markModified("metadata"); // Mark modified if nested object updated
    await conversation.save();
    logger.info(
      { sessionId, userId: user._id },
      "Message processed and conversation saved."
    );

    // Return response
    return res.json({
      response: assistantResponseText,
      // Optionally return updated history, keep it simple
      // conversationHistory: conversation.messages.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
    });
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: user?._id },
      "Error processing web chat message"
    );
    // Handle specific HTTP status codes from getAIForSession or other errors
    if (error.status === 403) {
      return res.status(403).json({ error: error.message });
    }
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    next(error); // Pass to generic error handler
  }
});

// End a chat session (ensure user owns the chat being ended)
router.post("/end", async (req, res, next) => {
  const { sessionId } = req.body;
  const { user } = req;

  if (!user) {
    return res.status(401).json({ error: "User not authenticated" });
  }
  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  try {
    logger.info(
      { sessionId, userId: user._id },
      "Attempting to end web chat session"
    );

    // Find the chat first to ensure the user owns it before modifying
    const chatToEnd = await Chat.findOne({
      sessionId: sessionId,
      source: "webapp",
      userId: user._id, // <<< Ownership check
    });

    if (!chatToEnd) {
      // If chat not found for this user, maybe it ended already or belongs to someone else
      logger.warn(
        { sessionId, userId: user._id },
        "Attempt to end chat session not found or not owned by user."
      );
      // Return 404, don't reveal if it exists for another user
      return res
        .status(404)
        .json({ error: "Chat session not found or already ended." });
    }

    // Clean up AI session cache
    const aiInstance = activeAISessions.get(sessionId);
    if (aiInstance) {
      if (aiInstance.closeMcpClients) {
        // Assuming closeMcpClients is defined on the AI instance if needed
        await aiInstance.closeMcpClients();
        logger.info(
          { sessionId, userId: user._id },
          "Closed MCP clients for session."
        );
      }
      activeAISessions.delete(sessionId);
      logger.info(
        { sessionId, userId: user._id },
        "Removed AI instance from active session cache."
      );
    } else {
      logger.warn(
        { sessionId, userId: user._id },
        "No active AI instance found in cache to clean up for session."
      );
    }

    // Optionally, mark chat as ended/archived in DB
    if (!chatToEnd.metadata.isArchived) {
      chatToEnd.metadata.isArchived = true;
      chatToEnd.updatedAt = new Date();
      chatToEnd.markModified("metadata");
      await chatToEnd.save();
      logger.info(
        { sessionId, userId: user._id, chatId: chatToEnd._id },
        "Marked chat session as archived in DB."
      );
    }

    res.json({ message: "Session ended successfully" });
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: user?._id },
      "Error ending web chat session:"
    );
    next(error);
  }
});

// Get chat history for a session (ensure user owns the chat)
router.get("/:sessionId/history", async (req, res, next) => {
  const { sessionId } = req.params;
  const { user } = req;

  if (!user) {
    return res.status(401).json({ error: "User not authenticated" });
  }

  try {
    const conversation = await Chat.findOne({
      sessionId: sessionId,
      source: "webapp",
      userId: user._id, // <<< Ownership check
    }).select(
      "messages sessionId metadata.userName metadata.systemPromptName createdAt updatedAt"
    ); // Select desired fields

    if (!conversation) {
      return res
        .status(404)
        .json({ error: "Chat session not found for this user." });
    }
    res.json(conversation);
  } catch (error) {
    logger.error(
      { err: error, sessionId, userId: user?._id },
      "Error fetching chat history:"
    );
    next(error);
  }
});

export default router;
