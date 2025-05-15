import mongoose from "mongoose";

const whatsAppConnectionSchema = new mongoose.Schema(
  {
    connectionName: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    systemPromptName: {
      type: String,
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    autoReconnect: {
      type: Boolean,
      default: true,
    },
    lastKnownStatus: {
      type: String,
      default: "unknown", // e.g., 'initializing', 'qr_ready', 'connected', 'authenticated', 'auth_failed', 'disconnected_permanent', 'closed_manual', 'qr_pending_scan'
    },
    lastConnectedAt: {
      type: Date,
    },
    lastAttemptedReconnectAt: {
      type: Date,
    },
  },
  { timestamps: true }
); // Adds createdAt and updatedAt

export default mongoose.model("WhatsAppConnection", whatsAppConnectionSchema);
