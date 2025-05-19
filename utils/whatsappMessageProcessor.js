//mcpclient/utils/whatsappMessageProcessor.js
import Chat from "../models/chatModel.js";
import User from "../models/userModel.js";
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";

class WhatsAppMessageProcessor {
  constructor(aiService) {
    this.aiService = aiService; // Expecting an AI service/instance
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

      chat.messages.push({
        role: "user",
        content: message.body,
        timestamp: new Date(),
        status: "delivered",
      });

      const messagesForAI = chat.messages
        .slice(-20) // Consider making this limit configurable
        .map((msg) => ({ role: msg.role, content: msg.content }));

      const aiResponse = await generateText({
        model: google(GEMINI_MODEL_NAME),
        tools,
        maxSteps: 10, // Consider making this configurable
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
