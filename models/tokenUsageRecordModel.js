//mcpclient/models/tokenUsageRecordModel.js
import mongoose from "mongoose";

const TokenUsageRecordSchema = new mongoose.Schema({
  userId: {
    // The user account responsible for this usage (e.g., prompt owner, WA connection owner)
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  systemPromptId: {
    // The specific system prompt used, if applicable
    type: mongoose.Schema.Types.ObjectId,
    ref: "SystemPrompt",
    required: false,
    index: true,
  },
  systemPromptName: {
    // Denormalized name for easier querying without joins
    type: String,
    required: false,
  },
  chatId: {
    // The chat session this usage belongs to, if applicable
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chat",
    required: false,
    index: true,
  },
  source: {
    // e.g., 'webapp', 'whatsapp', 'api_call'
    type: String,
    required: true,
    index: true,
  },
  modelName: {
    // e.g., 'gemini-1.5-flash', 'gpt-4o'
    type: String,
    required: true,
  },
  promptTokens: {
    type: Number,
    required: true,
  },
  completionTokens: {
    type: Number,
    required: true,
  },
  totalTokens: {
    type: Number,
    required: true,
  },
  timestamp: {
    // When the usage occurred
    type: Date,
    default: Date.now,
    index: true,
  },
  // Optional: cost, if you calculate and store it at the time of transaction
  // cost: { type: Number },
});

// Compound indexes for common analytical queries
TokenUsageRecordSchema.index({ userId: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ systemPromptId: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ source: 1, timestamp: -1 });
TokenUsageRecordSchema.index({ modelName: 1, timestamp: -1 });

// TTL index to automatically delete records after a certain period, if desired for cost/storage management
// Example: delete records older than 2 years
// TokenUsageRecordSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 60 * 60 });

export default mongoose.model("TokenUsageRecord", TokenUsageRecordSchema);
