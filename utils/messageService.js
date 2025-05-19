// messageService.js
import Chat from "../models/chatModel.js";
// User model is not directly used in this snippet but often is in full service, keeping for context
// import User from "../models/userModel.js";
import { logTokenUsage } from "./tokenUsageService.js";
// SystemPrompt model is not directly used in this snippet, keeping for context
// import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";
import { isUrl, normalizeDbMessageContentForAI } from "./chatUtils.js"; // UPDATED IMPORT
import { sessions } from "./sessionService.js";
// URL is now imported in chatUtils.js for normalizeDbMessageContentForAI

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
      system: systemPromptText,
      messages: messagesForAI,
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

    const assistantResponseText =
      aiResponse.text ?? "No text response from AI.";
    chat.messages.push({
      role: "assistant",
      content: assistantResponseText,
      timestamp: new Date(),
      status: "sent",
    });
    chat.updatedAt = new Date();
    await chat.save();

    return {
      text: assistantResponseText,
      toolCalls: aiResponse.toolCalls,
      usage: aiResponse.usage,
    };
  } catch (error) {
    const errorContext = {
      err: {
        message: error.message,
        stack: error.stack,
        status: error.status,
        ...(error.cause && { cause: error.cause }),
        ...(error.type && { type: error.type }),
      },
      sessionId,
      userId: userIdForTokenBilling,
      source: "webapp",
    };

    logger.error(
      errorContext,
      `ChatService: Error processing webapp message: ${error.message}`
    );

    if (error.status) throw error;
    const serviceError = new Error(
      "An internal error occurred while processing your message."
    );
    serviceError.status = 500;
    throw serviceError;
  }
};

export { processMessage };
