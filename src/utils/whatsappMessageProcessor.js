// mcpclient/utils/whatsappMessageProcessor.js
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js"; // For logging token usage to User
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import BotProfile from "../models/botProfileModel.js"; // For logging token usage to BotProfile
import logger from "../utils/logger.js";
import { v2 as cloudinary } from "cloudinary";
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
    // Renamed for clarity: it's a factory/service that provides AI instances
    this.aiServiceFactory = aiServiceFactory;
  }

  static normalizeDbMessageContentForAI(dbMessage) {
    // ... (implementation from previous step remains the same)
    if (
      !dbMessage ||
      typeof dbMessage.content === "undefined" ||
      dbMessage.content === null
    ) {
      return [{ type: "text", text: "[System: Message content unavailable]" }];
    }
    if (Array.isArray(dbMessage.content)) {
      const validParts = dbMessage.content.reduce((acc, part) => {
        if (!part || typeof part.type !== "string") return acc;
        if (part.type === "text") {
          if (typeof part.text === "string" && part.text.trim() !== "")
            acc.push({ type: "text", text: part.text });
        } else if (part.type === "image") {
          if (
            typeof part.image === "string" &&
            part.image.trim() !== "" &&
            typeof part.mimeType === "string"
          ) {
            try {
              new URL(part.image);
              acc.push({
                type: "image",
                image: part.image,
                mimeType: part.mimeType,
              });
            } catch (e) {
              logger.warn(
                {
                  part,
                  messageId: dbMessage._id?.toString(),
                  error: e.message,
                },
                "Invalid image URL in historical content, skipping."
              );
            }
          }
        } else if (part.type === "file") {
          if (
            typeof part.data === "string" &&
            part.data.trim() !== "" &&
            typeof part.mimeType === "string" &&
            typeof part.filename === "string"
          ) {
            try {
              new URL(part.data);
              acc.push({
                type: "file",
                data: part.data,
                mimeType: part.mimeType,
                filename: part.filename,
              });
            } catch (e) {
              logger.warn(
                {
                  part,
                  messageId: dbMessage._id?.toString(),
                  error: e.message,
                },
                "Invalid file data URL in historical content, skipping."
              );
            }
          }
        }
        return acc;
      }, []);
      if (validParts.length === 0)
        return [
          {
            type: "text",
            text: "[System: Message content unprocessable or empty after normalization]",
          },
        ];
      return validParts;
    }
    if (typeof dbMessage.content === "string") {
      const trimmedContent = dbMessage.content.trim();
      if (trimmedContent === "")
        return [{ type: "text", text: "[System: Message content empty]" }];
      return [{ type: "text", text: trimmedContent }];
    }
    return [
      { type: "text", text: "[System: Message content in unexpected format]" },
    ];
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
        content: WhatsAppMessageProcessor.normalizeDbMessageContentForAI(msg),
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
        await this.logTokenUsage(
          userId, // Bill to the BotProfile owner
          botProfileId,
          botProfileName,
          chat._id,
          GEMINI_MODEL_NAME,
          aiSdkResponse.usage,
          compositeSessionId, // Log with the composite sessionId
          "whatsapp"
        );
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

  async logTokenUsage(
    userIdForBilling, // BotProfile owner
    botProfileId,
    botProfileName,
    chatId,
    modelName,
    usageData,
    sessionIdWithSource, // e.g., compositeSessionId for whatsapp
    source
  ) {
    const { promptTokens, completionTokens } = usageData;
    if (
      typeof promptTokens !== "number" ||
      typeof completionTokens !== "number"
    ) {
      logger.warn(
        {
          userId: userIdForBilling,
          usage: usageData,
          source,
          sessionIdWithSource,
        },
        "MessageProcessor: Invalid token usage data."
      );
      return;
    }

    const totalTokens = promptTokens + completionTokens;
    const usageRecord = new TokenUsageRecord({
      userId: userIdForBilling,
      botProfileId,
      botProfileName,
      chatId,
      source,
      modelName,
      promptTokens,
      completionTokens,
      totalTokens,
      timestamp: new Date(),
    });
    await usageRecord.save();

    // Log against the User who owns the BotProfile
    await User.logTokenUsage({
      userId: userIdForBilling,
      promptTokens,
      completionTokens,
    });
    // Log against the BotProfile itself
    await BotProfile.logTokenUsage({
      botProfileId,
      promptTokens,
      completionTokens,
    });

    logger.info(
      {
        userId: userIdForBilling,
        botProfileId,
        promptTokens,
        completionTokens,
        source,
        sessionIdWithSource,
      },
      "MessageProcessor: Token usage logged."
    );
  }
}

export default WhatsAppMessageProcessor;
