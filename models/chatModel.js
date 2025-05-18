import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system", "tool"],
      required: true,
    },

    content: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    toolCalls: { type: mongoose.Schema.Types.Mixed }, // For AI tool calls
    toolCallId: { type: String }, // For AI tool call ID
    name: { type: String }, // For tool name if role is 'tool'
    timestamp: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed", "pending"],
      default: "sent",
    },
    // Attachments: array of file metadata (if any) - Kept separate from content.
    // The `url` field here is where you will store the S3 URL or other file pointer (like a Google Drive URL).
    attachments: [
      {
        url: { type: String, required: true }, // Path, S3 URL, or Google Drive URL/File ID
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { _id: true } // Ensure subdocuments get IDs if needed
);

const chatSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  systemPromptName: { type: String }, // Track which system prompt is active for this chat
  systemPromptId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SystemPrompt",
    required: true, // Assuming a chat must be associated with a system prompt
  },
  source: {
    type: String,
    enum: ["whatsapp", "webapp"],
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  messages: [messageSchema],
  metadata: {
    userName: { type: String },
    connectionName: { type: String }, // For WhatsApp, which of our connections this chat belongs to
    lastActive: { type: Date, default: Date.now },
    isArchived: { type: Boolean, default: false },
    tags: [{ type: String }],
    notes: { type: String },
    // Added a field to store the session ID for webapp chats
    webappSessionId: { type: String, unique: true, sparse: true }, // Use sparse for optional unique index
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Indexes for efficient querying
chatSchema.index({ userId: 1, source: 1, "metadata.lastActive": -1 }); // Compound index for common queries
chatSchema.index({ sessionId: 1, source: 1 }, { unique: true }); // Ensure session+source is unique
chatSchema.index({ "metadata.isArchived": 1 });
chatSchema.index({ createdAt: 1 });
chatSchema.index({ updatedAt: 1 });
chatSchema.index({ systemPromptId: 1 });

// Pre-save middleware to update `updatedAt` timestamp and set webappSessionId
chatSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  // If it's a new document and webapp, set metadata.webappSessionId from sessionId
  // Only set if it's a webapp source and sessionId is present, and webappSessionId is not already set
  if (
    this.isNew &&
    this.source === "webapp" &&
    this.sessionId &&
    !this.metadata?.webappSessionId
  ) {
    this.metadata = this.metadata || {}; // Ensure metadata exists
    this.metadata.webappSessionId = this.sessionId;
  }
  next();
});

export default mongoose.model("Chat", chatSchema);
