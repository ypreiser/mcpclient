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

// Helper to normalize message content from DB for the AI SDK
// Moved from messageService.js to be reusable
function normalizeDbMessageContentForAI(dbMessage) {
  // Ensure dbMessage and dbMessage.content exist
  if (
    !dbMessage ||
    typeof dbMessage.content === "undefined" ||
    dbMessage.content === null
  ) {
    logger.warn(
      { messageId: dbMessage?._id?.toString() },
      "Historical message content is missing or null. Sending placeholder."
    );
    return [{ type: "text", text: "[System: Message content unavailable]" }];
  }

  // Case 1: dbMessage.content is already an array (multi-modal or structured text from new messages)
  if (Array.isArray(dbMessage.content)) {
    const validParts = dbMessage.content.reduce((acc, part) => {
      // Basic validation for part structure
      if (!part || typeof part.type !== "string") {
        logger.warn(
          { part, messageId: dbMessage._id?.toString() },
          "Invalid part structure in historical array message content, skipping."
        );
        return acc;
      }

      if (part.type === "text") {
        if (typeof part.text === "string" && part.text.trim() !== "") {
          acc.push({ type: "text", text: part.text });
        } else {
          // Allow empty text part if it's the only part initially (e.g. assistant empty response)
          // but generally filter out if other content exists or if it's from user input.
          // For AI history, an empty text string in a part can be problematic.
          // The SDK might handle it, but to be safe, we filter truly empty text.
          // If an array part is `[{type: "text", text: ""}]`, it's different from `content: ""`.
          // logger.info({ part, messageId: dbMessage._id?.toString() }, "Empty or invalid text part in historical array message content, not added to AI parts.");
        }
      } else if (part.type === "image") {
        if (
          typeof part.image === "string" &&
          part.image.trim() !== "" &&
          typeof part.mimeType === "string"
        ) {
          try {
            new URL(part.image); // Validate URL
            acc.push({
              type: "image",
              image: part.image,
              mimeType: part.mimeType,
            });
          } catch (e) {
            logger.warn(
              { part, messageId: dbMessage._id?.toString(), error: e.message },
              "Invalid image URL in historical array message content part, skipping."
            );
          }
        } else {
          logger.warn(
            { part, messageId: dbMessage._id?.toString() },
            "Malformed image part (non-string image, empty image URL, or missing mimeType) in historical array message content, skipping."
          );
        }
      } else if (part.type === "file") {
        if (
          typeof part.data === "string" &&
          part.data.trim() !== "" &&
          typeof part.mimeType === "string" &&
          typeof part.filename === "string"
        ) {
          try {
            new URL(part.data); // Validate URL for file data
            acc.push({
              type: "file",
              data: part.data,
              mimeType: part.mimeType,
              filename: part.filename,
            });
          } catch (e) {
            logger.warn(
              { part, messageId: dbMessage._id?.toString(), error: e.message },
              "Invalid file data URL in historical array message content part, skipping."
            );
          }
        } else {
          logger.warn(
            { part, messageId: dbMessage._id?.toString() },
            "Malformed file part in historical array message content, skipping."
          );
        }
      } else {
        logger.warn(
          { part, messageId: dbMessage._id?.toString() },
          "Unknown part type in historical array message content, skipping."
        );
      }
      return acc;
    }, []);

    if (validParts.length === 0) {
      logger.warn(
        {
          messageId: dbMessage._id?.toString(),
          originalContent: dbMessage.content,
        },
        "Historical array message content resulted in no valid parts after normalization. Sending placeholder."
      );
      return [
        {
          type: "text",
          text: "[System: Message content unprocessable or empty after normalization]",
        },
      ];
    }
    return validParts;
  }

  // Case 2: dbMessage.content is a string (e.g. simple text message, or assistant response)
  if (typeof dbMessage.content === "string") {
    const trimmedContent = dbMessage.content.trim();
    if (trimmedContent === "") {
      // An assistant might legitimately respond with an empty string.
      // Most SDKs expect at least one part for user/assistant.
      // To align with how empty user inputs are handled (placeholder if no attachments),
      // and ensure AI gets structured input, sending a placeholder for truly empty historical strings.
      logger.info(
        { messageId: dbMessage._id?.toString() },
        "Historical string message content is empty. Sending placeholder."
      );
      return [{ type: "text", text: "[System: Message content empty]" }];
    }
    return [{ type: "text", text: trimmedContent }];
  }

  // Fallback: dbMessage.content is of an unexpected type
  logger.warn(
    {
      messageId: dbMessage._id?.toString(),
      contentType: typeof dbMessage.content,
      content: dbMessage.content,
    },
    "Unexpected historical message content type. Sending placeholder."
  );
  return [
    { type: "text", text: "[System: Message content in unexpected format]" },
  ];
}

export { isUrl, validateSystemPrompt, normalizeDbMessageContentForAI };
