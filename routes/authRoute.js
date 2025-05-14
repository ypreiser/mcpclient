import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose"; // For ObjectId validation
import User from "../models/userModel.js";
import logger from "../utils/logger.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === "test") {
    // In test environment, just log a warning
    logger.warn("JWT_SECRET not set in test environment");
  } else {
    // In non-test environments, exit with error
    logger.fatal(
      "JWT_SECRET is not set. Application will not function securely."
    );
    process.exit(1);
  }
}

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 1000 * 60 * 60 * 24, // 1 day
  path: "/",
};

router.post("/register", async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email format." });
    }
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long." });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Email already registered." });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = new User({
      email: email.toLowerCase(),
      password: hashed,
      name,
    });
    await user.save();
    logger.info(
      { email: user.email, userId: user._id },
      "User registered successfully"
    );
    res.status(201).json({
      message: "User registered successfully.",
      userId: user._id,
      email: user.email,
    });
  } catch (err) {
    logger.error({ err, email: req.body.email }, "Registration failed.");
    next(err);
  }
});

router.post("/login", async (req, res, next) => {
  const { email, password } = req.body;
  const ip = req.ip || req.socket?.remoteAddress;
  const logMeta = { email: email?.toLowerCase(), ip };

  try {
    if (!email || !password) {
      logger.warn(
        { ...logMeta, success: false, reason: "Missing credentials" },
        "Login attempt: Missing credentials"
      );
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      logger.warn(
        { ...logMeta, success: false, reason: "User not found" },
        "Login attempt: User not found"
      );
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      logger.warn(
        { ...logMeta, success: false, reason: "Invalid password" },
        "Login attempt: Invalid password"
      );
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const token = jwt.sign(
      { userId: user._id },
      JWT_SECRET || "test-secret-key",
      {
        expiresIn: "1d",
      }
    );
    res.cookie("token", token, COOKIE_OPTIONS);
    logger.info(
      { ...logMeta, success: true, userId: user._id },
      "Login successful"
    );
    res.status(200).json({
      message: "Login successful.",
      user: { email: user.email, name: user.name, userId: user._id },
    });
  } catch (err) {
    logger.error({ ...logMeta, success: false, err }, "Login attempt error");
    res.status(500).json({ error: "An error occurred during login." });
  }
});

router.post("/logout", (req, res) => {
  // Set cookie options with maxAge: 0 for immediate expiry
  const clearOptions = {
    ...COOKIE_OPTIONS,
    maxAge: 0,
  };
  res.clearCookie("token", clearOptions);
  logger.info({ userId: req.user?._id, ip: req.ip }, "User logged out.");
  res.status(200).json({ message: "Logged out successfully." });
});

export async function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  const logMeta = { ip: req.ip, path: req.originalUrl, method: req.method };

  if (!token) {
    logger.warn({ ...logMeta }, "Auth failed: No token");
    return res
      .status(401)
      .json({ error: "Authentication required. No token provided." });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET || "test-secret-key");
    const userId = decoded.userId;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      logger.warn(
        { ...logMeta, tokenPayload: decoded },
        "Auth failed: Invalid token payload"
      );
      res.clearCookie("token", COOKIE_OPTIONS);
      return res
        .status(401)
        .json({ error: "Authentication failed: Invalid token." });
    }

    const user = await User.findById(userId).select("-password");
    if (!user) {
      logger.warn(
        { ...logMeta, userId },
        "Auth failed: User not found for token"
      );
      res.clearCookie("token", COOKIE_OPTIONS);
      return res
        .status(401)
        .json({ error: "Authentication failed: User not found." });
    }
    req.user = user;
    next();
  } catch (err) {
    logger.warn(
      { ...logMeta, errorName: err.name, errorMsg: err.message },
      "Auth failed: Token verification error"
    );
    res.clearCookie("token", COOKIE_OPTIONS);
    let publicError = "Invalid or expired token.";
    if (err.name === "TokenExpiredError")
      publicError = "Token expired. Please log in again.";
    res.status(401).json({ error: publicError });
  }
}

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    // req.user is populated by requireAuth and is fresh enough for basic details.
    // For token usage, which might update frequently, re-fetching ensures latest data.
    const user = await User.findById(req.user._id).select(
      "email name createdAt totalLifetimePromptTokens totalLifetimeCompletionTokens totalLifetimeTokens monthlyTokenUsageHistory quotaTokensAllowedPerMonth quotaMonthStartDate lastTokenUsageUpdate"
    );

    if (!user) {
      logger.warn(
        { userId: req.user._id },
        "User disappeared after auth for /me"
      );
      return res.status(404).json({ error: "User not found." });
    }
    // Convert Map to a plain object for JSON response, if necessary, or ensure client handles Map.
    // Mongoose Maps usually serialize to objects fine.
    const monthlyUsageObject = {};
    if (user.monthlyTokenUsageHistory) {
      for (const [key, value] of user.monthlyTokenUsageHistory) {
        monthlyUsageObject[key] = value.toObject ? value.toObject() : value; // Ensure sub-docs are plain objects
      }
    }

    res.json({
      user: {
        userId: user._id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        tokenUsage: {
          lifetime: {
            promptTokens: user.totalLifetimePromptTokens,
            completionTokens: user.totalLifetimeCompletionTokens,
            totalTokens: user.totalLifetimeTokens,
          },
          monthlyHistory: monthlyUsageObject, // Send the converted object
          quota: {
            allowedPerMonth: user.quotaTokensAllowedPerMonth,
            currentMonthStartDate: user.quotaMonthStartDate,
            // You might calculate current month's usage here if not relying on monthlyTokenUsageHistory["CURRENT_YYYY-MM"]
          },
          lastUsageUpdate: user.lastTokenUsageUpdate,
        },
      },
    });
  } catch (error) {
    logger.error(
      { err: error, userId: req.user?._id },
      "Error fetching user details for /me"
    );
    next(error);
  }
});

export default router;
