//mcpclient/routes/systemPromptRoute.js
import express from "express";
import SystemPrompt from "../models/systemPromptModel.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Get all prompts (names only for dropdown lists)
router.get("/", async (req, res, next) => {
  try {
    const prompts = await SystemPrompt.find({ userId: req.user._id }).select([
      "name",
      "_id",
      "isActive",
      "userId", // <-- Add userId so tests can match
    ]);
    res.json(prompts);
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch prompt names");
    next(error);
  }
});

// Get prompt by name
router.get("/:name", async (req, res, next) => {
  try {
    const prompt = await SystemPrompt.findOne({
      name: req.params.name,
      userId: req.user._id,
    });
    if (!prompt) {
      return res.status(404).json({ message: "Prompt not found" });
    }
    res.json(prompt);
  } catch (error) {
    logger.error(
      { err: error, promptName: req.params.name },
      "Failed to fetch prompt by name"
    );
    next(error);
  }
});

// Get latest system prompt content (for compatibility with old endpoint)
router.get("/latest", async (req, res, next) => {
  logger.warn(
    "Usage of /api/systemprompt/latest endpoint. Consider using named prompts."
  );
  try {
    const prompt = await SystemPrompt.findOne({ userId: req.user._id }).sort({
      updatedAt: -1,
    });
    if (!prompt) return res.status(404).json({ error: "No prompt found" });
    res.json(prompt);
  } catch (err) {
    logger.error({ err }, "Failed to fetch latest prompt");
    next(err);
  }
});

// Create new system prompt
router.post("/", async (req, res, next) => {
  try {
    // Basic validation
    const { name, identity, mcpServers } = req.body;
    if (!name || typeof name !== "string" || name.trim() === "") {
      return res
        .status(400)
        .json({ error: "Name is required and must be a non-empty string" });
    }
    if (!identity || typeof identity !== "string" || identity.trim() === "") {
      return res
        .status(400)
        .json({ error: "Identity is required and must be a non-empty string" });
    }
    if (mcpServers && !Array.isArray(mcpServers)) {
      return res
        .status(400)
        .json({ error: "mcpServers must be an array if provided" });
    }
    // Further validation for mcpServers content can be added here

    const newPromptData = {
      ...req.body,
      userId: req.user._id,
      updatedAt: new Date(),
    };
    const prompt = new SystemPrompt(newPromptData);

    await prompt.save();
    logger.info(
      { promptName: prompt.name },
      "System prompt created successfully"
    );
    res.status(201).json(prompt); // Return 201 for created resource
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate key error (e.g. if name is unique)
      logger.warn(
        { err, promptData: req.body },
        "Attempt to create duplicate system prompt"
      );
      return res.status(409).json({
        error: "System prompt with this name already exists",
        details: err.message,
      });
    }
    logger.error({ err, promptData: req.body }, "Error saving system prompt");
    next(err);
  }
});

// Update prompt
router.put("/:name", async (req, res, next) => {
  try {
    const existingPrompt = await SystemPrompt.findOne({
      name: req.params.name,
      userId: req.user._id,
    });
    if (!existingPrompt) {
      return res.status(404).json({ message: "Prompt not found" });
    }

    const { name, identity, mcpServers, ...rest } = req.body;

    // Validation for update
    if (
      name !== undefined &&
      (typeof name !== "string" || name.trim() === "")
    ) {
      return res
        .status(400)
        .json({ error: "Name cannot be empty if provided" });
    }
    if (
      identity !== undefined &&
      (typeof identity !== "string" || identity.trim() === "")
    ) {
      return res
        .status(400)
        .json({ error: "Identity cannot be empty if provided" });
    }
    if (mcpServers !== undefined && !Array.isArray(mcpServers)) {
      return res
        .status(400)
        .json({ error: "mcpServers must be an array if provided" });
    }

    // Update fields carefully
    if (name !== undefined) existingPrompt.name = name;
    if (identity !== undefined) existingPrompt.identity = identity;
    if (mcpServers !== undefined) existingPrompt.mcpServers = mcpServers; // Overwrites entire array

    Object.keys(rest).forEach((key) => {
      // Ensure not to overwrite mongoose internal fields or _id
      if (key !== "_id" && key !== "__v" && existingPrompt.schema.paths[key]) {
        existingPrompt[key] = rest[key];
      }
    });

    existingPrompt.updatedAt = new Date();
    // Mongoose `save` will run validations defined in the schema
    const updatedPrompt = await existingPrompt.save();
    logger.info(
      { promptName: updatedPrompt.name },
      "System prompt updated successfully"
    );
    res.json(updatedPrompt);
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error if name is changed to an existing one
      logger.warn(
        { err: error, promptName: req.params.name, updateData: req.body },
        "Attempt to update prompt resulted in duplicate name"
      );
      return res.status(409).json({
        error: "Another system prompt with the new name already exists",
        details: error.message,
      });
    }
    logger.error(
      { err: error, promptName: req.params.name, updateData: req.body },
      "Error updating system prompt"
    );
    next(error);
  }
});

// Delete prompt
router.delete("/:name", async (req, res, next) => {
  try {
    const result = await SystemPrompt.deleteOne({
      name: req.params.name,
      userId: req.user._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Prompt not found" });
    }
    logger.info(
      { promptName: req.params.name },
      "System prompt deleted successfully"
    );
    res.json({ message: "Prompt deleted successfully" });
  } catch (error) {
    logger.error(
      { err: error, promptName: req.params.name },
      "Error deleting system prompt"
    );
    next(error);
  }
});

export default router;
