// src\server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import logger from "./utils/logger.js";

// Import Routes
import botProfileRoutes from "./routes/botProfileRoute.js"; // UPDATED TO BOTPROFILE
import whatsappRoutes from "./routes/whatsappRoute.js";
import authRoutes, { requireAuth } from "./routes/authRoute.js";
import publicChatRoutes from "./routes/publicChatRoute.js";
import adminRoutes from "./routes/adminRoute.js";
import chatRoutes from "./routes/chatRoute.js";

// Utilities and Middlewares
import upload from "./utils/uploadMiddleware.js";
import fs from "fs";
import path from "path";
import multer from "multer";

dotenv.config();
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
if (!process.env.JWT_SECRET) {
  logger.error("JWT_SECRET is not set. This is critical for security.");
  process.exit(1);
}

const app = express();
app.use(helmet());

const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173"
).split(",");
logger.info({ allowedOrigins }, "Allowed CORS origins");

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ originAttempted: origin }, "CORS: Origin not allowed.");
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: process.env.JSON_PAYLOAD_LIMIT || "10mb" }));
app.use(
  express.urlencoded({
    extended: true,
    limit: process.env.URLENCODED_PAYLOAD_LIMIT || "10mb",
  })
);
app.use(cookieParser());

const generalRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "200"),
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes.",
  handler: (req, res, next, options) => {
    logger.warn(
      { ip: req.ip, path: req.path },
      `Rate limit exceeded: ${options.message}`
    );
    res.status(options.statusCode).send(options.message);
  },
});
app.use("/", generalRateLimiter);

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || "15"),
  message:
    "Too many authentication attempts from this IP, please try again after 15 minutes.",
  handler: (req, res, next, options) => {
    logger.warn(
      { ip: req.ip, path: req.path },
      `Auth rate limit exceeded: ${options.message}`
    );
    res.status(options.statusCode).send(options.message);
  },
});
app.use("/api/auth/", authRateLimiter);

async function initializeMongoDB() {
  try {
    await mongoose.connect(MONGODB_URI, {});
    logger.info("Connected to MongoDB successfully");
  } catch (error) {
    logger.error({ err: error }, "MongoDB connection error:");
    process.exit(1);
  }
}

app.use((req, res, next) => {
  const startTime = process.hrtime();
  const logEntry = {
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  };

  if (
    req.body &&
    typeof req.body === "object" &&
    Object.keys(req.body).length > 0
  ) {
    const bodyToLog = { ...req.body };
    if (bodyToLog.password) bodyToLog.password = "[MASKED]";
    if (bodyToLog.token)
      bodyToLog.token =
        "[MASKED_TOKEN_SHORT]..." + (bodyToLog.token.slice(-5) || "");
    logEntry.body = bodyToLog;
  }

  res.on("finish", () => {
    const diff = process.hrtime(startTime);
    const durationMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(3);
    logEntry.status = res.statusCode;
    logEntry.durationMs = durationMs;
    if (res.statusCode >= 400) {
      logger.warn(logEntry, `HTTP Request: ${req.method} ${req.originalUrl}`);
    } else {
      logger.info(logEntry, `HTTP Request: ${req.method} ${req.originalUrl}`);
    }
  });
  next();
});

app.use((req, res, next) => {
  const openApiPaths = [
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/logout",
    "/api/auth/me",
    "/health",
  ];

  if (req.method === "OPTIONS" && req.path.startsWith("/api/")) {
    return res.sendStatus(204);
  }
  if (req.path.startsWith("/chat/")) return next(); // Public chat routes
  if (openApiPaths.some((openPath) => req.path.startsWith(openPath)))
    return next();
  if (req.path.startsWith("/api/")) return requireAuth(req, res, next); // Protect other API routes
  return next(); // For non-API routes (e.g. serving frontend)
});

app.post(
  "/api/upload",
  requireAuth,
  upload.single("file"),
  (req, res, next) => {
    try {
      if (!req.file) {
        logger.warn({ userId: req.user?._id }, "Upload attempt with no file.");
        return res.status(400).json({ error: "No file uploaded." });
      }
      const fileMeta = {
        url: req.file.path,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        public_id: req.file.filename,
        uploadedAt: new Date(),
        uploader: req.user._id,
      };
      logger.info(
        { file: fileMeta, userId: req.user._id },
        "File uploaded successfully."
      ); // Removed 'via Cloudinary' for generality
      res.status(201).json({ file: fileMeta });
    } catch (error) {
      logger.error(
        { err: error, userId: req.user?._id },
        "Error during file upload processing"
      );
      if (
        error.message.includes("Invalid file type") ||
        error instanceof multer.MulterError
      ) {
        return res
          .status(400)
          .json({ error: `File upload error: ${error.message}` });
      }
      next(error);
    }
  }
);

// This route is for serving LOCAL files. If using only cloud storage, it can be removed.
app.get("/uploads/:filename", requireAuth, (req, res, next) => {
  const filename = path.basename(req.params.filename);
  const uploadsDir = path.join(process.cwd(), "uploads");
  const filePath = path.join(uploadsDir, filename);

  if (!filePath.startsWith(uploadsDir)) {
    logger.warn(
      { potentialPathTraversal: req.params.filename, userId: req.user?._id },
      "Path traversal attempt blocked."
    );
    return res.status(403).json({ error: "Forbidden." });
  }
  fs.access(filePath, fs.constants.F_OK, (errAccess) => {
    if (errAccess) {
      logger.warn(
        { filePath, userId: req.user?._id },
        "Requested local file not found or inaccessible."
      );
      return res.status(404).json({ error: "File not found." });
    }
    res.sendFile(filePath, (errSend) => {
      if (errSend)
        logger.error(
          { err: errSend, filePath, userId: req.user?._id },
          "Error sending local file."
        );
    });
  });
});

// Register API Routes
app.use("/api/auth", authRoutes);
app.use("/api/botprofile", requireAuth, botProfileRoutes); // Correctly using botProfileRoutes
app.use("/api/whatsapp", requireAuth, whatsappRoutes);
app.use("/api/admin", requireAuth, adminRoutes);
app.use("/api/chats", requireAuth, chatRoutes);

// Public Routes
app.use("/chat", publicChatRoutes);

app.get("/health", (req, res) => {
  const healthStatus = {
    status: "UP",
    timestamp: new Date().toISOString(),
    mongodb:
      mongoose.connection.readyState === 1 ? "Connected" : "Disconnected",
  };
  res
    .status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json(healthStatus);
});

app.all(/^\/api\/.*/, (req, res) => {
  logger.warn(
    { path: req.originalUrl, method: req.method },
    "Unhandled API route - 404 Not Found."
  );
  res.status(404).json({ error: "API endpoint not found." });
});

class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}
global.ApiError = ApiError;

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  let message = err.message || "Internal Server Error";
  let details = err.details || null;

  if (err instanceof multer.MulterError) {
    message = `File upload error: ${err.code}`;
    if (err.field) message += ` (field: ${err.field})`;
    details = { code: err.code, field: err.field };
  } else if (err.name === "CastError" && err.kind === "ObjectId") {
    message = "Invalid ID format provided.";
    details = { path: err.path, value: err.value };
  } else if (statusCode >= 500 && process.env.NODE_ENV === "production") {
    message =
      "An unexpected error occurred on the server. Please try again later.";
    details = null;
  }

  const errorLog = {
    errName: err.name,
    message: err.message,
    status: statusCode,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body?.password ? { ...req.body, password: "[MASKED]" } : req.body,
    userId: req.user?._id,
    detailsForClient: details,
  };
  logger.error(errorLog, `Global error handler caught: ${err.message}`);

  res.status(statusCode).json({
    error: {
      message,
      ...(details && { details }),
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    },
  });
});

const gracefulShutdown = async (signal, serverInstance) => {
  logger.info(`${signal} received. Initiating graceful shutdown...`);
  try {
    if (serverInstance) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          logger.warn("HTTP server close timed out. Forcing shutdown.");
          reject(new Error("Server close timeout"));
        }, 10000);
        serverInstance.close((err) => {
          clearTimeout(timeout);
          if (err) {
            logger.error({ err }, "Error closing HTTP server during shutdown.");
            return reject(err);
          }
          logger.info("HTTP server closed.");
          resolve();
        });
      });
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info("MongoDB connection closed.");
    }
    if (
      global.whatsappServiceInstance &&
      typeof global.whatsappServiceInstance.gracefulShutdown === "function"
    ) {
      logger.info("Shutting down WhatsApp service...");
      await global.whatsappServiceInstance.gracefulShutdown();
      logger.info("WhatsApp service shut down.");
    }
  } catch (err) {
    logger.error({ err }, "Error during graceful shutdown process.");
  } finally {
    logger.info("Graceful shutdown finished. Exiting process.");
    process.exit(signal === "SIGTERM" ? 0 : 1);
  }
};

export { app, initializeMongoDB, gracefulShutdown };
