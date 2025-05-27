// src\utils\chatUtils.js
import BotProfile from "../models/botProfileModel.js";
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

const validateBotProfile = async (botProfileName, userIdExpectedOwner) => {
  const botProfileDoc = await BotProfile.findOne({
    name: botProfileName,
    userId: userIdExpectedOwner,
  });

  if (!botProfileDoc) {
    const profileExists = await BotProfile.exists({ name: botProfileName });
    const errorMsg = profileExists
      ? `Access denied: You do not own bot profile '${botProfileName}'.`
      : `Bot profile '${botProfileName}' not found.`;
    logger.warn(
      { userIdExpectedOwner, botProfileName },
      `Bot profile validation failed: ${errorMsg}`
    );
    const err = new Error(errorMsg);
    err.status = profileExists ? 403 : 404;
    throw err;
  }
  return botProfileDoc;
};

export { isUrl, validateBotProfile };
