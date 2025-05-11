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
  name: { type: String, required: true, unique: true, trim: true }, // Added unique and trim
  identity: { type: String, required: true, trim: true },
  primaryLanguage: { type: String, trim: true },
  secondaryLanguage: { type: String, trim: true },
  languageRules: [{ type: String }],
  storeName: { type: String, trim: true },
  storeAddress: { type: String, trim: true },
  storePhone: { type: String, trim: true },
  storeEmail: { type: String, trim: true },
  openingHours: {
    // Using a flexible Map for days
    type: Map,
    of: String,
    required: false,
  },
  // Example: openingHours: { Sunday: "Closed", Monday: "9 AM - 5 PM" }
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
    // This structure might need to align with how AI SDK expects tools
    name: { type: String, trim: true },
    description: { type: String, trim: true },
    purposes: [{ type: String }],
    // If tools are more complex (e.g. schema for parameters), adjust here
  },
  privacyAndComplianceGuidelines: { type: String, trim: true },
  mcpServers: [McpServerSchema], // Use the sub-schema
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

// Define all indexes in one place
SystemPromptSchema.index({ updatedAt: -1 });
SystemPromptSchema.index({ createdAt: -1 });

export default mongoose.model("SystemPrompt", SystemPromptSchema);
