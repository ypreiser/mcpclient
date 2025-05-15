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
import adminRoutes from "./routes/adminRoute.js";
import chatRoutes from "./routes/chatRoute.js";
import { body, validationResult } from "express-validator";

// Load environment variables
dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI;

// Validate required environment variables
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

// CORS configuration
const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
app.use(
  cors({
    origin: allowedOrigin,
    credentials: true,
  })
);

// Parsing middlewares
app.use(express.json());
app.use(cookieParser());

// Rate Limiting - general
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"), // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use("/", limiter);

// Stricter rate limiting for authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // stricter for auth routes
});
app.use("/api/auth/", authLimiter);

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

// Create a reusable validation middleware factory
const createValidationMiddleware = (validations) => {
  return [
    ...validations,
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      next();
    },
  ];
};

// Log incoming requests (with password masking)
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

// Authentication middleware for protected routes
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

// Cookie security helper middleware for auth routes
// This properly belongs in authRoutes.js but including here for reference
const setCookieSecurely = (req, res, next) => {
  // Original res.cookie is saved
  const originalCookie = res.cookie;

  // Override res.cookie method to add security options
  res.cookie = function (name, value, options = {}) {
    const secureOptions = {
      ...options,
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    };
    return originalCookie.call(this, name, value, secureOptions);
  };

  next();
};

// Sample of how to use validation middleware
// This should be moved to your route files
app.post(
  "/api/example",
  createValidationMiddleware([
    body("username").isString().trim().isLength({ min: 3 }).escape(),
    body("email").isEmail().normalizeEmail(),
  ]),
  (req, res) => {
    // Handler logic here
    res.status(200).json({ success: true });
  }
);

// Register routes
app.use("/api/auth", setCookieSecurely, authRoutes);
app.use("/api/systemprompt", systemPromptRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/chat", publicChatRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/chats", chatRoutes);

// Add utility functions to app.locals
app.locals.uuidv4 = uuidv4;

// Basic health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP", timestamp: new Date().toISOString() });
});

// Custom API error
class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.name = "ApiError";
  }
}

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Check if it's our custom ApiError
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error(
    { err, path: req.path, body: req.body },
    "Unhandled error occurred"
  );

  res.status(statusCode).json({
    error: {
      message,
      // Only include stack trace in development
      stack:
        process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev"
          ? err.stack
          : undefined,
    },
  });
});

// Handle cleanup on server shutdown
const gracefulShutdown = async (signal, server) => {
  logger.info(`${signal} received. Closing connections...`);
  try {
    // Close server first to stop accepting new connections
    if (server) {
      server.close(() => {
        logger.info("HTTP server closed");
      });
    }

    // Close database connection
    await mongoose.connection.close();
    logger.info("MongoDB connection closed.");

    // Add any other cleanup here (e.g., closing AI clients if globally managed)
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown:");
  }

  // Allow some time for cleanup before exit
  setTimeout(() => {
    logger.info("Exiting process");
    process.exit(0);
  }, 500);
};

// Export everything needed for the starter
export { app, initializeMongoDB, gracefulShutdown, ApiError };
