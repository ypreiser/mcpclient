import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import logger from "./utils/logger.js"; // Import pino logger
import systemPromptRoutes from "./routes/systemPromptRoute.js";
import chatRoutes from "./routes/chatRoute.js";
import whatsappRoutes from "./routes/whatsappRoute.js";
// initializeAI is not directly used here anymore, mcpClient is a lib

dotenv.config();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
// const systemPromptName = process.env.SYSTEM_PROMPT_NAME; // Global default, if needed

if (!MONGODB_URI) {
  logger.error(
    "MONGODB_URI is not set. Please set it in your environment variables."
  );
  process.exit(1);
}
if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  logger.error(
    "GOOGLE_GENERATIVE_AI_API_KEY is not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const app = express();

// Security Middlewares
app.use(helmet()); // Adds various security headers
app.use(cors()); // Consider more restrictive CORS for production
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"), // limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use("/api/", limiter); // Apply to all API routes

// Initialize MongoDB connection
async function initializeMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {});
    logger.info("Connected to MongoDB successfully");
  } catch (error) {
    logger.error({ err: error }, "MongoDB connection error:");
    process.exit(1);
  }
}

// Set up routes
app.use("/api/systemprompt", systemPromptRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/whatsapp", whatsappRoutes);

// Add utility functions to app.locals
app.locals.uuidv4 = uuidv4;

// Basic health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", timestamp: new Date().toISOString() });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err, path: req.path, body: req.body }, "Unhandled error occurred");
  res.status(err.status || 500).json({
    error: {
      message: err.message || "Internal Server Error",
      // Optionally include stack in development
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    },
  });
});


// Initialize everything and start server
async function initialize() {
  try {
    await initializeMongoDB();
    // AI initialization is now handled on-demand by routes/services that need it
    // or could be pre-initialized for specific global use cases if required.

    app.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize server:");
    process.exit(1);
  }
}

initialize();

// Handle cleanup on server shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Closing connections...`);
  try {
    await mongoose.connection.close();
    logger.info("MongoDB connection closed.");
    // Add any other cleanup here (e.g., closing AI clients if globally managed)
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown:");
  }
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT")); // Handle Ctrl+C