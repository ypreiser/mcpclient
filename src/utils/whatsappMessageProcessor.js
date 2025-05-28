// src\utils\whatsappMessageProcessor.js
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js"; // For logging token usage to User
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import BotProfile from "../models/botProfileModel.js"; // For logging token usage to BotProfile
import logger from "../utils/logger.js";
import { v2 as cloudinary } from "cloudinary";
import { generateText } from "ai"; // Import the AI SDK function directly
import { normalizeDbMessageContentForAI } from "./messageContentUtils.js"; // Import the normalization function
import { logTokenUsage as centralizedLogTokenUsage } from "./tokenUsageService.js"; // Centralized token logging service
// Assuming initializeAI is passed in constructor from whatsappService

// Cloudinary config (ensure these env vars are set)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

class WhatsAppMessageProcessor {
  constructor(aiServiceFactory) {
    this.aiServiceFactory = aiServiceFactory;
  }

  async processIncomingMessage(message, connectionName, sessionDetails) {
    // sessionDetails should include: userId (BotProfile owner), botProfileId, aiInstance
    const { userId, botProfileId, aiInstance } = sessionDetails;

    // Ensure aiInstance is valid and contains what we need
    if (
      !aiInstance ||
      !aiInstance.google ||
      !aiInstance.GEMINI_MODEL_NAME ||
      !aiInstance.botProfileText
    ) {
      logger.error(
        `MessageProcessor: AI instance not fully initialized for ${connectionName}. Cannot process message.`
      );
      await message.reply(
        "Sorry, the AI for this chat is not ready. Please try again later or contact support."
      );
      return;
    }
    const { tools, google, GEMINI_MODEL_NAME, botProfileText } = aiInstance; // botProfileText is the system prompt text

    const userNumber = message.from.split("@")[0];
    // **MODIFICATION: Create a composite sessionId for WhatsApp**
    const compositeSessionId = `${connectionName}_${userNumber}`;

    let userMessageContent = message.body;
    let newContentParts = [];
    let processedAttachmentsMetadata = [];

    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media && media.mimetype && media.mimetype.startsWith("image/")) {
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
            size: media.data.length,
            uploadedAt: new Date(),
          });
        } else if (media) {
          // Handle other file types if your AI and UI support them
          logger.info(
            `MessageProcessor: Received non-image media type: ${media.mimetype} from ${userNumber} on ${connectionName}. Currently only processing images for AI.`
          );
          // For now, we only process images for AI. If you support other files, upload them similarly.
          // Here, we'll just acknowledge it textually if not an image.
          newContentParts.push({
            type: "text",
            text: `[User sent a file: ${media.filename || media.mimetype}]`,
          });
        } else {
          logger.warn(
            `MessageProcessor: Media download failed or media is null for ${userNumber} on ${connectionName}.`
          );
        }
      } catch (mediaErr) {
        logger.error(
          { err: mediaErr },
          "MessageProcessor: Error handling WhatsApp media upload"
        );
        await message.reply(
          "Sorry, there was an error processing your attachment."
        );
        return;
      }
    }
    // Always add text part if exists, even with media. AI SDK can handle multiple parts.
    if (message.body && message.body.trim() !== "") {
      newContentParts.push({ type: "text", text: message.body.trim() });
    }

    if (newContentParts.length === 0) {
      logger.warn(
        `MessageProcessor: No processable content for message from ${userNumber} on ${connectionName}.`
      );
      // await message.reply("It seems your message was empty or contained unsupported content."); // Optional reply
      return; // Don't proceed if nothing to process
    }

    if (!userId || !botProfileId || !aiInstance) {
      logger.error(
        `MessageProcessor: Critical session details missing for ${connectionName}. User: ${userId}, BotProfileID: ${botProfileId}, AI: ${!!aiInstance}`
      );
      await message.reply(
        "Sorry, the AI service for this connection is not properly configured. Please contact support."
      );
      return;
    }

    // Fetch BotProfile name for logging, if not already in sessionDetails (it should be)
    const botProfileName =
      sessionDetails.botProfileName ||
      (await BotProfile.findById(botProfileId).select("name").lean())?.name ||
      "UnknownBot";

    try {
      const contact = await message.getContact();
      const userName = contact.name || contact.pushname || message.from; // Prefer contact.name or pushname

      // **MODIFICATION: Use compositeSessionId in query and $setOnInsert**
      const chat = await Chat.findOneAndUpdate(
        {
          sessionId: compositeSessionId, // Use composite ID
          source: "whatsapp",
          // userId should be the BotProfile owner, already in sessionDetails.userId
          // botProfileId is also in sessionDetails
        },
        {
          $setOnInsert: {
            sessionId: compositeSessionId, // Use composite ID
            source: "whatsapp",
            userId: userId, // Owner of the BotProfile
            botProfileId: botProfileId,
            botProfileName: botProfileName, // Store for convenience
            messages: [],
          },
          $set: {
            // For both existing and new chats
            "metadata.lastActive": new Date(),
            "metadata.isArchived": false,
            "metadata.userName": userName,
            "metadata.connectionName": connectionName, // Still useful metadata
            "metadata.whatsAppUserNumber": userNumber, // Store original user number if needed
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
      // messageCount will be updated by pre-save hook in chatModel

      const messagesForAI = chat.messages.slice(-20).map((msg) => ({
        role: msg.role,
        content: normalizeDbMessageContentForAI(msg),
        ...(msg.toolCalls && { toolCalls: msg.toolCalls }),
        ...(msg.toolCallId && { toolCallId: msg.toolCallId }),
      }));

      // Use the imported generateText directly
      const aiSdkResponse = await generateText({
        // Renamed to avoid conflict if generateText was in scope
        model: google(GEMINI_MODEL_NAME),
        tools,
        maxSteps: 10, // Consider making this configurable per BotProfile
        system: botProfileText,
        messages: messagesForAI,
      });

      if (aiSdkResponse.usage) {
        // Use centralized logTokenUsage from tokenUsageService.js
        await centralizedLogTokenUsage({
          userIdForTokenBilling: userId, // Bill to the BotProfile owner
          botProfileId,
          botProfileName,
          chatId: chat._id,
          modelName: GEMINI_MODEL_NAME,
          promptTokens: aiSdkResponse.usage.promptTokens,
          completionTokens: aiSdkResponse.usage.completionTokens,
          sessionId: compositeSessionId, // Log with the composite sessionId
          source: "whatsapp",
        });
      } else {
        logger.warn(
          { userId, source: "whatsapp", compositeSessionId },
          "MessageProcessor: Token usage data not available from AI SDK."
        );
      }

      const assistantResponseText =
        aiSdkResponse.text || "[AI did not provide a text response]";
      chat.messages.push({
        role: "assistant",
        content: assistantResponseText, // Store as string
        timestamp: new Date(),
        status: "sent",
      });
      // chat.messageCount and chat.updatedAt handled by pre-save hook
      await chat.save();

      await message.reply(assistantResponseText);
      logger.info(
        { to: userNumber, connectionName, compositeSessionId },
        "MessageProcessor: Sent AI response via WhatsApp"
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          connectionName,
          from: userNumber,
          userId,
          compositeSessionId,
        },
        "MessageProcessor: Error processing WhatsApp message"
      );
      try {
        await message.reply(
          "Sorry, I encountered an error processing your message. Please try again."
        );
      } catch (replyErr) {
        logger.error(
          { err: replyErr, connectionName },
          `MessageProcessor: Failed to send processing error reply.`
        );
      }
    }
  }
}

export default WhatsAppMessageProcessor;
