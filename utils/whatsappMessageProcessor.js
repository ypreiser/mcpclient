//mcpclient/utils/whatsappMessageProcessor.js
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";
import { v2 as cloudinary } from "cloudinary";
import { normalizeDbMessageContentForAI } from "./chatUtils.js"; // Import the shared normalizer

// Configure Cloudinary - this should ideally happen once at app startup,
// but including it here ensures it's configured if this module is loaded independently
// or before other modules that might configure it.
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  logger.warn(
    "WhatsAppMessageProcessor: Cloudinary environment variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) are not fully set. Media uploads from WhatsApp will fail."
  );
}

class WhatsAppMessageProcessor {
  constructor(aiService) {
    this.aiService = aiService;
  }

  async _uploadMediaToCloudinary(media) {
    if (!media || !media.data || !media.mimetype) {
      logger.warn(
        "MessageProcessor: Attempted to upload invalid media object (missing data or mimetype)."
      );
      return null;
    }
    // Check if Cloudinary is configured before attempting upload
    if (!cloudinary.config().cloud_name) {
      logger.error(
        "MessageProcessor: Cloudinary is not configured. Cannot upload media."
      );
      return null;
    }

    try {
      const resource_type = media.mimetype.startsWith("image/")
        ? "image"
        : media.mimetype.startsWith("video/")
        ? "video"
        : media.mimetype.startsWith("audio/")
        ? "video"
        : "raw";

      const dataUri = `data:${media.mimetype};base64,${media.data}`;

      const result = await cloudinary.uploader.upload(dataUri, {
        resource_type: resource_type,
        folder: process.env.CLOUDINARY_FOLDER_WHATSAPP || "whatsapp_uploads",
        public_id: media.filename || undefined,
      });

      logger.info(
        {
          public_id: result.public_id,
          url: result.secure_url,
          originalFilename: media.filename,
        },
        "MessageProcessor: Media uploaded to Cloudinary successfully."
      );
      return {
        url: result.secure_url,
        originalName: media.filename || result.public_id,
        mimeType: media.mimetype,
        size: result.bytes,
        uploadedAt: new Date(result.created_at),
        publicId: result.public_id,
      };
    } catch (error) {
      logger.error(
        { err: error, mimetype: media.mimetype, filename: media.filename },
        "MessageProcessor: Failed to upload media to Cloudinary."
      );
      return null;
    }
  }

  async processIncomingMessage(message, connectionName, sessionDetails) {
    const { userId, systemPromptId, systemPromptName, aiInstance } =
      sessionDetails;
    const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
      aiInstance;
    const userNumber = message.from.split("@")[0];

    if (!userId || !systemPromptId || !aiInstance) {
      logger.error(
        `MessageProcessor: Critical session details missing for ${connectionName}. User: ${userId}, PromptID: ${systemPromptId}, AI: ${!!aiInstance}`
      );
      try {
        await message.reply(
          "Sorry, the AI service for this connection is not properly configured. Please contact support."
        );
      } catch (replyErr) {
        logger.error(
          { err: replyErr },
          `MessageProcessor: Failed to send config error reply for ${connectionName}`
        );
      }
      return;
    }

    const newContentParts = [];
    const processedAttachmentsMetadata = [];

    try {
      const trimmedMessageBody = message.body?.trim() ?? "";
      if (trimmedMessageBody) {
        newContentParts.push({ type: "text", text: trimmedMessageBody });
      }

      if (message.hasMedia) {
        logger.info(
          `MessageProcessor: Message from ${userNumber} for connection ${connectionName} has media. Downloading...`
        );
        try {
          const media = await message.downloadMedia();
          if (media) {
            logger.info(
              {
                filename: media.filename,
                mimetype: media.mimetype,
                size: media.filesize,
                connectionName,
                userNumber,
              },
              `MessageProcessor: Media downloaded for ${userNumber}. Uploading to Cloudinary...`
            );
            const cloudinaryFileMeta = await this._uploadMediaToCloudinary(
              media
            );

            if (cloudinaryFileMeta) {
              if (cloudinaryFileMeta.mimeType.startsWith("image/")) {
                newContentParts.push({
                  type: "image",
                  image: cloudinaryFileMeta.url,
                  mimeType: cloudinaryFileMeta.mimeType,
                });
              } else {
                newContentParts.push({
                  type: "file",
                  data: cloudinaryFileMeta.url,
                  mimeType: cloudinaryFileMeta.mimeType,
                  filename: cloudinaryFileMeta.originalName,
                });
              }
              processedAttachmentsMetadata.push(cloudinaryFileMeta);

              // If there was no text body (caption) but media is present, add a descriptive text part.
              if (!trimmedMessageBody) {
                newContentParts.unshift({
                  type: "text",
                  text: `[User sent a file: ${
                    cloudinaryFileMeta.originalName || "attachment"
                  }]`,
                });
              }
            } else {
              logger.warn(
                `MessageProcessor: Failed to upload media for ${userNumber} on connection ${connectionName}. Proceeding without it.`
              );
              const failureText =
                "[System note: Media attachment failed to process and upload.]";
              if (newContentParts.length === 0)
                newContentParts.push({ type: "text", text: failureText });
              else
                newContentParts.find(
                  (p) => p.type === "text"
                ).text += ` ${failureText}`;
            }
          } else {
            logger.warn(
              `MessageProcessor: Media download failed or media was empty for ${userNumber} on connection ${connectionName}.`
            );
            const failureText =
              "[System note: Media attachment could not be downloaded.]";
            if (newContentParts.length === 0)
              newContentParts.push({ type: "text", text: failureText });
            else if (newContentParts.find((p) => p.type === "text"))
              newContentParts.find(
                (p) => p.type === "text"
              ).text += ` ${failureText}`;
            else newContentParts.unshift({ type: "text", text: failureText });
          }
        } catch (mediaError) {
          logger.error(
            { err: mediaError, connectionName, userNumber },
            `MessageProcessor: Error handling media for ${userNumber}.`
          );
          const failureText = `[System note: Error processing media attachment: ${mediaError.message}]`;
          if (newContentParts.length === 0)
            newContentParts.push({ type: "text", text: failureText });
          else if (newContentParts.find((p) => p.type === "text"))
            newContentParts.find(
              (p) => p.type === "text"
            ).text += ` ${failureText}`;
          else newContentParts.unshift({ type: "text", text: failureText });
        }
      }

      if (newContentParts.length === 0) {
        logger.warn(
          `MessageProcessor: No processable content (text or media) for message from ${userNumber} on ${connectionName}. Ignoring.`
        );
        // Optionally, reply to the user that the message was empty or unprocessable
        // await message.reply("I couldn't understand your message or the attachment was empty/corrupted.");
        return;
      }

      const contact = await message.getContact();
      const userName = contact.name || contact.pushname || message.from;

      const chat = await Chat.findOneAndUpdate(
        {
          sessionId: userNumber,
          "metadata.connectionName": connectionName,
          source: "whatsapp",
          userId: userId,
        },
        {
          $setOnInsert: {
            sessionId: userNumber,
            source: "whatsapp",
            userId: userId,
            systemPromptId: systemPromptId,
            systemPromptName: systemPromptName,
            "metadata.connectionName": connectionName,
            "metadata.userName": userName,
            messages: [],
          },
          $set: {
            "metadata.lastActive": new Date(),
            "metadata.isArchived": false,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      chat.messages.push({
        role: "user",
        content: newContentParts,
        attachments: processedAttachmentsMetadata,
        timestamp: new Date(),
        status: "delivered",
      });

      const messagesForAI = chat.messages.slice(-20).map((dbMsg) => ({
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
          waSessionId: userNumber,
          connectionName,
        },
        "MessageProcessor: Prepared messages for AI SDK (WhatsApp)"
      );

      const aiResponse = await generateText({
        model: google(GEMINI_MODEL_NAME),
        tools,
        maxSteps: 10,
        system: systemPromptText,
        messages: messagesForAI,
      });

      if (aiResponse.usage) {
        await this.logTokenUsage(
          userId,
          systemPromptId,
          systemPromptName,
          chat._id,
          GEMINI_MODEL_NAME,
          aiResponse.usage,
          userNumber
        );
      } else {
        logger.warn(
          {
            userId,
            source: "whatsapp",
            waSessionId: userNumber,
            connectionName,
          },
          "MessageProcessor: Token usage data not available from AI SDK for WhatsApp."
        );
      }

      const assistantResponseText =
        aiResponse.text || "No text response from AI.";
      chat.messages.push({
        role: "assistant",
        content: assistantResponseText,
        timestamp: new Date(),
        status: "sent",
      });
      chat.updatedAt = new Date();
      await chat.save();

      await message.reply(assistantResponseText);
      logger.info(
        { to: userNumber, connectionName },
        "MessageProcessor: Sent AI response via WhatsApp"
      );
    } catch (error) {
      logger.error(
        { err: error, connectionName, from: userNumber, userId },
        "MessageProcessor: Error processing WhatsApp message"
      );
      try {
        await message.reply(
          "Sorry, I encountered an error processing your message."
        );
      } catch (replyErr) {
        logger.error(
          { err: replyErr, connectionName, from: userNumber },
          `MessageProcessor: Failed to send processing error reply for ${connectionName}`
        );
      }
    }
  }

  async logTokenUsage(
    userIdForTokenBilling,
    systemPromptId,
    systemPromptName,
    chatId,
    modelName,
    usageData,
    waSessionId
  ) {
    const { promptTokens, completionTokens } = usageData;
    if (
      typeof promptTokens !== "number" ||
      typeof completionTokens !== "number"
    ) {
      logger.warn(
        {
          userId: userIdForTokenBilling,
          usage: usageData,
          source: "whatsapp",
          waSessionId,
        },
        "MessageProcessor: Invalid token usage data from AI SDK for WhatsApp."
      );
      return;
    }

    const totalTokens = promptTokens + completionTokens;
    const usageRecord = new TokenUsageRecord({
      userId: userIdForTokenBilling,
      systemPromptId,
      systemPromptName,
      chatId,
      source: "whatsapp",
      modelName,
      promptTokens,
      completionTokens,
      totalTokens,
      timestamp: new Date(),
    });
    await usageRecord.save();

    await User.logTokenUsage({
      userId: userIdForTokenBilling,
      promptTokens,
      completionTokens,
    });
    await SystemPrompt.logTokenUsage({
      systemPromptId,
      promptTokens,
      completionTokens,
    });
    logger.info(
      {
        userId: userIdForTokenBilling,
        systemPromptId,
        promptTokens,
        completionTokens,
        source: "whatsapp",
        waSessionId,
      },
      "MessageProcessor: Token usage logged for WhatsApp."
    );
  }
}

export default WhatsAppMessageProcessor;
