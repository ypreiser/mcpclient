// src\models\chatModel.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system", "tool"],
      required: true,
    },
    content: {
      // Can be string or array of parts for multi-modal
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    toolCalls: { type: mongoose.Schema.Types.Mixed },
    toolCallId: { type: String },
    name: { type: String }, // For tool name if role is 'tool'
    timestamp: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed", "pending"],
      default: "sent",
    },
    attachments: [
      // Metadata for user-uploaded files related to this message
      {
        _id: false,
        url: { type: String, required: true },
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { _id: true }
);

const chatSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  botProfileName: { type: String, required: false }, // Denormalized name from BotProfile
  botProfileId: {
    // UPDATED
    type: mongoose.Schema.Types.ObjectId,
    ref: "BotProfile", // UPDATED
    required: true,
    index: true,
  },
  source: {
    type: String,
    enum: ["whatsapp", "webapp", "api"], // Added 'api' as a potential source
    required: true,
    index: true,
  },
  userId: {
    // User who owns the BotProfile, or the interacting user if different context
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  messages: [messageSchema],
  messageCount: { type: Number, default: 0, required: true, min: 0 },
  metadata: {
    userName: { type: String, trim: true },
    connectionName: { type: String, index: true }, // For WhatsApp
    lastActive: { type: Date, default: Date.now, index: true },
    isArchived: { type: Boolean, default: false, index: true },
    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
  },
  createdAt: { type: Date, default: Date.now, immutable: true, index: true },
  updatedAt: { type: Date, default: Date.now, index: true },
});

chatSchema.index({ userId: 1, source: 1, "metadata.lastActive": -1 });
chatSchema.index({ sessionId: 1, source: 1 }, { unique: true }); // sessionId must be unique per source
chatSchema.index({ botProfileId: 1, "metadata.lastActive": -1 }); // For fetching recent chats for a bot

chatSchema.pre("save", function (next) {
  // Always update 'updatedAt' on save, unless explicitly skipping for some bulk op
  this.updatedAt = new Date();
  // messageCount should be explicitly managed by incrementing when messages are pushed.
  // If messages array is directly manipulated, this might not be accurate.
  // Consider a virtual or a more robust update mechanism if direct array manipulation is common.
  if (this.isModified("messages")) {
    this.messageCount = this.messages.length;
  }
  next();
});

// Add a static helper for test setup: createPublicChatSession
chatSchema.statics.createPublicChatSession = async function ({
  sessionId,
  botProfileId,
  botProfileName,
  userId,
  messages = [],
  metadata = {},
}) {
  // This helper is for test setup only
  const chat = new this({
    sessionId,
    botProfileId,
    botProfileName,
    source: "webapp",
    userId,
    messages,
    metadata: {
      userName: metadata.userName || "Test User",
      lastActive: metadata.lastActive || new Date(),
      isArchived: metadata.isArchived || false,
      ...metadata,
    },
  });
  await chat.save();
  return chat;
};

export default mongoose.model("Chat", chatSchema);
