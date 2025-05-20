// messageService.js
import Chat from "../models/chatModel.js";
// User model is not directly used in this snippet but often is in full service, keeping for context
// import User from "../models/userModel.js";
import { logTokenUsage } from "./tokenUsageService.js";
// SystemPrompt model is not directly used in this snippet, keeping for context
// import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";
import { isUrl } from "./chatUtils.js";
import { sessions } from "./sessionService.js";
import { URL } from "url"; // Import URL for validation

// Helper to normalize message content from DB for the AI SDK
function normalizeDbMessageContentForAI(dbMessage) {
  // Ensure dbMessage and dbMessage.content exist
  if (
    !dbMessage ||
    typeof dbMessage.content === "undefined" ||
    dbMessage.content === null
  ) {
    logger.warn(
      { messageId: dbMessage?._id?.toString() },
      "Historical message content is missing or null. Sending placeholder."
    );
    return [{ type: "text", text: "[System: Message content unavailable]" }];
  }

  // Case 1: dbMessage.content is already an array (multi-modal or structured text from new messages)
  if (Array.isArray(dbMessage.content)) {
    const validParts = dbMessage.content.reduce((acc, part) => {
      // Basic validation for part structure
      if (!part || typeof part.type !== "string") {
        logger.warn(
          { part, messageId: dbMessage._id?.toString() },
          "Invalid part structure in historical array message content, skipping."
        );
        return acc;
      }

      if (part.type === "text") {
        if (typeof part.text === "string" && part.text.trim() !== "") {
          acc.push({ type: "text", text: part.text });
        } else {
          logger.info(
            { part, messageId: dbMessage._id?.toString() },
            "Empty or invalid text part in historical array message content, skipping."
          );
        }
      } else if (part.type === "image") {
        if (
          typeof part.image === "string" &&
          part.image.trim() !== "" &&
          typeof part.mimeType === "string"
        ) {
          try {
            new URL(part.image); // Validate URL
            acc.push({
              type: "image",
              image: part.image,
              mimeType: part.mimeType,
            });
          } catch (e) {
            logger.warn(
              { part, messageId: dbMessage._id?.toString(), error: e.message },
              "Invalid image URL in historical array message content part, skipping."
            );
          }
        } else {
          logger.warn(
            { part, messageId: dbMessage._id?.toString() },
            "Malformed image part (non-string image, empty image URL, or missing mimeType) in historical array message content, skipping."
          );
        }
      } else if (part.type === "file") {
        // Assuming 'file' parts are structured like { type: "file", data: "URL", mimeType: "...", filename: "..." }
        if (
          typeof part.data === "string" &&
          part.data.trim() !== "" &&
          typeof part.mimeType === "string" &&
          typeof part.filename === "string"
        ) {
          try {
            new URL(part.data); // Validate URL for file data
            acc.push({
              type: "file",
              data: part.data,
              mimeType: part.mimeType,
              filename: part.filename,
            });
          } catch (e) {
            logger.warn(
              { part, messageId: dbMessage._id?.toString(), error: e.message },
              "Invalid file data URL in historical array message content part, skipping."
            );
          }
        } else {
          logger.warn(
            { part, messageId: dbMessage._id?.toString() },
            "Malformed file part in historical array message content, skipping."
          );
        }
      } else {
        // Log and skip unknown part types if any were stored
        logger.warn(
          { part, messageId: dbMessage._id?.toString() },
          "Unknown part type in historical array message content, skipping."
        );
      }
      return acc;
    }, []);

    if (validParts.length === 0) {
      logger.warn(
        {
          messageId: dbMessage._id?.toString(),
          originalContent: dbMessage.content,
        },
        "Historical array message content resulted in no valid parts after normalization. Sending placeholder."
      );
      return [
        {
          type: "text",
          text: "[System: Message content unprocessable or empty after normalization]",
        },
      ];
    }
    return validParts;
  }

  // Case 2: dbMessage.content is a string (e.g. simple text message, or assistant response)
  if (typeof dbMessage.content === "string") {
    const trimmedContent = dbMessage.content.trim();
    if (trimmedContent === "") {
      logger.info(
        { messageId: dbMessage._id?.toString() },
        "Historical string message content is empty. Sending placeholder."
      );
      // It's important that even for "empty" messages, the AI gets a validly structured part.
      return [{ type: "text", text: "[System: Message content empty]" }];
    }
    return [{ type: "text", text: trimmedContent }];
  }

  // Fallback: dbMessage.content is of an unexpected type (e.g. number, boolean)
  logger.warn(
    {
      messageId: dbMessage._id?.toString(),
      contentType: typeof dbMessage.content,
      content: dbMessage.content,
    },
    "Unexpected historical message content type. Sending placeholder."
  );
  return [
    { type: "text", text: "[System: Message content in unexpected format]" },
  ];
}

const processMessage = async (
  sessionId,
  messageContent,
  userIdForTokenBilling,
  attachments = []
) => {
  const session = sessions.get(sessionId);
  if (!session) {
    const err = new Error(
      `Chat session not found (ID: ${sessionId}). Please start a new chat.`
    );
    err.status = 404;
    throw err;
  }
  if (session.status !== "active") {
    const err = new Error(
      `Chat session '${sessionId}' is not active (status: ${session.status}).`
    );
    err.status = 400;
    throw err;
  }
  if (session.userId.toString() !== userIdForTokenBilling.toString()) {
    logger.error(
      {
        sessionId,
        messageUserId: userIdForTokenBilling,
        sessionUserId: session.userId,
      },
      "CRITICAL: User ID mismatch in processMessage for chatService. Session owner vs. message sender for billing."
    );
    const err = new Error(
      "User ID mismatch for session. Cannot process message."
    );
    err.status = 403;
    throw err;
  }

  const trimmedMessageContent = messageContent?.trim() ?? "";
  if (!trimmedMessageContent && (!attachments || attachments.length === 0)) {
    const err = new Error(
      "Message content cannot be empty if no attachments are provided."
    );
    err.status = 400;
    throw err;
  }

  const { aiInstance, systemPromptId, systemPromptName } = session;
  const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
    aiInstance;

  try {
    const chat = await Chat.findOne({
      sessionId,
      source: "webapp", // Assuming this service is for webapp, adjust if generic
      userId: userIdForTokenBilling,
    });

    if (!chat) {
      logger.error(
        { sessionId, userId: userIdForTokenBilling, source: "webapp" },
        "CRITICAL: Chat document NOT FOUND in processMessage for webapp."
      );
      const err = new Error(
        `Chat history could not be loaded for session ${sessionId}. Ensure session was started correctly.`
      );
      err.status = 404;
      throw err;
    }

    // This is for the *new* incoming message
    const newContentParts = [];
    if (trimmedMessageContent) {
      newContentParts.push({ type: "text", text: trimmedMessageContent });
    }

    const processedAttachmentsMetadata = []; // For storing in DB `attachments` field

    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (
          !att.url ||
          !att.mimeType ||
          !att.originalName ||
          !att.size || // Ensure size is present for metadata
          !isUrl(att.url) // Validates att.url is a proper string URL
        ) {
          logger.warn(
            { attachment: att, sessionId },
            `Skipping attachment due to missing/invalid essential properties (url, mimeType, originalName, size) or invalid URL format.`
          );
          // Optionally add a system note to newContentParts about the skipped attachment
          newContentParts.push({
            type: "text",
            text: `[System note: An attempt to attach a file named '${
              att.originalName || "unknown"
            }' was made, but its metadata was incomplete or its URL was invalid.]`,
          });
          continue;
        }

        // Construct AI-consumable part for the *new* message's content
        if (att.mimeType.startsWith("image/")) {
          newContentParts.push({
            type: "image",
            image: att.url, // URL from client, validated by isUrl
            mimeType: att.mimeType,
          });
        } else {
          // For other file types, ensure your AI model supports this format
          newContentParts.push({
            type: "file", // Or another type your AI model expects for generic files
            data: att.url, // URL from client, validated by isUrl
            mimeType: att.mimeType,
            filename: att.originalName,
          });
        }
        // Store metadata for the DB
        processedAttachmentsMetadata.push({
          url: att.url,
          originalName: att.originalName,
          mimeType: att.mimeType,
          size: att.size,
          uploadedAt: att.uploadedAt ? new Date(att.uploadedAt) : new Date(),
        });
        logger.info(
          {
            filename: att.originalName,
            mimeType: att.mimeType,
            url: att.url,
            sessionId,
          },
          "Attachment prepared for AI using Cloudinary URL."
        );
      }
    }

    if (newContentParts.length === 0) {
      // This case should ideally be caught by earlier validation (empty text and no valid attachments)
      const err = new Error(
        "No valid message content or processable attachments to send to AI."
      );
      err.status = 400;
      throw err;
    }

    // Add the new user message to the chat history
    chat.messages.push({
      role: "user",
      content: newContentParts, // Store the AI-ready parts array in `content`
      attachments: processedAttachmentsMetadata, // Store attachment metadata separately
      timestamp: new Date(),
      status: "sent",
    });
    chat.messageCount++;

    // Prepare messages for AI: map over historical messages and normalize their content
    // Take last 20 messages. Ensure `msg._id` is available for logging in `normalizeDbMessageContentForAI`.
    const messagesForAI = chat.messages.slice(-20).map((dbMsg) => ({
      role: dbMsg.role,
      content: normalizeDbMessageContentForAI(dbMsg), // Use the new robust normalization
      ...(dbMsg.toolCalls && { toolCalls: dbMsg.toolCalls }),
      ...(dbMsg.toolCallId && { toolCallId: dbMsg.toolCallId }),
    }));

    logger.info(
      {
        // To avoid excessively large logs, consider logging only a summary or message count
        // messagesForAI: messagesForAI, // This can be very verbose
        messageCountForAI: messagesForAI.length,
        model: GEMINI_MODEL_NAME,
        system: systemPromptText ? "Present" : "Absent",
        sessionId,
      },
      "Prepared messages for AI SDK"
    );

    const aiResponse = await generateText({
      model: google(GEMINI_MODEL_NAME),
      tools,
      system: systemPromptText, // System prompt text itself
      messages: messagesForAI, // The array of message objects
    });

    if (aiResponse.usage) {
      const { promptTokens, completionTokens } = aiResponse.usage;
      if (
        typeof promptTokens === "number" &&
        typeof completionTokens === "number"
      ) {
        await logTokenUsage({
          userIdForTokenBilling,
          systemPromptId,
          systemPromptName,
          chatId: chat._id,
          modelName: GEMINI_MODEL_NAME,
          promptTokens,
          completionTokens,
          sessionId,
          source: "webapp",
        });
      } else {
        logger.warn(
          {
            userId: userIdForTokenBilling,
            usage: aiResponse.usage,
            source: "webapp",
            sessionId,
          },
          "Invalid or missing token usage data from AI SDK for webapp chat."
        );
      }
    } else {
      logger.warn(
        { userId: userIdForTokenBilling, source: "webapp", sessionId },
        "Token usage data not available from AI SDK response for webapp chat."
      );
    }

    // For assistant responses, content is typically text.
    // If your AI can respond with multi-modal content, this needs adjustment.
    const assistantResponseText =
      aiResponse.text ?? "No text response from AI.";
    chat.messages.push({
      role: "assistant",
      content: assistantResponseText, // Store as string; normalizeDbMessageContentForAI will handle it on next turn
      timestamp: new Date(),
      status: "sent",
      // Assistant messages usually don't have 'attachments' in the same way user messages do.
      // If the assistant refers to or generates files, that's part of its 'content' or 'toolCalls'.
    });
    chat.messageCount++;
    chat.updatedAt = new Date();
    await chat.save();

    return {
      text: assistantResponseText,
      toolCalls: aiResponse.toolCalls,
      usage: aiResponse.usage,
    };
  } catch (error) {
    // Log the error with more context, including the messagesForAI if small enough or if in dev
    const errorContext = {
      err: {
        message: error.message,
        stack: error.stack,
        status: error.status,
        // Include AI SDK specific details if available and error is from AI SDK
        ...(error.cause && { cause: error.cause }),
        ...(error.type && { type: error.type }), // e.g. 'InvalidPromptError'
      },
      sessionId,
      userId: userIdForTokenBilling,
      source: "webapp",
    };
    // In development, it can be helpful to log the exact payload that caused the error
    if (
      process.env.NODE_ENV === "development" &&
      error.type === "InvalidPromptError"
    ) {
      // errorContext.messagesSentToAI = messagesForAI; // Be cautious with logging potentially large/sensitive data
    }

    logger.error(
      errorContext,
      `ChatService: Error processing webapp message: ${error.message}`
    );

    // Re-throw error with status if it's a known/custom error, otherwise a generic 500
    if (error.status) throw error;
    const serviceError = new Error(
      "An internal error occurred while processing your message."
    );
    serviceError.status = 500; // Internal Server Error
    throw serviceError;
  }
};

export { processMessage };
