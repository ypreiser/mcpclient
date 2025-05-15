import mongoose from "mongoose";
import WhatsAppConnection from "../models/whatsAppConnectionModel.js";
import logger from "../utils/logger.js";

class WhatsAppConnectionPersistence {
  async getByConnectionName(connectionName) {
    try {
      return await WhatsAppConnection.findOne({ connectionName }).lean();
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName },
        "DB: Failed to get WhatsApp connection by name."
      );
      throw dbError;
    }
  }

  async saveConnectionDetails(
    connectionName,
    systemPromptName,
    userId,
    status,
    autoReconnect,
    lastConnectedAt = null
  ) {
    try {
      const updateData = {
        systemPromptName,
        userId,
        autoReconnect,
        lastKnownStatus: status,
        updatedAt: new Date(),
      };
      if (lastConnectedAt) {
        updateData.lastConnectedAt = lastConnectedAt;
      }

      const persistedConnection = await WhatsAppConnection.findOneAndUpdate(
        { connectionName },
        { $set: updateData },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      logger.info(
        `DB: Persisted connection details for ${connectionName}. Status: ${status}, Auto-reconnect: ${autoReconnect}`
      );
      return persistedConnection;
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName },
        "DB: Failed to persist WhatsApp connection details."
      );
      throw dbError; // Re-throw for higher-level handling if necessary
    }
  }

  async updateConnectionStatus(connectionName, status, autoReconnect) {
    try {
      const updateData = {
        lastKnownStatus: status,
        autoReconnect,
        updatedAt: new Date(),
      };
      if (status === "connected" || status === "authenticated") {
        updateData.lastConnectedAt = new Date();
      }
      await WhatsAppConnection.updateOne(
        { connectionName },
        { $set: updateData }
      );
      logger.info(
        `DB: Updated connection status for ${connectionName} to ${status}, autoReconnect: ${autoReconnect}.`
      );
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName },
        "DB: Failed to update WhatsApp connection status."
      );
    }
  }

  async updateLastAttemptedReconnect(connectionName) {
    try {
      await WhatsAppConnection.updateOne(
        { connectionName },
        {
          $set: {
            lastAttemptedReconnectAt: new Date(),
            lastKnownStatus: "initializing_startup",
          },
        }
      );
    } catch (dbError) {
      logger.error(
        { err: dbError, connectionName },
        "DB: Failed to update last attempted reconnect time."
      );
    }
  }

  async getConnectionsToReconnect() {
    try {
      return await WhatsAppConnection.find({ autoReconnect: true }).lean();
    } catch (dbError) {
      logger.error(
        { err: dbError },
        "DB: Error querying connections for auto-reconnection."
      );
      return []; // Return empty array on error to prevent startup crash
    }
  }
}

export default new WhatsAppConnectionPersistence();
