// services/apiKeyService.js
import ApiKey from "../models/apiKeyModel.js";
import { encrypt, decrypt } from "../utils/encryptionService.js";
import logger from "../utils/logger.js";

export async function createApiKey({ name, apiKey, aiProvider, description }) {
  if (!name || !apiKey || !aiProvider) {
    throw new Error("Name, apiKey, and aiProvider are required.");
  }
  const encryptedApiKey = encrypt(apiKey);
  const newApiKeyEntry = new ApiKey({
    name,
    encryptedApiKey,
    aiProvider,
    description,
  });
  await newApiKeyEntry.save();
  logger.info(`API Key '${name}' created successfully.`);
  // Return a sanitized version, omitting the encrypted key
  return {
    id: newApiKeyEntry._id,
    name,
    aiProvider,
    description,
    createdAt: newApiKeyEntry.createdAt,
  };
}

export async function getApiKeyByName(name, includeEncrypted = false) {
  const apiKeyEntry = await ApiKey.findOne({ name }).lean();
  if (!apiKeyEntry) {
    return null;
  }
  // By default, do not return the encrypted key unless explicitly requested
  // and even then, it's better to return the decrypted key directly if needed for use.
  if (includeEncrypted) {
    return apiKeyEntry;
  }
  // Sanitize: remove encryptedApiKey before returning general info
  const { encryptedApiKey, ...rest } = apiKeyEntry;
  return rest;
}

export async function getDecryptedApiKeyByName(name) {
  const apiKeyEntry = await ApiKey.findOne({ name }).lean();
  if (!apiKeyEntry || !apiKeyEntry.encryptedApiKey) {
    return null;
  }
  try {
    const decrypted = decrypt(apiKeyEntry.encryptedApiKey);
    if (!decrypted) {
      logger.error(
        `Failed to decrypt API key for '${name}'. Check encryption secret and data integrity.`
      );
      return null;
    }
    return decrypted;
  } catch (error) {
    logger.error(
      { err: error, apiKeyName: name },
      `Error during decryption process for API key '${name}'.`
    );
    return null;
  }
}

export async function listApiKeys() {
  // Returns a list of API key metadata (names, descriptions), not the keys themselves.
  const keys = await ApiKey.find()
    .select("name description aiProvider createdAt updatedAt")
    .lean();
  return keys;
}

export async function updateApiKey(
  name,
  { newApiKey, newDescription, newAiProvider }
) {
  const apiKeyEntry = await ApiKey.findOne({ name });
  if (!apiKeyEntry) {
    throw new Error(`API Key '${name}' not found.`);
  }

  let updated = false;
  if (newApiKey) {
    apiKeyEntry.encryptedApiKey = encrypt(newApiKey);
    updated = true;
  }
  if (newDescription !== undefined) {
    apiKeyEntry.description = newDescription;
    updated = true;
  }
  if (newAiProvider) {
    apiKeyEntry.aiProvider = newAiProvider;
    updated = true;
  }

  if (updated) {
    await apiKeyEntry.save();
    logger.info(`API Key '${name}' updated successfully.`);
  }
  // Return sanitized version
  return {
    id: apiKeyEntry._id,
    name: apiKeyEntry.name,
    aiProvider: apiKeyEntry.aiProvider,
    description: apiKeyEntry.description,
    updatedAt: apiKeyEntry.updatedAt,
  };
}

export async function deleteApiKey(name) {
  const result = await ApiKey.deleteOne({ name });
  if (result.deletedCount === 0) {
    throw new Error(`API Key '${name}' not found.`);
  }
  logger.info(`API Key '${name}' deleted successfully.`);
  return true;
}
