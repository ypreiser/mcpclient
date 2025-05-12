// models/apiKeyModel.js
import mongoose from "mongoose";

const ApiKeySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      description: "A unique name to reference this API key configuration.",
    },
    encryptedApiKey: {
      type: String,
      required: true,
      description: "The API key, encrypted.",
    },
    aiProvider: {
      type: String,
      required: true,
      enum: ["google", "openai", "anthropic", "custom"], // Add more as needed
      default: "google",
      description: "The AI provider this key is for.",
    },
    description: {
      type: String,
      trim: true,
      required: false,
      description: "Optional description for this API key.",
    },
    // You might add more fields like rate limits, usage quotas, associated models, etc.
  },
  { timestamps: true } // Adds createdAt and updatedAt
);

ApiKeySchema.index({ name: 1 });

export default mongoose.model("ApiKey", ApiKeySchema);
