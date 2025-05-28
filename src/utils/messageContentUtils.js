// src\utils\messageContentUtils.js
import logger from "../utils/logger.js";

function normalizeDbMessageContentForAI(dbMessage) {
  // Ensure dbMessage and dbMessage.content exist
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
              { part, messageId: dbMessage._id?.toString(), error: e.message },
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
              { part, messageId: dbMessage._id?.toString(), error: e.message },
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

export { normalizeDbMessageContentForAI };
