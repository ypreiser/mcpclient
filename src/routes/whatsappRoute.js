// src\routes\whatsappRoute.js
//mcpclient/routes/whatsappRoute.js
import express from "express";
import QRCode from "qrcode";
import whatsappService from "../utils/whatsappService.js";
import logger from "../utils/logger.js";
import WhatsAppConnection from "../models/whatsAppConnectionModel.js";
import { requireAuth } from "./authRoute.js";

const router = express.Router();

// Get all WhatsApp connections for the authenticated user
router.get("/connections", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const connections = await WhatsAppConnection.find({ userId })
      .select(
        "connectionName systemPromptName lastKnownStatus lastConnectedAt createdAt updatedAt phoneNumber"
      )
      .sort({ updatedAt: -1 });
    res.json({ connections });
  } catch (error) {
    next(error);
  }
});

// Initialize a new WhatsApp session
router.post("/session", async (req, res, next) => {
  const { connectionName, systemPromptId } = req.body; // Now expect systemPromptId
  const userId = req.user._id;
  logger.info(
    { connectionName, systemPromptId, userId },
    "API: Initializing WhatsApp session"
  );
  if (
    !connectionName ||
    typeof connectionName !== "string" ||
    connectionName.trim() === ""
  ) {
    return res.status(400).json({
      error: "Connection name is required and must be a non-empty string.",
    });
  }
  if (
    !systemPromptId ||
    typeof systemPromptId !== "string" ||
    systemPromptId.trim() === ""
  ) {
    return res.status(400).json({
      error: "System prompt id is required and must be a non-empty string.",
    });
  }

  try {
    const client = await whatsappService.initializeSession(
      connectionName,
      systemPromptId,
      userId
    );
    // Client object itself is complex, just return status.
    // The status is now managed within whatsappService.sessions map
    const status = await whatsappService.getStatus(connectionName);
    res.status(201).json({
      connectionName,
      status: status || "initializing", // Fallback if status not immediately updated
    });
  } catch (error) {
    logger.error(
      { err: error, connectionName, systemPromptId },
      "API: Error creating WhatsApp session"
    );
    // Pass to global error handler, or provide specific response
    if (error.message.includes("already being managed")) {
      return res.status(409).json({ error: error.message });
    }
    next(error);
  }
});

// Get QR code for a session
router.get("/session/:connectionName/qr", async (req, res, next) => {
  const { connectionName } = req.params;
  logger.info({ connectionName }, "API: Getting QR code");
  try {
    const qrString = await whatsappService.getQRCode(connectionName);

    if (!qrString) {
      const status = await whatsappService.getStatus(connectionName);
      if (status === "not_found")
        return res.status(404).json({ error: "Session not found." });
      return res.status(404).json({
        error: "QR code not available or session not in QR state.",
        status,
      });
    }

    const qrDataUrl = await QRCode.toDataURL(qrString);
    logger.info({ connectionName }, "API: QR code generated successfully");
    res.json({ qr: qrDataUrl });
  } catch (error) {
    logger.error({ err: error, connectionName }, "API: Error getting QR code");
    next(error);
  }
});

// Get status of a session
router.get(
  "/session/:connectionName/status",
  requireAuth,
  async (req, res, next) => {
    const { connectionName } = req.params;
    const userId = req.user._id; // Get user ID from authenticated request
    logger.debug({ connectionName }, "API: Getting session status"); // Debug for frequent calls
    try {
      const status = await whatsappService.getStatus(connectionName, userId);
      if (status === "not_found") {
        return res.status(404).json({ status, message: "Session not found." });
      }
      res.json({ connectionName, status });
    } catch (error) {
      logger.error({ err: error, connectionName }, "API: Error getting status");
      next(error);
    }
  }
);

// Send a message
router.post(
  "/session/:connectionName/message",
  requireAuth,
  async (req, res, next) => {
    const { connectionName } = req.params;
    const userId = req.user._id; // Get user ID from authenticated request
    const { to, message } = req.body;
    logger.info({ connectionName, userId, to }, "API: Sending message");

    if (
      !to ||
      typeof to !== "string" ||
      to.trim() === "" ||
      !message ||
      typeof message !== "string" ||
      message.trim() === ""
    ) {
      return res.status(400).json({
        error:
          "Receiver 'to' and 'message' are required and must be non-empty strings.",
      });
    }

    try {
      const sentMessage = await whatsappService.sendMessage(
        connectionName,
        userId,
        to,
        message
      );
      res.json({ success: true, messageId: sentMessage.id.id }); // Return message ID if available
    } catch (error) {
      logger.error(
        { err: error, connectionName, to },
        "API: Error sending message"
      );
      if (error.message.includes("not connected")) {
        return res.status(409).json({
          error: error.message,
          status: await whatsappService.getStatus(connectionName),
        });
      }
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      next(error);
    }
  }
);

// Close a session
router.delete(
  "/session/:connectionName",
  requireAuth,
  async (req, res, next) => {
    const { connectionName } = req.params;
    const userId = req.user._id; // Get user ID from authenticated request
    logger.info({ connectionName, userId }, "API: Closing session");
    try {
      await whatsappService.closeSession(connectionName, userId);
      res.json({
        success: true,
        message: `Session '${connectionName}' closed.`,
      });
    } catch (error) {
      logger.error(
        { err: error, connectionName },
        "API: Error closing session"
      );
      next(error);
    }
  }
);

export default router;
