//mcpclient/routes/chatRoute.js
import express from "express";
import Chat from "../models/chatModel.js";
import { requireAuth } from "./authRoute.js";

const router = express.Router();

// Middleware to check admin privilege
function requireAdmin(req, res, next) {
  if (!req.user || req.user.privlegeLevel !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// GET /api/chats - User: get own chats, Admin: get all chats
router.get("/", requireAuth, async (req, res) => {
  try {
    let chats;
    if (req.user.privlegeLevel === "admin") {
      chats = await Chat.find({})
        .populate("userId", "email name")
        .sort({ updatedAt: -1 });
    } else {
      chats = await Chat.find({ userId: req.user._id }).sort({ updatedAt: -1 });
    }
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chats." });
  }
});

// GET /api/chats/:id - Get a single chat (admin: any, user: only own)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.id).populate(
      "userId",
      "email name"
    );
    if (!chat) return res.status(404).json({ error: "Chat not found." });
    if (
      req.user.privlegeLevel !== "admin" &&
      String(chat.userId._id) !== String(req.user._id)
    ) {
      return res.status(403).json({ error: "Access denied." });
    }
    res.json({ chat });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat." });
  }
});

export default router;
