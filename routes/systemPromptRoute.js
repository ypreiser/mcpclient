// routes/system-prompt.js
import express from "express";
import SystemPrompt from "../models/systemPromptModel.js";

const router = express.Router();

// Get all prompts (names only for dropdown lists)
router.get("/", async (req, res) => {
  try {
    const prompts = await SystemPrompt.find().select("name");
    res.json(prompts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get prompt by name
router.get("/:name", async (req, res) => {
  try {
    const prompt = await SystemPrompt.findOne({ name: req.params.name });
    if (!prompt) {
      return res.status(404).json({ message: "Prompt not found" });
    }
    res.json(prompt);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get latest system prompt content (for compatibility with old endpoint)
router.get("/latest", async (req, res) => {
  try {
    const prompt = await SystemPrompt.findOne().sort({ updatedAt: -1 });
    if (!prompt) return res.status(404).json({ error: "No prompt found" });
    res.json(prompt);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch prompt" });
  }
});

// Create new system prompt
router.post("/", async (req, res) => {
  try {
    const { name, identity, ...rest } = req.body;

    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!identity || identity.trim() === "") {
      return res.status(400).json({ error: "Identity is required" });
    }

    if (req.body.mcpServers) {
      if (!Array.isArray(req.body.mcpServers)) {
        return res.status(400).json({ error: "mcpServers must be an array" });
      }
      // Optionally, validate each server config here
    }

    const prompt = new SystemPrompt({
      name,
      identity,
      ...rest,
      updatedAt: new Date(),
    });

    await prompt.save();
    res.json({ success: true, prompt });
  } catch (err) {
    console.error("Error saving prompt:", err);
    res
      .status(500)
      .json({ error: "Failed to save prompt", details: err.message });
  }
});

// Update prompt
router.put("/:name", async (req, res) => {
  try {
    const prompt = await SystemPrompt.findOne({ name: req.params.name });
    if (!prompt) {
      return res.status(404).json({ message: "Prompt not found" });
    }

    const { name, identity, ...rest } = req.body;

    // Ensure required fields are present
    if (name !== undefined && name.trim() === "") {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    if (identity !== undefined && identity.trim() === "") {
      return res.status(400).json({ error: "Identity cannot be empty" });
    }

    if (req.body.mcpServers) {
      if (!Array.isArray(req.body.mcpServers)) {
        return res.status(400).json({ error: "mcpServers must be an array" });
      }
      // Optionally, validate each server config here
    }

    // Update fields
    if (name !== undefined) prompt.name = name;
    if (identity !== undefined) prompt.identity = identity;
    Object.keys(rest).forEach((key) => {
      prompt[key] = rest[key];
    });

    prompt.updatedAt = new Date();
    await prompt.validate();
    const updatedPrompt = await prompt.save();
    res.json(updatedPrompt);
  } catch (error) {
    console.error("Error updating prompt:", error);
    res.status(400).json({ message: error.message });
  }
});

// Delete prompt
router.delete("/:name", async (req, res) => {
  try {
    const prompt = await SystemPrompt.findOne({ name: req.params.name });
    if (!prompt) {
      return res.status(404).json({ message: "Prompt not found" });
    }
    await prompt.deleteOne();
    res.json({ message: "Prompt deleted successfully" });
  } catch (error) {
    console.error("Error deleting prompt:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
