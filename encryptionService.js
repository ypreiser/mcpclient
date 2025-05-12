// utils/encryptionService.js
import crypto from "crypto";
import logger from "./logger.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // AES GCM standard IV length
const AUTH_TAG_LENGTH = 16; // AES GCM standard auth tag length

const encryptionKey = process.env.API_KEY_ENCRYPTION_SECRET;

if (!encryptionKey || encryptionKey.length !== 64) {
  // 32 bytes = 64 hex characters
  const errMsg =
    "API_KEY_ENCRYPTION_SECRET is not set or is not a 64-character hex string. Please set it in your environment variables.";
  logger.error(errMsg);
  // In a real app, you might want to prevent startup if this is missing.
  // For now, we log an error. Functions will fail if called without a valid key.
  // throw new Error(errMsg); // Or handle more gracefully depending on app lifecycle
}

function getKey() {
  if (!encryptionKey || encryptionKey.length !== 64) {
    throw new Error("Encryption key is not properly configured.");
  }
  return Buffer.from(encryptionKey, "hex");
}

export function encrypt(text) {
  if (!text) return null;
  try {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
  } catch (error) {
    logger.error({ err: error }, "Encryption failed");
    throw error; // Re-throw or handle as appropriate
  }
}

export function decrypt(text) {
  if (!text) return null;
  try {
    const key = getKey();
    const parts = text.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted text format.");
    }
    const [ivHex, authTagHex, encryptedTextHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedTextHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    logger.error(
      { err: error },
      "Decryption failed. This could be due to an incorrect key or corrupted data."
    );
    // Do not return partial data or the error object directly to callers if it contains sensitive info.
    // Depending on context, you might return null or throw a generic error.
    return null; // Or throw new Error("Decryption failed");
  }
}
