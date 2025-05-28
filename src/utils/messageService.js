// src\utils\messageService.js
import { generateText } from "ai"; // <<<< ADD THIS IMPORT
import Chat from "../models/chatModel.js";
import { logTokenUsage } from "./tokenUsageService.js";
import logger from "../utils/logger.js";
import { isUrl } from "./chatUtils.js";
import { sessions } from "./sessionService.js"; // Assuming this is how sessions map is accessed if needed directly
import { URL } from "url";
import { normalizeDbMessageContentForAI } from "./messageContentUtils.js"; // <<<< IMPORTED

const processMessage = async (
  sessionId,
  messageContent,
  userIdForTokenBilling,
  attachments = []
) => {
  const session = sessions.get(sessionId); // Get session from sessionService
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
      "CRITICAL: User ID mismatch in processMessage for chatService."
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

  const { aiInstance, botProfileId, botProfileName } = session;
  // Destructure AI instance properties, NOT including generateText
  const { tools, google, GEMINI_MODEL_NAME, systemPromptText } = aiInstance; // <<< generateText REMOVED from here

  try {
    const chat = await Chat.findOne({
      sessionId,
      source: "webapp",
      userId: userIdForTokenBilling,
    });

    if (!chat) {
      logger.error(
        { sessionId, userId: userIdForTokenBilling, source: "webapp" },
        "CRITICAL: Chat document NOT FOUND in processMessage."
      );
      const err = new Error(
        `Chat history could not be loaded for session ${sessionId}.`
      );
      err.status = 404;
      throw err;
    }

    const newContentParts = [];
    if (trimmedMessageContent) {
      newContentParts.push({ type: "text", text: trimmedMessageContent });
    }

    const processedAttachmentsMetadata = [];
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        if (
          !att.url ||
          !att.mimeType ||
          !att.originalName ||
          !att.size ||
          !isUrl(att.url)
        ) {
          logger.warn(
            { attachment: att, sessionId },
            `Skipping attachment due to missing/invalid properties or invalid URL.`
          );
          newContentParts.push({
            type: "text",
            text: `[System note: Attachment '${
              att.originalName || "unknown"
            }' skipped due to invalid metadata/URL.]`,
          });
          continue;
        }
        if (att.mimeType.startsWith("image/")) {
          newContentParts.push({
            type: "image",
            image: att.url,
            mimeType: att.mimeType,
          });
        } else {
          newContentParts.push({
            type: "file",
            data: att.url,
            mimeType: att.mimeType,
            filename: att.originalName,
          });
        }
        processedAttachmentsMetadata.push({
          url: att.url,
          originalName: att.originalName,
          mimeType: att.mimeType,
          size: att.size,
          uploadedAt: att.uploadedAt ? new Date(att.uploadedAt) : new Date(),
        });
      }
    }

    if (newContentParts.length === 0) {
      const err = new Error(
        "No valid message content or processable attachments."
      );
      err.status = 400;
      throw err;
    }

    chat.messages.push({
      role: "user",
      content: newContentParts,
      attachments: processedAttachmentsMetadata,
      timestamp: new Date(),
      status: "sent",
    });
    // messageCount will be updated by pre-save hook in chatModel

    const messagesForAI = chat.messages.slice(-20).map((dbMsg) => ({
      // Use a reasonable history limit
      role: dbMsg.role,
      content: normalizeDbMessageContentForAI(dbMsg),
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

    // Use the imported generateText function
    const aiResponse = await generateText({
      // <<<< Using imported function
      model: google(GEMINI_MODEL_NAME), // Pass the google provider instance and model name
      tools,
      system: systemPromptText,
      messages: messagesForAI,
      maxSteps: 10, // From your WhatsApp message processor, good to have a limit
    });

    if (aiResponse.usage) {
      const { promptTokens, completionTokens } = aiResponse.usage;
      if (
        typeof promptTokens === "number" &&
        typeof completionTokens === "number"
      ) {
        await logTokenUsage({
          userIdForTokenBilling,
          botProfileId,
          botProfileName,
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
          "Invalid token usage data from AI SDK."
        );
      }
    } else {
      logger.warn(
        { userId: userIdForTokenBilling, source: "webapp", sessionId },
        "Token usage data not available from AI SDK response."
      );
    }

    const assistantResponseText =
      aiResponse.text ?? "[AI did not provide a text response]"; // Fallback
    chat.messages.push({
      role: "assistant",
      content: assistantResponseText, // Storing as string, normalizeDbMessageContentForAI will handle it
      timestamp: new Date(),
      status: "sent",
    });
    // messageCount will be updated by pre-save hook
    // chat.updatedAt will be updated by pre-save hook
    await chat.save();

    return {
      text: assistantResponseText,
      toolCalls: aiResponse.toolCalls,
      usage: aiResponse.usage,
    };
  } catch (error) {
    const errorContext = {
      errName: error.name,
      errMsg: error.message,
      errStatus: error.status,
      errStack:
        process.env.NODE_ENV === "development" ? error.stack : undefined,
      sessionId,
      userId: userIdForTokenBilling,
      source: "webapp",
    };
    logger.error(errorContext, `ChatService: Error processing webapp message`);
    if (error.status) throw error;
    const serviceError = new Error(
      "An internal error occurred while processing your message."
    );
    serviceError.status = 500;
    throw serviceError;
  }
};

export { processMessage };
