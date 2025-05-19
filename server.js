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
import upload from "./utils/uploadMiddleware.js"; // Corrected path
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
  // Allow all /chat/* public endpoints (publicChatRoute)
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
// Example of applying it if authRoute directly manipulates cookies
// app.use('/api/auth', (req, res, next) => {
//   const originalCookie = res.cookie;
//   res.cookie = (name, value, options) => {
//     setCookieSecurely(res, name, value, options);
//     // originalCookie.call(res, name, value, mergedOptions); // This line is problematic
//   };
//   next();
// });
// This overriding approach for res.cookie is generally fragile.
// It's better to call `setCookieSecurely` explicitly where cookies are set.
// However, your authRoute.js already sets cookie options, which is good.

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

// File upload endpoint (authenticated)
app.post("/api/upload", upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      logger.warn({ userId: req.user?._id }, "Upload attempt with no file.");
      return res.status(400).json({ error: "No file uploaded." });
    }
    // Security: `uploadMiddleware` handles file type and size checks.
    // `req.file.path` from multer-storage-cloudinary is the URL to the file.
    const fileMeta = {
      url: req.file.path, // Cloudinary URL
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      // Consider adding `public_id: req.file.filename` if using `CloudinaryStorage`'s `filename` mapping to `public_id`
      // For the default `multer-storage-cloudinary`, `req.file.filename` might be the `public_id`.
    };
    logger.info({ file: fileMeta }, "File uploaded successfully");
    res.status(201).json({ file: fileMeta });
  } catch (error) {
    // Multer errors (e.g., file too large, invalid type from fileFilter) might be caught here
    logger.error({ err: error }, "Error during file upload processing");
    if (error.message.includes("Invalid file type")) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof multer.MulterError) {
      return res
        .status(400)
        .json({ error: `File upload error: ${error.message}` });
    }
    next(error); // Pass to global error handler
  }
});

// Serve uploaded files securely (with auth)
// Note: This serves files from local 'uploads' folder.
// If using Cloudinary, files are served directly from Cloudinary URLs, not this endpoint.
// This endpoint might be for a different (local) upload mechanism or can be removed if all uploads go to Cloudinary.
app.get("/uploads/:filename", requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename); // Sanitize filename
  const filePath = path.join(process.cwd(), "uploads", filename);

  // Security: Check if the resolved path is still within the 'uploads' directory
  // This is a basic check. More robust path traversal prevention might be needed if subdirectories are allowed.
  if (!filePath.startsWith(path.join(process.cwd(), "uploads"))) {
    logger.warn(
      `Potential path traversal attempt: ${req.params.filename} by user ${req.user?._id}`
    );
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found." });
  }
  // Optionally: Check user permissions here to see if req.user is allowed to access this specific file.
  // e.g., if files are associated with user IDs.

  // Set appropriate Content-Type header
  // res.contentType(path.extname(filename)); // Basic, might need a mapping for more accuracy

  res.sendFile(filePath, (err) => {
    if (err) {
      logger.error(
        { err, filePath, userId: req.user?._id },
        "Error sending file"
      );
      // Avoid sending detailed error messages to client from res.sendFile internal errors
      if (!res.headersSent) {
        res.status(500).json({ error: "Error serving file." });
      }
    }
  });
});

// Register routes
app.use("/api/auth", authRoutes); // authRoutes will use its own cookie setting logic
app.use("/api/systemprompt", requireAuth, systemPromptRoutes); // Protected
app.use("/api/whatsapp", requireAuth, whatsappRoutes); // Protected
app.use("/chat", publicChatRoutes); // Public, handles its own auth/validation if needed internally
app.use("/api/admin", requireAuth, adminRoutes); // Protected
app.use("/api/chats", requireAuth, chatRoutes); // Protected

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
  const statusCode = err.statusCode || err.status || 500; // err.status for some libraries like multer
  let message = err.message || "Internal Server Error";

  // Sanitize multer error messages for client
  if (err instanceof multer.MulterError) {
    message = `File upload error: ${err.field ? err.field + " " : ""}${
      err.code
    }`;
  } else if (
    ![400, 401, 403, 404, 409, 429].includes(statusCode) &&
    process.env.NODE_ENV === "production"
  ) {
    // For 5xx errors in production, don't leak detailed error messages
    message = "An unexpected error occurred. Please try again later.";
  }

  logger.error(
    {
      err, // Full error object for server logs
      path: req.path,
      method: req.method,
      body: req.body?.password
        ? { ...req.body, password: "MASKEDPASSWORD" }
        : req.body, // Mask password
      userId: req.user?._id, // Log user if available
    },
    `Global error handler caught: ${err.message}`
  );

  res.status(statusCode).json({
    error: {
      message,
      // Only include stack trace in development
      stack:
        process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev"
          ? err.stack
          : undefined,
      // Include error code or name if useful and safe
      code: err.code && typeof err.code === "string" ? err.code : undefined, // e.g., Multer error codes
    },
  });
});

// Handle cleanup on server shutdown
const gracefulShutdown = async (signal, serverInstance) => {
  logger.info(`${signal} received. Closing connections...`);
  try {
    // Close server first to stop accepting new connections
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

    // Close database connection
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info("MongoDB connection closed.");
    }

    // Add any other cleanup here (e.g., closing AI clients if globally managed, WhatsApp service)
    if (
      global.whatsappServiceInstance &&
      typeof global.whatsappServiceInstance.gracefulShutdown === "function"
    ) {
      logger.info("Attempting graceful shutdown of WhatsApp service...");
      await global.whatsappServiceInstance.gracefulShutdown();
    }
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown:");
  } finally {
    logger.info("Exiting process");
    process.exit(0); // Exit after attempting cleanup
  }
};

// Export everything needed for the starter
export {
  app,
  initializeMongoDB,
  gracefulShutdown,
  ApiError,
  setCookieSecurely,
};
