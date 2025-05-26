//mcpclient/utils/whatsappMessageProcessor.js
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";
import { v2 as cloudinary } from "cloudinary";

// Cloudinary config (ensure these env vars are set)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

class WhatsAppMessageProcessor {
  constructor(aiService) {
    this.aiService = aiService; // Expecting an AI service/instance
  }

  // Helper to normalize message content for AI (similar to messageService.js)
  static normalizeDbMessageContentForAI(dbMessage) {
    if (
      !dbMessage ||
      typeof dbMessage.content === "undefined" ||
      dbMessage.content === null
    ) {
      return [{ type: "text", text: "[System: Message content unavailable]" }];
    }
    if (Array.isArray(dbMessage.content)) {
      // Already structured
      return dbMessage.content.filter((part) => {
        if (part.type === "text" && typeof part.text === "string") return true;
        if (
          part.type === "image" &&
          typeof part.image === "string" &&
          part.image.trim() !== "" &&
          typeof part.mimeType === "string"
        )
          return true;
        // Optionally add file support here
        return false;
      });
    }
    if (typeof dbMessage.content === "string") {
      const trimmed = dbMessage.content.trim();
      if (trimmed === "")
        return [{ type: "text", text: "[System: Message content empty]" }];
      return [{ type: "text", text: trimmed }];
    }
    return [
      { type: "text", text: "[System: Message content in unexpected format]" },
    ];
  }

  async processIncomingMessage(message, connectionName, sessionDetails) {
    const { userId, systemPromptId, systemPromptName, aiInstance } =
      sessionDetails;
    const { tools, google, GEMINI_MODEL_NAME, generateText, systemPromptText } =
      aiInstance;
    const userNumber = message.from.split("@")[0];

    let userMessageContent = message.body;
    let isImageMessage = false;
    let imageUrl = null;
    let newContentParts = [];
    let processedAttachmentsMetadata = [];

    // Handle media (images, files) sent on WhatsApp and upload to Cloudinary
    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media && media.mimetype && media.mimetype.startsWith("image/")) {
          // Upload image to Cloudinary
          const uploadResult = await cloudinary.uploader.upload(
            `data:${media.mimetype};base64,${media.data}`,
            {
              folder: "whatsapp_uploads",
              public_id: `wa_${userNumber}_${Date.now()}`,
              resource_type: "image",
            }
          );
          newContentParts.push({
            type: "image",
            image: uploadResult.secure_url,
            mimeType: media.mimetype,
          });
          processedAttachmentsMetadata.push({
            url: uploadResult.secure_url,
            originalName: media.filename || `image_${Date.now()}`,
            mimeType: media.mimetype,
            size: media.data.length, // base64 length, for reference
            uploadedAt: new Date(),
          });
        } else {
          await message.reply(
            "Sorry, only image files are supported for AI processing."
          );
          return;
        }
      } catch (mediaErr) {
        logger.error(
          { err: mediaErr },
          "MessageProcessor: Error handling WhatsApp image upload to Cloudinary"
        );
        await message.reply("Sorry, there was an error uploading your image.");
        return;
      }
    }
    if (!message.hasMedia && message.body && message.body.trim() !== "") {
      newContentParts.push({ type: "text", text: message.body.trim() });
    }
    if (newContentParts.length === 0) {
      await message.reply(
        "Message content cannot be empty if no image is provided."
      );
      return;
    }

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

    try {
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

      // Add user message (array of content parts) to chat history
      chat.messages.push({
        role: "user",
        content: newContentParts,
        attachments: processedAttachmentsMetadata,
        timestamp: new Date(),
        status: "delivered",
      });
      chat.messageCount++;

      const messagesForAI = chat.messages.slice(-20).map((msg) => ({
        role: msg.role,
        content: WhatsAppMessageProcessor.normalizeDbMessageContentForAI(msg),
        ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
        ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
      }));

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
          aiResponse.usage
        );
      } else {
        logger.warn(
          { userId, source: "whatsapp" },
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
      chat.messageCount++;
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
          { err: replyErr },
          `MessageProcessor: Failed to send processing error reply for ${connectionName}`
        );
      }
    }
  }

  async logTokenUsage(
    userId,
    systemPromptId,
    systemPromptName,
    chatId,
    modelName,
    usageData
  ) {
    const { promptTokens, completionTokens } = usageData;
    if (
      typeof promptTokens !== "number" ||
      typeof completionTokens !== "number"
    ) {
      logger.warn(
        { userId, usage: usageData, source: "whatsapp" },
        "MessageProcessor: Invalid token usage data from AI SDK for WhatsApp."
      );
      return;
    }

    const totalTokens = promptTokens + completionTokens;
    const usageRecord = new TokenUsageRecord({
      userId,
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

    await User.logTokenUsage({ userId, promptTokens, completionTokens });
    await SystemPrompt.logTokenUsage({
      systemPromptId,
      promptTokens,
      completionTokens,
    });
    logger.info(
      {
        userId,
        systemPromptId,
        promptTokens,
        completionTokens,
        source: "whatsapp",
      },
      "MessageProcessor: Token usage logged for WhatsApp."
    );
  }
}

export default WhatsAppMessageProcessor;
