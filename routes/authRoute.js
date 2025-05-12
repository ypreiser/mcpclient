import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/userModel.js";
import logger from "../utils/logger.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production", // set to true in production
  sameSite: "strict",
  maxAge: 1000 * 60 * 60 * 24, // 1 day
  path: "/",
};

// Registration endpoint
router.post("/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: "Email already registered." });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ email, password: hashed, name });
    res.status(201).json({ message: "User registered." });
  } catch (err) {
    res.status(500).json({ error: "Registration failed." });
  }
});

// Login endpoint
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const ip = req.ip || req.socket?.remoteAddress;
  const logMeta = { email, ip, time: new Date().toISOString() };
  try {
    if (!email || !password) {
      logger.warn(
        { ...logMeta, success: false, reason: "Missing credentials" },
        "Login attempt failed"
      );
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    const user = await User.findOne({ email });
    if (!user) {
      logger.warn(
        { ...logMeta, success: false, reason: "User not found" },
        "Login attempt failed"
      );
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      logger.warn(
        { ...logMeta, success: false, reason: "Invalid password" },
        "Login attempt failed"
      );
      return res.status(401).json({ error: "Invalid credentials." });
    }
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, {
      expiresIn: "1d",
    });
    res.cookie("token", token, COOKIE_OPTIONS);
    logger.info(
      { ...logMeta, success: true, userId: user._id },
      "Login successful"
    );
    res.json({
      user: { email: user.email, name: user.name, userId: user._id },
    });
  } catch (err) {
    logger.error(
      { ...logMeta, success: false, error: err.message },
      "Login attempt error"
    );
    res.status(500).json({ error: "Login failed." });
  }
});

// Logout endpoint
router.post("/logout", (req, res) => {
  res.clearCookie("token", COOKIE_OPTIONS);
  res.json({ message: "Logged out." });
});

// Middleware to check JWT in cookie
export async function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    logger.warn(
      { ip: req.ip, time: new Date().toISOString() },
      "Authentication failed: No token provided"
    );
    return res
      .status(401)
      .json({ error: "Authentication failed: No token provided" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId;
    if (!userId) {
      logger.warn(
        { ip: req.ip, time: new Date().toISOString(), token },
        "Authentication failed: Invalid token payload"
      );
      return res
        .status(401)
        .json({ error: "Authentication failed: Invalid token payload" });
    }
    const user = await User.findById(userId);
    if (!user) {
      logger.warn(
        { ip: req.ip, time: new Date().toISOString(), userId, token },
        "Authentication failed: User not found"
      );
      return res
        .status(401)
        .json({ error: "Authentication failed: User not found" });
    }
    req.user = user; // Attach user object for downstream use
    next();
  } catch (err) {
    logger.warn(
      { ip: req.ip, time: new Date().toISOString(), error: err?.message },
      "Authentication failed: Invalid or expired token"
    );
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

export default router;
