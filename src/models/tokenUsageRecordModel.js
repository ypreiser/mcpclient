// src\models\tokenUsageRecordModel.js
import mongoose from "mongoose";

const TokenUsageRecordSchema = new mongoose.Schema({
  userId: {
    // The user account responsible for this usage (e.g., bot profile owner)
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  botProfileId: {
    // UPDATED (The specific bot profile used)
    type: mongoose.Schema.Types.ObjectId,
    ref: "BotProfile", // UPDATED
    required: true, // Made required, as usage should always be tied to a bot
    index: true,
  },
  botProfileName: {
    // UPDATED (Denormalized name for easier querying)
    type: String,
    required: false, // Name can be looked up, but denormalizing is okay for records
  },
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chat",
    required: false, // Usage might not always be from a specific chat (e.g. direct API call to a tool)
    index: true,
  },
  source: {
    // e.g., 'webapp', 'whatsapp', 'api_tool_call'
    type: String,
    required: true,
    index: true,
  },
  modelName: {
    type: String,
    required: true,
  },
  promptTokens: { type: Number, required: true, min: 0 },
  completionTokens: { type: Number, required: true, min: 0 },
  totalTokens: { type: Number, required: true, min: 0 },
  timestamp: { type: Date, default: Date.now, index: true },
});

TokenUsageRecordSchema.index({ userId: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ botProfileId: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ source: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ modelName: 1, timestamp: -1 });

// Optional TTL index (as before)
// TokenUsageRecordSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 60 * 60 });

export default mongoose.model("TokenUsageRecord", TokenUsageRecordSchema);
