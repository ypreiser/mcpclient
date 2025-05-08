import mongoose from "mongoose";

const SystemPromptSchema = new mongoose.Schema({
  name: { type: String, required: true },
  identity: { type: String, required: true },
  primaryLanguage: { type: String, required: false },
  secondaryLanguage: { type: String, required: false },
  languageRules: [{ type: String, required: false }],
  storeName: { type: String, required: false },
  storeAddress: { type: String, required: false },
  storePhone: { type: String, required: false },
  storeEmail: { type: String, required: false },
  openingHours: {
    Sunday: { type: String, required: false },
    Monday: { type: String, required: false },
    Tuesday: { type: String, required: false },
    Wednesday: { type: String, required: false },
    Thursday: { type: String, required: false },
    Friday: { type: String, required: false },
    Saturday: { type: String, required: false },
  },
  availableCategories: [{ type: String, required: false }],
  returnPolicy: { type: String, required: false },
  warrantyPolicy: { type: String, required: false },
  initialInteraction: [{ type: String, required: false }],
  customerServiceGuidelines: [{ type: String, required: false }],
  exampleResponses: [
    {
      scenario: { type: String, required: false },
      response: { type: String, required: false },
    },
  ],
  edgeCases: [
    {
      case: { type: String, required: false },
      action: { type: String, required: false },
    },
  ],
  tools: {
    name: { type: String, required: false },
    description: { type: String, required: false },
    purposes: [{ type: String, required: false }],
  },
  privacyAndComplianceGuidelines: { type: String, required: false },
  mcpServers: [
    {
      name: { type: String, required: true },
      command: { type: String, required: true },
      args: [{ type: String, required: false }],
      enabled: { type: Boolean, default: true },
    },
  ],
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.model("SystemPrompt", SystemPromptSchema);
