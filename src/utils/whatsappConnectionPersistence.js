// src\utils\whatsappConnectionPersistence.js
import WhatsAppConnection from "../models/whatsAppConnectionModel.js";
import logger from "../utils/logger.js";

class WhatsAppConnectionPersistence {
  /**
   * Get a WhatsApp connection by its name, scoped to a specific user.
   * @param {string} connectionName - The name of the connection.
   * @param {string|mongoose.Types.ObjectId} userId - The ID of the user owning the connection.
   * @returns {Promise<object|null>} The connection document or null if not found.
   */
  async getByConnectionName(connectionName, userId) {
    if (!userId) {
      logger.error(
        { connectionName },
        "DB: userId is required to get WhatsApp connection by name."
      );
      throw new Error("User ID is required for this operation.");
    }
    try {
      // Populate botProfileId to get its name for convenience if needed by caller
      return await WhatsAppConnection.findOne({ connectionName, userId })
        .populate("botProfileId", "name isEnabled") // Select useful fields from BotProfile
        .lean();
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName, userId },
        "DB: Failed to get WhatsApp connection by name for user."
      );
      throw dbError;
    }
  }

  /**
   * Saves or updates connection details. The query for findOneAndUpdate is by (connectionName, userId).
   * @param {string} connectionName
   * @param {string|mongoose.Types.ObjectId} botProfileId
   * @param {string|mongoose.Types.ObjectId} userId
   * @param {string} status
   * @param {boolean} autoReconnect
   * @param {Date|null} lastConnectedAt
   * @param {string|null} phoneNumber
   * @returns {Promise<object>} The saved or updated connection document.
   */
  async saveConnectionDetails(
    connectionName,
    botProfileId,
    userId,
    status,
    autoReconnect,
    lastConnectedAt = null,
    phoneNumber = null
  ) {
    if (!userId) {
      logger.error(
        { connectionName, botProfileId },
        "DB: userId is required to save WhatsApp connection details."
      );
      throw new Error("User ID is required for this operation.");
    }
    try {
      const updateData = {
        botProfileId,
        // userId is part of the query, not $set here, as it defines ownership
        autoReconnect,
        lastKnownStatus: status,
        // updatedAt will be handled by Mongoose timestamps
      };
      if (lastConnectedAt) updateData.lastConnectedAt = lastConnectedAt;
      if (phoneNumber) updateData.phoneNumber = phoneNumber;

      // Query by connectionName AND userId to ensure we update the correct user's connection
      const persistedConnection = await WhatsAppConnection.findOneAndUpdate(
        { connectionName, userId }, // Query by composite key
        { $set: updateData, $setOnInsert: { userId: userId } }, // Ensure userId is set on insert
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      logger.info(
        { connectionName, status, autoReconnect, botProfileId, userId },
        `DB: Persisted connection details for ${connectionName} for user ${userId}.`
      );
      return persistedConnection;
    } catch (dbError) {
      // Handle duplicate key error if upsert tries to create a new one that violates unique(userId, connectionName)
      // This should ideally be caught by a pre-check in the service layer.
      if (dbError.code === 11000) {
        logger.error(
          { err: dbError, connectionName, userId },
          "DB: Duplicate key error on saveConnectionDetails. This might indicate a race condition or logic error."
        );
      } else {
        logger.error(
          { err: dbError, connectionName, botProfileId, userId },
          "DB: Failed to persist WhatsApp connection details."
        );
      }
      throw dbError;
    }
  }

  /**
   * Updates connection status, scoped by userId.
   * @param {string} connectionName
   * @param {string|mongoose.Types.ObjectId} userId
   * @param {string} status
   * @param {boolean} autoReconnect
   * @param {string|null} phoneNumber
   */
  async updateConnectionStatus(
    connectionName,
    userId, // ADDED userId
    status,
    autoReconnect,
    phoneNumber = null
  ) {
    if (!userId) {
      logger.error(
        { connectionName, status },
        "DB: userId is required to update WhatsApp connection status."
      );
      // Decide: throw error or just log and return? For status updates, perhaps log and return.
      return;
    }
    try {
      const updateData = {
        lastKnownStatus: status,
        autoReconnect,
        // updatedAt handled by Mongoose
      };
      if (status === "connected" || status === "authenticated") {
        updateData.lastConnectedAt = new Date();
      }
      if (phoneNumber) {
        updateData.phoneNumber = phoneNumber;
      }
      // UpdateOne based on connectionName AND userId
      const result = await WhatsAppConnection.updateOne(
        { connectionName, userId },
        { $set: updateData }
      );
      if (result.matchedCount > 0) {
        logger.info(
          { connectionName, userId, status, autoReconnect },
          `DB: Updated connection status for ${connectionName} for user ${userId}.`
        );
      } else {
        logger.warn(
          { connectionName, userId, status },
          `DB: No connection found for ${connectionName} for user ${userId} to update status.`
        );
      }
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName, userId },
        "DB: Failed to update WhatsApp connection status."
      );
    }
  }

  /**
   * Updates last attempted reconnect time, scoped by userId.
   * @param {string} connectionName
   * @param {string|mongoose.Types.ObjectId} userId
   */
  async updateLastAttemptedReconnect(connectionName, userId) {
    // ADDED userId
    if (!userId) {
      logger.error(
        { connectionName },
        "DB: userId is required to update last attempted reconnect."
      );
      return;
    }
    try {
      await WhatsAppConnection.updateOne(
        { connectionName, userId }, // Scope by userId
        {
          $set: {
            lastAttemptedReconnectAt: new Date(),
            lastKnownStatus: "reconnecting",
          },
        }
      );
      // logger.debug for less critical updates
      logger.debug(
        { connectionName, userId },
        "DB: Updated last attempted reconnect time."
      );
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName, userId },
        "DB: Failed to update last attempted reconnect time."
      );
    }
  }

  /**
   * Gets connections to reconnect. This should ideally be scoped if the service instance is user-specific.
   * If the service is global, it might fetch all, but then reconnect logic needs user context.
   * For now, assuming this is called in a context where filtering by user might happen later, or the service is designed to handle all.
   * To make it fully robust for a multi-user system where one service instance handles all, this would need careful design.
   * However, typically, a user initiates their own connections, so the reconnect logic might be user-triggered.
   * If it's a global startup reconnect, it fetches all and uses their stored userId.
   */
  async getConnectionsToReconnect() {
    try {
      // Selects all necessary fields including userId and botProfileId for re-initialization.
      return await WhatsAppConnection.find({ autoReconnect: true })
        .select("connectionName botProfileId userId") // Ensure userId is selected
        .lean();
    } catch (dbError) {
      logger.error(
        { err: dbError },
        "DB: Error querying connections for auto-reconnection."
      );
      return [];
    }
  }
}

export default new WhatsAppConnectionPersistence();
