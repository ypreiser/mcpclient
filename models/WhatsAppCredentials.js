import mongoose from "mongoose";

const whatsAppCredentialsSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  credentials: {
    type: Object,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastUsed: {
    type: Date,
    default: Date.now,
  },
});

const WhatsAppCredentials = mongoose.model(
  "WhatsAppCredentials",
  whatsAppCredentialsSchema
);

export default WhatsAppCredentials;
