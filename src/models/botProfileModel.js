// src\models\botProfileModel.js
import mongoose from "mongoose";
import logger from "../utils/logger.js"; // Assuming logger is in utils

/**
 * @openapi
 * components:
 *   schemas:
 *     McpServer:
 *       type: object
 *       required:
 *         - name
 *         - command
 *         - enabled
 *       properties:
 *         name:
 *           type: string
 *           description: Name of the MCP server.
 *         command:
 *           type: string
 *           description: Command to execute on the MCP server.
 *         args:
 *           type: array
 *           items:
 *             type: string
 *           description: Arguments for the command.
 *         enabled:
 *           type: boolean
 *           default: true
 *           description: Whether this MCP server configuration is enabled.
 *     KnowledgeBaseItem:
 *       type: object
 *       required:
 *         - topic
 *         - content
 *       properties:
 *         topic:
 *           type: string
 *           description: The topic or question this knowledge item addresses.
 *         content:
 *           type: string
 *           description: The information or answer related to the topic.
 *     ExampleResponseItem:
 *       type: object
 *       properties:
 *         scenario:
 *           type: string
 *           description: The user's input or situation.
 *         response:
 *           type: string
 *           description: The bot's ideal response to the scenario.
 *     EdgeCaseItem:
 *       type: object
 *       properties:
 *         case:
 *           type: string
 *           description: The specific edge case or difficult situation.
 *         action:
 *           type: string
 *           description: How the bot should act or respond in this case.
 *     ToolInfo:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Name of the tool.
 *         description:
 *           type: string
 *           description: Description of what the tool does.
 *         purposes:
 *           type: array
 *           items:
 *             type: string
 *           description: List of purposes or capabilities of the tool.
 *     BotProfile:
 *       type: object
 *       required:
 *         - name
 *         - identity
 *         - userId
 *       properties:
 *         _id:
 *           type: string
 *           format: ObjectId
 *           description: The unique identifier for the bot profile.
 *         name:
 *           type: string
 *           description: Unique name of the bot profile (scoped per user).
 *         description:
 *           type: string
 *           maxLength: 500
 *           description: A short bio or description for the bot.
 *         identity:
 *           type: string
 *           description: The core persona and role of the bot.
 *         communicationStyle:
 *           type: string
 *           enum: ["Formal", "Friendly", "Humorous", "Professional", "Custom"]
 *           default: "Friendly"
 *           description: The bot's general style of communication.
 *         primaryLanguage:
 *           type: string
 *           default: "en"
 *           description: The main language the bot operates in.
 *         secondaryLanguage:
 *           type: string
 *           description: An optional secondary language.
 *         languageRules:
 *           type: array
 *           items:
 *             type: string
 *           description: Specific linguistic rules or quirks for the bot.
 *         knowledgeBaseItems:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/KnowledgeBaseItem'
 *           description: Collection of specific information snippets for the bot.
 *         tags:
 *           type: array
 *           items:
 *             type: string
 *           description: Keywords or tags for categorizing or finding the bot/its knowledge.
 *         initialInteraction:
 *           type: array
 *           items:
 *             type: string
 *           description: Phrases the bot can use to start a conversation.
 *         interactionGuidelines:
 *           type: array
 *           items:
 *             type: string
 *           description: General guidelines for how the bot should interact.
 *         exampleResponses:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/ExampleResponseItem'
 *           description: Examples of how the bot should respond in certain scenarios.
 *         edgeCases:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/EdgeCaseItem'
 *           description: How the bot should handle specific difficult or unexpected situations.
 *         tools:
 *           $ref: '#/components/schemas/ToolInfo'
 *         privacyAndComplianceGuidelines:
 *           type: string
 *           description: Guidelines related to data privacy and compliance.
 *         mcpServers:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/McpServer'
 *           description: Configuration for MCP servers the bot might interact with.
 *         userId:
 *           type: string
 *           format: ObjectId
 *           description: The ID of the user who owns this bot profile.
 *         isEnabled:
 *           type: boolean
 *           default: true
 *           description: Whether the bot is active and usable by its owner.
 *         isPubliclyListed:
 *           type: boolean
 *           default: false
 *           description: Whether the bot profile is listed publicly (for future use).
 *         totalPromptTokensUsed:
 *           type: number
 *           default: 0
 *         totalCompletionTokensUsed:
 *           type: number
 *           default: 0
 *         totalTokensUsed:
 *           type: number
 *           default: 0
 *         lastUsedAt:
 *           type: string
 *           format: date-time
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: Timestamp of when the profile was created.
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: Timestamp of the last update.
 */

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
    args: [{ type: String, trim: true }], // Args are strings, trimmed
    enabled: { type: Boolean, default: true, required: true },
  },
  { _id: false } // No separate _id for subdocuments unless needed for specific referencing
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
    // Unique index is defined below (userId, name)
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
    // Simple structure for now
    name: { type: String, trim: true },
    description: { type: String, trim: true },
    purposes: [{ type: String, trim: true }],
  },

  privacyAndComplianceGuidelines: { type: String, trim: true },
  mcpServers: [McpServerSchema],

  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User", // Assumes a User model exists
    required: true,
    index: true, // Index for faster queries by user
  },

  isEnabled: { type: Boolean, default: true, required: true },
  isPubliclyListed: { type: Boolean, default: false },

  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, immutable: true }, // createdAt should not change

  // Token usage aggregates
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

// Indexes
// Ensures bot name is unique per user. This is crucial.
BotProfileSchema.index({ userId: 1, name: 1 }, { unique: true });
BotProfileSchema.index({ updatedAt: -1 }); // For sorting by recent updates
// BotProfileSchema.index({ createdAt: -1 }); // Already immutable and default sorted by _id usually
BotProfileSchema.index({ isPubliclyListed: 1, name: 1 }); // For querying public profiles

// Pre-save hook to update `updatedAt`
BotProfileSchema.pre("save", function (next) {
  if (this.isModified()) {
    // Only update if actually modified
    this.updatedAt = new Date();
  }
  // Calculate totalTokensUsed before saving if prompt/completion tokens changed
  if (
    this.isModified("totalPromptTokensUsed") ||
    this.isModified("totalCompletionTokensUsed")
  ) {
    this.totalTokensUsed =
      (this.totalPromptTokensUsed || 0) + (this.totalCompletionTokensUsed || 0);
  }
  next();
});

/**
 * Logs token usage for a given BotProfile.
 * @param {Object} params - Parameters for logging token usage.
 * @param {string} params.botProfileId - The ID of the BotProfile.
 * @param {number} params.promptTokens - Number of prompt tokens used.
 * @param {number} params.completionTokens - Number of completion tokens used.
 * @returns {Promise<BotProfileDocument|null>} The updated BotProfile document or null if not found.
 * @throws {Error} If input parameters are invalid.
 */
BotProfileSchema.statics.logTokenUsage = async function ({
  botProfileId,
  promptTokens,
  completionTokens,
}) {
  // LBA/SSE: Enhanced validation for token logging input.
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

  // DS: Using findByIdAndUpdate for atomicity.
  return this.findByIdAndUpdate(
    botProfileId,
    {
      $inc: {
        totalPromptTokensUsed: promptTokens,
        totalCompletionTokensUsed: completionTokens,
        // totalTokensUsed will be updated by pre-save hook now, but $inc can also work here directly.
        // For consistency with pre-save, we can remove this direct $inc for totalTokensUsed
        // if pre-save hook correctly handles it based on the $inc of its components.
        // However, $inc is atomic. If pre-save hook isn't guaranteed to fire correctly with $inc, direct $inc here is safer.
        // Let's keep direct $inc for totalTokensUsed for clarity and atomicity.
        totalTokensUsed: totalTokens,
      },
      $set: { lastUsedAt: new Date() },
    },
    { new: true, runValidators: true } // `new: true` returns the modified document. `runValidators` ensures schema validation on update.
  ).catch((err) => {
    logger.error(
      { err, botProfileId, promptTokens, completionTokens },
      "Error in logTokenUsage update operation."
    );
    throw err; // Re-throw to be caught by calling function
  });
};

export default mongoose.model("BotProfile", BotProfileSchema);
