import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system", "tool"],
      required: true,
    }, // Added tool and system roles
    content: { type: String, required: true },
    toolCalls: { type: mongoose.Schema.Types.Mixed }, // For AI tool calls
    toolCallId: { type: String }, // For AI tool call ID
    name: { type: String }, // For tool name if role is 'tool'
    timestamp: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["sent", "delivered", "read", "failed", "pending"],
      default: "sent",
    },
  },
  { _id: true }
); // Ensure subdocuments get IDs if needed, or disable if not

const chatSchema = new mongoose.Schema({
  sessionId: { type: String, required: true }, // This is the chat identifier (e.g., user's phone number for WhatsApp, UUID for web)
  source: {
    type: String,
    enum: ["whatsapp", "webapp"],
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
    systemPromptName: { type: String }, // Track which system prompt is active for this chat
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Define all indexes in one place to avoid duplicates
chatSchema.index(
  { sessionId: 1, source: 1, "metadata.connectionName": 1 },
  {
    unique: true,
    partialFilterExpression: { source: "whatsapp" },
  }
);

chatSchema.index(
  { sessionId: 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: { source: "webapp" },
  }
);

chatSchema.index({ "metadata.lastActive": -1 });
chatSchema.index({ source: 1 });
chatSchema.index({ createdAt: 1 });
chatSchema.index({ updatedAt: 1 });

export default mongoose.model("Chat", chatSchema);
