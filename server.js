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
import uploadRoute from "./routes/uploadRoute.js";
import fs from "fs";
import path from "path";

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
app.use(express.json({ limit: "10mb" })); // For JSON payloads
app.use(express.urlencoded({ extended: true, limit: "10mb" })); // For form data payloads
app.use(cookieParser());

// Rate Limiting - general
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"), // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes",
});
app.use("/", limiter); // Apply to all routes, but specific routes can have their own

// Stricter rate limiting for authentication routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || "20"), // Stricter for auth routes
  message:
    "Too many authentication attempts from this IP, please try again after 15 minutes",
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
  const logEntry = {
    method: req.method,
    path: req.path,
    ip: req.ip, // Log IP address
    cookie: req.cookies ? req.cookies : "No cookies", // Log cookies (be mindful of sensitive data in cookies)
  };
  // Mask password in body
  if (req.body && typeof req.body === "object") {
    const bodyToLog = { ...req.body };
    if (bodyToLog.password) {
      bodyToLog.password = "MASKEDPASSWORD";
    }
    logEntry.body = bodyToLog;
  }

  logger.info(logEntry, "Incoming request");
  next();
});

// Authentication middleware for protected routes
app.use((req, res, next) => {
  const openPaths = [
    "/api/auth/login",
    "/api/upload",
    "/api/auth/logout",
    "/api/auth/register",
    "/health",
  ];
  // Allow all /chat/* public endpoints (publicChatRoute) and OPTIONS for /api/auth/
  if (
    openPaths.includes(req.path) ||
    req.path.startsWith("/chat/") || // Public chat routes
    (req.path.startsWith("/api/auth/") && req.method === "OPTIONS") // Allow OPTIONS for auth preflight
  ) {
    return next();
  }
  // All other /api/* routes require authentication by default
  if (req.path.startsWith("/api/")) {
    return requireAuth(req, res, next);
  }
  // Non-API routes might be served statically or handled differently
  return next();
});

// Cookie security helper middleware for auth routes
const setCookieSecurely = (res, name, value, options = {}) => {
  const defaultOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development", // true in production
    sameSite: "strict", // Or 'lax' if needed for cross-site scenarios but 'strict' is safer
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: "/", // Ensure path is appropriate
  };
  res.cookie(name, value, { ...defaultOptions, ...options });
};

// Sample of how to use validation middleware
app.post(
  "/api/example",
  requireAuth, // Protect example route
  createValidationMiddleware([
    body("username").isString().trim().isLength({ min: 3 }).escape(),
    body("email").isEmail().normalizeEmail(),
  ]),
  (req, res) => {
    res.status(200).json({ success: true, message: "Example POST successful" });
  }
);

// Register routes
app.use("/api/auth", authRoutes);
app.use("/api/systemprompt", requireAuth, systemPromptRoutes);
app.use("/api/whatsapp", requireAuth, whatsappRoutes);
app.use("/chat", publicChatRoutes);
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api/chats", requireAuth, chatRoutes);
app.use("/api/upload", uploadRoute); // This line was missing the requireAuth, but uploadRoute handles its own auth logic (or lack thereof if public)

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
  const statusCode = err.statusCode || err.status || 500;
  let message = err.message || "Internal Server Error";

  if (err instanceof multer.MulterError) {
    // Ensure multer is imported if using this directly
    message = `File upload error: ${err.field ? err.field + " " : ""}${
      err.code
    }`;
  } else if (
    ![400, 401, 403, 404, 409, 429].includes(statusCode) &&
    process.env.NODE_ENV === "production"
  ) {
    message = "An unexpected error occurred. Please try again later.";
  }

  logger.error(
    {
      err,
      path: req.path,
      method: req.method,
      body: req.body?.password
        ? { ...req.body, password: "MASKEDPASSWORD" }
        : req.body,
      userId: req.user?._id,
    },
    `Global error handler caught: ${err.message}`
  );

  res.status(statusCode).json({
    error: {
      message,
      stack:
        process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev"
          ? err.stack
          : undefined,
      code: err.code && typeof err.code === "string" ? err.code : undefined,
    },
  });
});

// Handle cleanup on server shutdown
const gracefulShutdown = async (signal, serverInstance) => {
  logger.info(`${signal} received. Closing connections...`);
  try {
    if (serverInstance) {
      await new Promise((resolve, reject) => {
        serverInstance.close((err) => {
          if (err) {
            logger.error({ err }, "Error closing HTTP server");
            return reject(err);
          }
          logger.info("HTTP server closed");
          resolve();
        });
      });
    }

    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info("MongoDB connection closed.");
    }

    // Ensure whatsappServiceInstance is correctly referenced or imported if not global
    // Assuming it's made available globally or imported by the main starting script
    const waService = global.whatsappServiceInstance; // Or direct import if modularized
    if (waService && typeof waService.gracefulShutdown === "function") {
      logger.info("Attempting graceful shutdown of WhatsApp service...");
      await waService.gracefulShutdown();
    }
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown:");
  } finally {
    logger.info("Exiting process");
    process.exit(0);
  }
};

export {
  app,
  initializeMongoDB,
  gracefulShutdown,
  ApiError,
  setCookieSecurely,
};
