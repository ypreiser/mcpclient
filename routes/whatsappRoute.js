import express from "express";
import { v4 as uuidv4 } from "uuid";
import QRCode from "qrcode";
import whatsappService from "../utils/whatsappService.js";

const router = express.Router();

// Initialize a new WhatsApp session
router.post("/session", async (req, res) => {
  console.log(
    "Initializing WhatsApp session with system prompt",
    req.body.systemPromptName
  );
  try {
    const sessionId = uuidv4();
    await whatsappService.initializeSession(
      sessionId,
      req.body.systemPromptName
    );
    res.json({ sessionId });
  } catch (error) {
    console.error("Error creating WhatsApp session:", error);
    res.status(500).json({ error: "Failed to create WhatsApp session" });
  }
});

// Get QR code for a session
router.get("/session/:sessionId/qr", async (req, res) => {
  console.log("route: Getting QR code for session", req.params.sessionId);
  try {
    const { sessionId } = req.params;
    const qr = await whatsappService.getQRCode(sessionId);
    //turn qr into a data url
    const qrDataUrl = await QRCode.toDataURL(qr);

    if (!qr) {
      return res.status(404).json({ error: "QR code not available" });
    }

    console.log("route: QR code:", qr);

    res.json({ qr: qrDataUrl });
  } catch (error) {
    console.error("Error getting QR code:", error);
    res.status(500).json({ error: "Failed to get QR code" });
  }
});

// Get status of a session
router.get("/session/:sessionId/status", async (req, res) => {
  console.log("route: Getting status for session", req.params.sessionId);
  try {
    const { sessionId } = req.params;
    const status = await whatsappService.getStatus(sessionId);
    res.json({ status });
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

// Send a message
router.post("/session/:sessionId/message", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await whatsappService.sendMessage(sessionId, to, message);
    res.json({ success: true });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Close a session
router.delete("/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    await whatsappService.closeSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error("Error closing session:", error);
    res.status(500).json({ error: "Failed to close session" });
  }
});

export default router;
