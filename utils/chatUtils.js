// chatUtils.js
import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";
import { URL } from "url";

const isUrl = (str) => {
  if (typeof str !== "string") return false;
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
};

const validateSystemPrompt = async (systemPromptName, userIdExpectedOwner) => {
  const systemPromptDoc = await SystemPrompt.findOne({
    name: systemPromptName,
    userId: userIdExpectedOwner,
  });

  if (!systemPromptDoc) {
    const promptExists = await SystemPrompt.exists({ name: systemPromptName });
    const errorMsg = promptExists
      ? `Access denied: You do not own system prompt '${systemPromptName}'.`
      : `System prompt '${systemPromptName}' not found.`;
    logger.warn(
      { userIdExpectedOwner, systemPromptName },
      `System prompt validation failed: ${errorMsg}`
    );
    const err = new Error(errorMsg);
    err.status = promptExists ? 403 : 404;
    throw err;
  }
  return systemPromptDoc;
};

export { isUrl, validateSystemPrompt };
