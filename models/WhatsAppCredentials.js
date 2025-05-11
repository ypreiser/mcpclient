import mongoose from "mongoose";
import logger from "./utils/logger.js"; // Import logger

// This model is for storing WhatsApp session credentials IF NOT using wwebjs-mongo's RemoteAuth,
// or if you need to manage them outside of RemoteAuth's default behavior.
// If RemoteAuth with MongoStore is the sole method, this model might be redundant
// as wwebjs-mongo handles session data in its own collection ('whatsapp_sessions' by default).
// The whatsappService currently tries to delete from this using `connectionName`.

const whatsAppCredentialsSchema = new mongoose.Schema({
  // 'connectionName' is used by your whatsappService to identify client instances
  connectionName: {
    type: String,
    required: true,
    unique: true, // Each connection name should be unique
    index: true,
  },
  // 'credentials' would store the actual session data if managed manually.
  // For RemoteAuth, this is handled by the store itself.
  credentials: {
    type: Object, // Structure depends on what whatsapp-web.js session data looks like
    required: false, // May not be needed if RemoteAuth is primary
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

// Log a warning if this model is being instantiated, as it might indicate a misunderstanding
// of how wwebjs-mongo RemoteAuth works, or a deliberate custom session management strategy.
whatsAppCredentialsSchema.pre('save', function(next) {
  // logger.warn({ connectionName: this.connectionName }, "WhatsAppCredentials model is being used. Ensure this is intended alongside wwebjs-mongo RemoteAuth.");
  next();
});


const WhatsAppCredentials = mongoose.model(
  "WhatsAppCredentials",
  whatsAppCredentialsSchema
);

export default WhatsAppCredentials;