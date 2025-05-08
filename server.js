import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import systemPromptRoutes from "./routes/systemPromptRoute.js";
import chatRoutes from "./routes/chatRoute.js";
import whatsappRoutes from "./routes/whatsappRoute.js";
import { initializeAI } from "./mcpClient.js";
import systemPromptModel from "./models/systemPromptModel.js";

dotenv.config();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const systemPromptName = process.env.SYSTEM_PROMPT_NAME;

if (!MONGODB_URI) {
  console.error(
    "MONGODB_URI is not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Initialize MongoDB connection
async function initializeMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {});
    console.log("Connected to MongoDB successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

// Load system prompt
async function loadSystemPrompt() {
  try {
    const promptDoc = await systemPromptModel.findOne({
      name: systemPromptName,
    });
    if (!promptDoc) {
      console.warn(`No system prompt found with name: ${systemPromptName}`);
      return null;
    }
    return promptDoc;
  } catch (error) {
    console.error("Error loading system prompt:", error);
    return null;
  }
}

// Set up routes
app.use("/api/systemprompt", systemPromptRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/whatsapp", whatsappRoutes);

// Add utility functions to app.locals
app.locals.uuidv4 = uuidv4;

// Initialize everything and start server
async function initialize() {
  try {
    await initializeMongoDB();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize server:", error);
    process.exit(1);
  }
}

initialize();

// Handle cleanup on server shutdown
process.on("SIGTERM", async () => {
  await mongoose.connection.close();
  process.exit(0);
});
