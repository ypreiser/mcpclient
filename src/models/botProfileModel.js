// mcpclient/models/botProfileModel.js
import mongoose from "mongoose";
import logger from "../utils/logger.js";

// OpenAPI/JSDoc comments from previous full version should be retained here for context.
// Omitting them for brevity in this direct fix response.

const McpServerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "MCP Server name is required."],
      trim: true,
    },
    command: {
      type: String,
      required: [true, "MCP Server command is required."],
      trim: true,
    },
    args: [{ type: String, trim: true }],
    enabled: { type: Boolean, default: true, required: true },
  },
  { _id: false }
);

const KnowledgeBaseItemSchema = new mongoose.Schema(
  {
    topic: {
      type: String,
      required: [true, "Knowledge item topic is required."],
      trim: true,
    },
    content: {
      type: String,
      required: [true, "Knowledge item content is required."],
      trim: true,
    },
  },
  { _id: false }
);

const BotProfileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Bot profile name is required."],
    trim: true,
    minlength: [3, "Bot name must be at least 3 characters long."],
    maxlength: [100, "Bot name cannot exceed 100 characters."],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Description cannot exceed 500 characters."],
  },
  identity: {
    type: String,
    required: [true, "Bot identity is required."],
    trim: true,
  },
  communicationStyle: {
    type: String,
    trim: true,
    enum: {
      values: ["Formal", "Friendly", "Humorous", "Professional", "Custom"],
      message: "{VALUE} is not a supported communication style.",
    },
    default: "Friendly",
  },

  primaryLanguage: { type: String, trim: true, default: "en" },
  secondaryLanguage: { type: String, trim: true },
  languageRules: [{ type: String, trim: true }],

  knowledgeBaseItems: [KnowledgeBaseItemSchema],
  tags: [{ type: String, trim: true }],

  initialInteraction: [{ type: String, trim: true }],
  interactionGuidelines: [{ type: String, trim: true }],

  exampleResponses: [
    {
      scenario: { type: String, trim: true },
      response: { type: String, trim: true },
      _id: false,
    },
  ],
  edgeCases: [
    {
      case: { type: String, trim: true },
      action: { type: String, trim: true },
      _id: false,
    },
  ],

  tools: {
    name: { type: String, trim: true },
    description: { type: String, trim: true },
    purposes: [{ type: String, trim: true }],
  },

  privacyAndComplianceGuidelines: { type: String, trim: true },
  mcpServers: [McpServerSchema],

  userId: {
    // This is the owner of the BotProfile
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true, // Must be set by the backend based on authenticated user
    index: true,
  },

  isEnabled: { type: Boolean, default: true, required: true }, // Consolidated 'active' flag

  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, immutable: true },

  totalPromptTokensUsed: { type: Number, default: 0, required: true, min: 0 },
  totalCompletionTokensUsed: {
    type: Number,
    default: 0,
    required: true,
    min: 0,
  },
  totalTokensUsed: { type: Number, default: 0, required: true, min: 0 },
  lastUsedAt: { type: Date },
});

BotProfileSchema.index({ userId: 1, name: 1 }, { unique: true });
BotProfileSchema.index({ updatedAt: -1 });
BotProfileSchema.index({ isEnabled: 1, name: 1 });

BotProfileSchema.pre("save", function (next) {
  if (this.isModified()) {
    this.updatedAt = new Date();
  }
  if (
    this.isModified("totalPromptTokensUsed") ||
    this.isModified("totalCompletionTokensUsed")
  ) {
    this.totalTokensUsed =
      (this.totalPromptTokensUsed || 0) + (this.totalCompletionTokensUsed || 0);
  }
  next();
});

BotProfileSchema.statics.logTokenUsage = async function ({
  botProfileId,
  promptTokens,
  completionTokens,
}) {
  if (!mongoose.Types.ObjectId.isValid(botProfileId)) {
    logger.warn(
      { botProfileId, promptTokens, completionTokens },
      "Invalid botProfileId for logging token usage."
    );
    throw new Error("Invalid botProfileId format.");
  }
  if (typeof promptTokens !== "number" || promptTokens < 0) {
    logger.warn(
      { botProfileId, promptTokens },
      "Invalid promptTokens value for logging."
    );
    throw new Error("Prompt tokens must be a non-negative number.");
  }
  if (typeof completionTokens !== "number" || completionTokens < 0) {
    logger.warn(
      { botProfileId, completionTokens },
      "Invalid completionTokens value for logging."
    );
    throw new Error("Completion tokens must be a non-negative number.");
  }

  const totalTokens = promptTokens + completionTokens;

  return this.findByIdAndUpdate(
    botProfileId,
    {
      $inc: {
        totalPromptTokensUsed: promptTokens,
        totalCompletionTokensUsed: completionTokens,
        totalTokensUsed: totalTokens,
      },
      $set: { lastUsedAt: new Date() },
    },
    { new: true, runValidators: true }
  ).catch((err) => {
    logger.error(
      { err, botProfileId, promptTokens, completionTokens },
      "Error in logTokenUsage update operation."
    );
    throw err;
  });
};

export default mongoose.model("BotProfile", BotProfileSchema);
