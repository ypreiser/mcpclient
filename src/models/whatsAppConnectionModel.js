// src\models\whatsAppConnectionModel.js
import mongoose from "mongoose";

const whatsAppConnectionSchema = new mongoose.Schema(
  {
    connectionName: {
      type: String,
      required: [true, "Connection name is required."],
      // unique: true, // REMOVE THIS LINE - uniqueness will be handled by compound index
      index: true, // Still good to index for individual lookups if needed
      trim: true,
      minlength: [3, "Connection name must be at least 3 characters."],
      maxlength: [100, "Connection name cannot exceed 100 characters."],
    },
    botProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BotProfile",
      required: [true, "A Bot Profile ID must be linked to this connection."],
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required for this connection."],
      index: true,
    },
    autoReconnect: {
      type: Boolean,
      default: true,
    },
    lastKnownStatus: {
      type: String,
      default: "unknown",
      enum: [
        "unknown",
        "new",
        "initializing",
        "qr_ready",
        "qr_pending_scan",
        "connected",
        "authenticated",
        "auth_failed",
        "reconnecting",
        "disconnected_permanent",
        "init_failed",
        "closed_manual",
        "closed_forced",
        "initializing_startup",
        "disconnected",
      ],
    },
    lastConnectedAt: { type: Date },
    lastAttemptedReconnectAt: { type: Date },
    phoneNumber: {
      type: String,
      default: null,
      index: true,
      trim: true,
    },
  },
  { timestamps: true }
);

// Compound unique index for connectionName per user
whatsAppConnectionSchema.index(
  { userId: 1, connectionName: 1 },
  { unique: true }
); // ADD THIS LINE

// Existing index for efficient querying of connections by user
// whatsAppConnectionSchema.index({ userId: 1, connectionName: 1 }); // This is now covered by the unique index above

export default mongoose.model("WhatsAppConnection", whatsAppConnectionSchema);
