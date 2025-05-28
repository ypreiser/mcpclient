// src\routes\whatsappRoute.js
import express from "express";
import QRCode from "qrcode";
import whatsappService from "../utils/whatsappService.js";
import logger from "../utils/logger.js";
import WhatsAppConnection from "../models/whatsAppConnectionModel.js"; // Keep for GET /connections
import { requireAuth } from "./authRoute.js"; // Ensure this is correctly imported and used

const router = express.Router();

// GET all WhatsApp connections for the authenticated user
router.get("/connections", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const connections = await WhatsAppConnection.find({ userId })
      .populate("botProfileId", "name") // Populate name from BotProfile
      .select(
        "connectionName botProfileId lastKnownStatus lastConnectedAt createdAt updatedAt phoneNumber"
      )
      .sort({ updatedAt: -1 });

    // Map to include botProfileName from populated botProfileId
    const connectionsWithProfileName = connections.map((conn) => {
      const connObj = conn.toObject();
      return {
        ...connObj,
        botProfileName:
          conn.botProfileId?.name || "N/A (Profile Deleted/Error)",
        botProfileId: conn.botProfileId?._id || conn.botProfileId, // Ensure it's the ID
      };
    });

    res.json({ connections: connectionsWithProfileName });
  } catch (error) {
    logger.error(
      { err: error, userId: req.user?._id },
      "API: Error fetching WhatsApp connections."
    );
    next(error);
  }
});

// Initialize a new WhatsApp session
router.post("/session", requireAuth, async (req, res, next) => {
  // requireAuth here
  const { connectionName, botProfileId } = req.body;
  const userId = req.user._id; // Get userId from authenticated user

  logger.info(
    { connectionName, botProfileId, userId },
    "WhatappRoute: Initializing WhatsApp session"
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
    !botProfileId ||
    typeof botProfileId !== "string" ||
    botProfileId.trim() === ""
  ) {
    // Basic check, Mongoose will validate ObjectId
    return res.status(400).json({ error: "Bot Profile ID is required." });
  }

  try {
    // initializeSession now handles client creation and event setup.
    // It doesn't directly return the client object to the route anymore.
    await whatsappService.initializeSession(
      connectionName,
      botProfileId,
      userId
    );

    // After initiating, get the status. It might be 'initializing' or 'qr_ready' etc.
    const status = await whatsappService.getStatus(connectionName, userId); // <<< PASS userId

    res.status(201).json({
      // 201 for "Created" (session initialization requested)
      connectionName,
      status: status || "initializing",
    });
  } catch (error) {
    logger.error(
      { err: error, connectionName, botProfileId, userId },
      "API: Error creating/initializing WhatsApp session"
    );
    if (
      error.message.includes("already active") ||
      error.message.includes("already managed")
    ) {
      return res.status(409).json({ error: error.message }); // Conflict
    }
    // Other specific errors can be handled here based on error.message or a custom error code/type
    next(error); // Pass to global error handler
  }
});

// Get QR code for a session
router.get(
  "/session/:connectionName/qr",
  requireAuth,
  async (req, res, next) => {
    const { connectionName } = req.params;
    const userId = req.user._id; // Get userId from authenticated user

    logger.info({ connectionName, userId }, "API: Getting QR code");
    try {
      // getQRCode might need to verify ownership if the session map key (connectionName) isn't user-scoped by itself
      // For now, assuming getQRCode handles this or the session map implicitly scopes by how sessions are added
      const session = whatsappService.clientManager.getSession(connectionName);
      if (session && session.userId?.toString() !== userId.toString()) {
        logger.warn(
          { connectionName, reqUserId: userId, sessionUserId: session.userId },
          "API: QR code access attempt for connection not owned by user."
        );
        return res
          .status(403)
          .json({ error: "Access denied to this connection's QR code." });
      }

      const qrString = await whatsappService.getQRCode(connectionName);

      if (!qrString) {
        const status = await whatsappService.getStatus(connectionName, userId); // Pass userId
        if (status === "not_found")
          return res.status(404).json({ error: "Session not found." });
        return res.status(404).json({
          error: "QR code not available or session not in QR state.",
          status,
        });
      }

      const qrDataUrl = await QRCode.toDataURL(qrString);
      logger.info(
        { connectionName, userId },
        "API: QR code generated successfully"
      );
      res.json({ qr: qrDataUrl });
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId },
        "API: Error getting QR code"
      );
      next(error);
    }
  }
);

// Get status of a session
router.get(
  "/session/:connectionName/status",
  requireAuth,
  async (req, res, next) => {
    const { connectionName } = req.params;
    const userId = req.user._id; // Get userId from authenticated user

    logger.debug({ connectionName, userId }, "API: Getting session status");
    try {
      const status = await whatsappService.getStatus(connectionName, userId); // <<< PASS userId
      if (status === "not_found") {
        return res
          .status(404)
          .json({ status, message: "Session not found for your account." });
      }
      res.json({ connectionName, status });
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId },
        "API: Error getting status"
      );
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
    const userId = req.user._id; // Get userId from authenticated user
    const { to, message } = req.body;

    logger.info({ connectionName, to, userId }, "API: Sending message");

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
      ); // <<< PASS userId
      res.json({
        success: true,
        messageId:
          sentMessage.id?.id || sentMessage.id?._serialized || "unknown",
      });
    } catch (error) {
      logger.error(
        { err: error, connectionName, to, userId },
        "API: Error sending message"
      );
      const status = await whatsappService.getStatus(connectionName, userId); // Get current status for better error reporting
      if (
        error.message.includes("not ready") ||
        error.message.includes("not connected")
      ) {
        return res.status(409).json({ error: error.message, status }); // Conflict or Service Unavailable
      }
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message, status });
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
    const userId = req.user._id; // User initiating the close

    logger.info({ connectionName, userId }, "API: Closing session");
    try {
      // closeSession needs to ensure it's closing the session for this specific user.
      // The current closeSession in whatsappService primarily works off the connectionName from the map.
      // We need to ensure that clientManager.getSession(connectionName) has a userId that matches req.user._id
      // or that closeSession internally handles this ownership check before proceeding with DB updates.
      const session = whatsappService.clientManager.getSession(connectionName);
      if (
        session &&
        session.userId &&
        session.userId.toString() !== userId.toString()
      ) {
        logger.warn(
          { connectionName, reqUserId: userId, sessionUserId: session.userId },
          "API: Close session attempt for connection not owned by user."
        );
        return res
          .status(403)
          .json({ error: "Access denied to close this session." });
      }
      // If session doesn't exist in memory, closeSession will try to update DB.
      // It needs userId to correctly scope the DB update for connectionPersistence.
      // The refined closeSession attempts to use session.userId if available.
      // If it's a user-initiated close, and the session isn't in memory, it's tricky.
      // Let's assume for now closeSession will work correctly if session is in memory.
      // If not, the user-scoping of connectionPersistence methods (like saveConnectionDetails called by closeSession)
      // will rely on originalUserId derived from the in-memory session if possible.
      // A more robust closeSession in whatsappService might take userId as an explicit parameter.

      await whatsappService.closeSession(connectionName); // For now, pass only connectionName
      res.json({
        success: true,
        message: `Session '${connectionName}' close request processed.`,
      });
    } catch (error) {
      logger.error(
        { err: error, connectionName, userId },
        "API: Error closing session"
      );
      next(error);
    }
  }
);

export default router;
