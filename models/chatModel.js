import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system", "tool"],
      required: true,
    },

    // content field can store:
    // 1. A string (for text-only messages).
    // 2. An array of "parts" for multi-modal messages (e.g., text and images/files).
    //    Each part will be an object like:
    //    { type: "text", text: "..." }
    //    { type: "image", image: "URL_or_Buffer_or_Base64", mimeType?: "..." }
    //    { type: "file", data: "URL_or_Buffer_or_Base64", mimeType: "...", filename?: "..." }
    //    When using URLs (e.g., from Cloudinary), they will be stored directly here.
    content: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    toolCalls: { type: mongoose.Schema.Types.Mixed }, // For AI tool calls (e.g., function calling results)
    toolCallId: { type: String }, // For AI tool call ID, if the message is a tool response
    name: { type: String }, // For tool name if role is 'tool'
    timestamp: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed", "pending"],
      default: "sent",
    },
    // attachments: Stores metadata of files uploaded by the user for this message.
    // This is primarily for application-level tracking and display.
    // The actual file content (via URL) for the AI is embedded in the `content` field if multi-modal.
    attachments: [
      {
        _id: false, // Usually not needed for sub-array elements unless specifically queried/referenced
        url: { type: String, required: true }, // Cloudinary URL (or other storage)
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true }, // Size in bytes
        uploadedAt: { type: Date, default: Date.now },
        // Optional: you might want to store a unique ID for the attachment itself if needed
        // attachmentId: { type: String, default: () => new mongoose.Types.ObjectId().toHexString() },
      },
    ],
  },
  { _id: true } // Ensure subdocuments get IDs if needed for direct updates/references, though usually not for messages.
);

const chatSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true }, // Unique session identifier (e.g., UUID)
  systemPromptName: { type: String }, // Track which system prompt is active for this chat
  systemPromptId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SystemPrompt",
    required: true, // Assuming a chat must be associated with a system prompt
    index: true,
  },
  source: {
    type: String,
    enum: ["whatsapp", "webapp"], // Origin of the chat
    required: true,
    index: true,
  },
  userId: {
    // User associated with this chat (e.g., the owner of the system prompt or the authenticated user)
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  messages: [messageSchema],
  metadata: {
    userName: { type: String }, // User's name, if available (e.g., from WhatsApp contact or profile)
    connectionName: { type: String, index: true }, // For WhatsApp, which connection this chat belongs to
    lastActive: { type: Date, default: Date.now, index: true },
    isArchived: { type: Boolean, default: false, index: true },
    tags: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    // webappSessionId was redundant if sessionId is already unique per chat.
    // If sessionId is unique across all sources, it's fine.
    // If sessionId can collide between 'whatsapp' and 'webapp', then a compound index or specific logic is needed.
    // The current `chatSchema.index({ sessionId: 1, source: 1 }, { unique: true });` handles this.
  },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now, index: true },
});

// Indexes for efficient querying
chatSchema.index({ userId: 1, source: 1, "metadata.lastActive": -1 });
chatSchema.index({ sessionId: 1, source: 1 }, { unique: true }); // Ensures sessionId + source is unique

// Pre-save middleware to update `updatedAt` timestamp
chatSchema.pre("save", function (next) {
  if (this.isModified()) { // Only update if something has changed
    this.updatedAt = new Date();
  }
  next();
});

export default mongoose.model("Chat", chatSchema);