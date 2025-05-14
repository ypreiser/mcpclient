import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import logger from "./utils/logger.js";
import systemPromptRoutes from "./routes/systemPromptRoute.js";
import whatsappRoutes from "./routes/whatsappRoute.js";
import authRoutes, { requireAuth } from "./routes/authRoute.js";
import publicChatRoutes from "./routes/publicChatRoute.js";

dotenv.config();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

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
app.use(helmet());

const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// Rate Limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"), // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use("/", limiter);

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
//log incoming requests
app.use("/", (req, res, next) => {
  if (req.body?.password) {
    const bodyWithMaskedPassword = { ...req.body, password: "MASKEDPASSWORD" };
    logger.info(
      {
        method: req.method,
        path: req.path,
        body: bodyWithMaskedPassword,
        cookie: req.cookies ? req.cookies : "No cookies",
      },
      "Incoming request"
    );
  } else {
    logger.info(
      {
        method: req.method,
        path: req.path,
        body: req.body,
        cookie: req.cookies ? req.cookies : "No cookies",
      },
      "Incoming request"
    );
  }
  next();
});

// Protect all /api routes except auth, health, and public chat endpoints
app.use((req, res, next) => {
  const openPaths = [
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/register",
    "/health",
  ];
  // Allow all /chat/* public endpoints
  if (
    openPaths.includes(req.path) ||
    req.path.startsWith("/chat/") ||
    (req.path.startsWith("/api/auth/") && req.method === "OPTIONS")
  ) {
    return next();
  }
  return requireAuth(req, res, next);
});

app.use("/api/auth", authRoutes);
app.use("/api/systemprompt", systemPromptRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/chat", publicChatRoutes); // Register public chat routes

// Add utility functions to app.locals
app.locals.uuidv4 = uuidv4;

// Basic health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", timestamp: new Date().toISOString() });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(
    { err, path: req.path, body: req.body },
    "Unhandled error occurred"
  );
  res.status(err.status || 500).json({
    error: {
      message: err.message || "Internal Server Error",
      // Optionally include stack in development
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    },
  });
});

// Initialize everything and start server
export async function startServer() {
  // Renamed initialize to startServer
  try {
    await initializeMongoDB();
    // Only listen if not in test environment or if explicitly told to
    if (
      process.env.NODE_ENV !== "test" ||
      process.env.START_SERVER === "true"
    ) {
      const serverInstance = app.listen(PORT, () => {
        // Store server instance
        logger.info(`Server is running on port ${PORT}`);
      });
      return serverInstance; // Return for potential programmatic closing
    }
    logger.info("Server initialized for testing (not listening on port).");
    return null; // Or return the app itself if preferred for testing
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize server:");
    process.exit(1);
  }
}

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

// Start server only if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check if run directly
  // Only skip server start if explicitly in test mode without START_SERVER flag
  const isTestMode =
    process.env.NODE_ENV === "test" && process.env.START_SERVER !== "true";
  const isDev = process.env.NODE_ENV === "development" || !process.env.NODE_ENV;

  if (!isTestMode || isDev) {
    startServer().then((serverInstance) => {
      if (serverInstance) {
        const shutdown = (signal) => gracefulShutdown(signal, serverInstance);
        process.on("SIGTERM", () => shutdown("SIGTERM"));
        process.on("SIGINT", () => shutdown("SIGINT"));
      }
    });
  }
}

export default app; // Export the app for testing
