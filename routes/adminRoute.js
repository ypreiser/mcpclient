//mcpclient/routes/adminRoute.js
import User from "../models/userModel.js";
import SystemPrompt from "../models/systemPromptModel.js";
import express from "express";
import { requireAuth } from "./authRoute.js";

const router = express.Router();

// Middleware to check admin privilege
function requireAdmin(req, res, next) {
  if (!req.user || req.user.privlegeLevel !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

// GET /api/admin/users - List all users with token usage
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find(
      {},
      "email name createdAt totalLifetimePromptTokens totalLifetimeCompletionTokens totalLifetimeTokens monthlyTokenUsageHistory quotaTokensAllowedPerMonth quotaMonthStartDate lastTokenUsageUpdate privlegeLevel"
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// GET /api/admin/user/:id/prompts - List all system prompts for a user
router.get("/user/:id/prompts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const prompts = await SystemPrompt.find({ userId: req.params.id });
    res.json({ prompts });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch prompts." });
  }
});

// GET /api/admin/user/:id - Get a single user's details (for future admin actions)
router.get("/user/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(
      "email name createdAt totalLifetimePromptTokens totalLifetimeCompletionTokens totalLifetimeTokens monthlyTokenUsageHistory quotaTokensAllowedPerMonth quotaMonthStartDate lastTokenUsageUpdate privlegeLevel"
    );
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user." });
  }
});

// PATCH /api/admin/user/:id/privilege - Change user privilege (admin only)
router.patch(
  "/user/:id/privilege",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const { privlegeLevel } = req.body;
    if (!privlegeLevel || !["user", "admin"].includes(privlegeLevel)) {
      return res.status(400).json({ error: "Invalid privilege level." });
    }
    try {
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { privlegeLevel },
        { new: true, runValidators: true }
      ).select("email name privlegeLevel");
      if (!user) return res.status(404).json({ error: "User not found." });
      res.json({ user });
    } catch (err) {
      res.status(500).json({ error: "Failed to update privilege." });
    }
  }
);

export default router;
