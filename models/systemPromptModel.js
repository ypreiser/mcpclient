import mongoose from "mongoose";

const McpServerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    command: { type: String, required: true },
    args: [{ type: String, required: false }],
    enabled: { type: Boolean, default: true, required: true },
  },
  { _id: false }
);

const SystemPromptSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  identity: { type: String, required: true, trim: true },
  primaryLanguage: { type: String, trim: true },
  secondaryLanguage: { type: String, trim: true },
  languageRules: [{ type: String }],
  storeName: { type: String, trim: true },
  storeAddress: { type: String, trim: true },
  storePhone: { type: String, trim: true },
  storeEmail: { type: String, trim: true },
  openingHours: {
    type: Map,
    of: String,
    required: false,
  },
  availableCategories: [{ type: String }],
  returnPolicy: { type: String, trim: true },
  warrantyPolicy: { type: String, trim: true },
  initialInteraction: [{ type: String }],
  customerServiceGuidelines: [{ type: String }],
  exampleResponses: [
    {
      scenario: { type: String, required: false, trim: true },
      response: { type: String, required: false, trim: true },
      _id: false,
    },
  ],
  edgeCases: [
    {
      case: { type: String, required: false, trim: true },
      action: { type: String, required: false, trim: true },
      _id: false,
    },
  ],
  tools: {
    name: { type: String, trim: true },
    description: { type: String, trim: true },
    purposes: [{ type: String }],
  },
  privacyAndComplianceGuidelines: { type: String, trim: true },
  mcpServers: [McpServerSchema],
  userId: {
    // The user who owns this system prompt
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }, // For public listing

  // Token usage aggregates for this system prompt
  totalPromptTokensUsed: { type: Number, default: 0, required: true },
  totalCompletionTokensUsed: { type: Number, default: 0, required: true },
  totalTokensUsed: { type: Number, default: 0, required: true },
  lastUsedAt: { type: Date },
});

// Indexes
SystemPromptSchema.index({ userId: 1, name: 1 }, { unique: true }); // Ensures name is unique per user
SystemPromptSchema.index({ updatedAt: -1 });
SystemPromptSchema.index({ createdAt: -1 });
SystemPromptSchema.index({ isActive: 1, name: 1 }); // For querying active prompts

// Pre-save hook to update `updatedAt`
SystemPromptSchema.pre("save", function (next) {
  if (this.isModified()) {
    // Only update if actually modified to prevent versioning issues
    this.updatedAt = new Date();
  }
  next();
});

SystemPromptSchema.statics.logTokenUsage = async function ({
  systemPromptId,
  promptTokens,
  completionTokens,
}) {
  if (
    !systemPromptId ||
    typeof promptTokens !== "number" ||
    promptTokens < 0 ||
    typeof completionTokens !== "number" ||
    completionTokens < 0
  ) {
    throw new Error(
      "Invalid input for logging token usage to SystemPrompt model."
    );
  }
  const totalTokens = promptTokens + completionTokens;
  return this.findByIdAndUpdate(
    systemPromptId,
    {
      $inc: {
        totalPromptTokensUsed: promptTokens,
        totalCompletionTokensUsed: completionTokens,
        totalTokensUsed: totalTokens,
      },
      $set: { lastUsedAt: new Date() },
    },
    { new: true }
  );
};

export default mongoose.model("SystemPrompt", SystemPromptSchema);
