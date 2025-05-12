// models/systemPromptModel.js
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
  // --- NEW FIELDS ---
  aiModelName: {
    type: String,
    trim: true,
    required: false, // If not provided, will fallback to env var
    description:
      "The specific AI model to use (e.g., 'gemini-1.5-flash-latest', 'gpt-4o'). Falls back to GEMINI_MODEL_NAME env var if not set.",
  },
  apiKeyRef: {
    type: String,
    trim: true,
    required: false, // If not provided, will fallback to env var
    description:
      "Reference to the 'name' of an API key stored in the ApiKey collection. Falls back to GOOGLE_GENERATIVE_AI_API_KEY env var if not set.",
  },
  // --- END NEW FIELDS ---
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

SystemPromptSchema.index({ updatedAt: -1 });
SystemPromptSchema.index({ createdAt: -1 });
// Optional: index apiKeyRef if you query by it often, though SystemPrompts are usually fetched by name.
// SystemPromptSchema.index({ apiKeyRef: 1 });

export default mongoose.model("SystemPrompt", SystemPromptSchema);
