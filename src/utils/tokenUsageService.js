// src\utils\tokenUsageService.js
import TokenUsageRecord from "../models/tokenUsageRecordModel.js";
import User from "../models/userModel.js";
import BotProfile from "../models/botProfileModel.js";
import logger from "../utils/logger.js";

/**
 * Logs token usage for a chat message and updates user and bot profile usage.
 * @param {Object} params
 * @param {string|ObjectId} params.userIdForTokenBilling
 * @param {string|ObjectId} params.botProfileId
 * @param {string} params.botProfileName
 * @param {string|ObjectId} params.chatId
 * @param {string} params.modelName
 * @param {number} params.promptTokens
 * @param {number} params.completionTokens
 * @param {string} params.sessionId
 * @param {string} params.source
 */
export async function logTokenUsage({
  userIdForTokenBilling,
  botProfileId,
  botProfileName,
  chatId,
  modelName,
  promptTokens,
  completionTokens,
  sessionId,
  source = "webapp",
}) {
  // Validate token counts before proceeding
  if (
    typeof promptTokens !== "number" ||
    isNaN(promptTokens) ||
    typeof completionTokens !== "number" ||
    isNaN(completionTokens)
  ) {
    logger.error(
      {
        userId: userIdForTokenBilling,
        promptTokens,
        completionTokens,
        sessionId,
        source,
      },
      "TokenUsageService: Invalid promptTokens or completionTokens (NaN or not a number). Skipping token usage record."
    );
    return; // Do not attempt to save invalid record
  }
  const totalTokens = promptTokens + completionTokens;
  const usageRecord = new TokenUsageRecord({
    userId: userIdForTokenBilling,
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
  await User.logTokenUsage({
    userId: userIdForTokenBilling,
    promptTokens,
    completionTokens,
  });
  await BotProfile.logTokenUsage({
    botProfileId,
    promptTokens,
    completionTokens,
  });
  logger.info(
    {
      userId: userIdForTokenBilling,
      promptTokens,
      completionTokens,
      totalTokens,
      source,
      sessionId,
    },
    "Token usage logged for webapp chat."
  );
}
