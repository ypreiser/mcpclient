// __tests__/routes/whatsappRoute.test.js
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import logger from "../../utils/logger.js"; // mocked
import whatsappRoutes from "../../routes/whatsappRoute.js";
import authRoutes, { requireAuth } from "../../routes/authRoute.js";
import User from "../../models/userModel.js";

// Mock the whatsappService
const mockWhatsappService = {
  initializeSession: vi.fn(),
  getQRCode: vi.fn(),
  getStatus: vi.fn(),
  sendMessage: vi.fn(),
  closeSession: vi.fn(),
};
vi.mock("../../utils/whatsappService.js", () => ({
  default: mockWhatsappService,
}));

let app;
let agent;
let testUser;

const initializeTestApp = () => {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: "http://localhost:5173", credentials: true }));
  testApp.use(express.json());
  testApp.use(cookieParser());
  process.env.NODE_ENV = "test";

  const asyncMiddleware = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  testApp.use("/api/auth", authRoutes);
  // Mount whatsapp routes, protected by requireAuth
  testApp.use("/api/whatsapp", asyncMiddleware(requireAuth), whatsappRoutes);

  testApp.use((err, req, res, next) => {
    logger.error(
      { err, path: req.path, method: req.method, userId: req.user?._id },
      "Test unhandled error in whatsappRoute.test.js"
    );
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Internal Server Error",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  });
  return testApp;
};

describe("WhatsApp Routes API (/api/whatsapp)", () => {
  const userCredentials = {
    email: `whatsapp-api-user-${Date.now()}@example.com`,
    password: "password123",
    name: "WhatsApp API User",
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    app = initializeTestApp();

    // Register and login user
    await request(app).post("/api/auth/register").send(userCredentials);
    const user = await User.findOne({ email: userCredentials.email });
    testUser = user; // Store for cleanup and use in tests
    expect(testUser).toBeDefined();

    agent = request.agent(app);
    const loginRes = await agent.post("/api/auth/login").send(userCredentials);
    expect(loginRes.statusCode).toBe(200);
  });

  afterAll(async () => {
    if (testUser) {
      await User.findByIdAndDelete(testUser._id);
    }
  });

  beforeEach(() => {
    // Reset mocks before each test
    vi.resetAllMocks();
  });

  describe("POST /api/whatsapp/session", () => {
    it("should initialize a new WhatsApp session", async () => {
      const connectionName = "testConnectionInit";
      const systemPromptName = "testPrompt";
      mockWhatsappService.initializeSession.mockResolvedValueOnce({
        client: {},
        status: "initializing",
      });
      mockWhatsappService.getStatus.mockResolvedValueOnce("initializing");

      const res = await agent
        .post("/api/whatsapp/session")
        .send({ connectionName, systemPromptName });

      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ connectionName, status: "initializing" });
      expect(mockWhatsappService.initializeSession).toHaveBeenCalledWith(
        connectionName,
        systemPromptName,
        testUser._id
      );
    });

    it("should return 400 if connectionName is missing", async () => {
      const res = await agent
        .post("/api/whatsapp/session")
        .send({ systemPromptName: "testPrompt" });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain("Connection name is required");
    });

    it("should return 400 if systemPromptName is missing", async () => {
      const res = await agent
        .post("/api/whatsapp/session")
        .send({ connectionName: "testConnection" });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain("System prompt name is required");
    });

    it("should handle errors from whatsappService.initializeSession", async () => {
      mockWhatsappService.initializeSession.mockRejectedValueOnce(
        new Error("Session already managed")
      );
      const res = await agent
        .post("/api/whatsapp/session")
        .send({ connectionName: "testConn", systemPromptName: "testPrompt" });
      expect(res.statusCode).toBe(409); // Assuming the route handles this specific error message with 409
      expect(res.body.error).toBe("Session already managed");
    });
  });

  describe("GET /api/whatsapp/session/:connectionName/qr", () => {
    const connectionName = "testConnectionQR";

    it("should get QR code for a session if available", async () => {
      const qrDataUrl = "data:image/png;base64,FAKEDATA";
      mockWhatsappService.getQRCode.mockResolvedValueOnce("FAKEQRSTRING"); // Mock the string from service
      // QRCode.toDataURL will be called inside the route, so we don't mock it here directly unless it becomes an issue
      // For simplicity, we assume QRCode.toDataURL works or mock it globally if needed.
      // Here, we'll check the service was called. The route transforms QR string to data URL.

      const res = await agent.get(`/api/whatsapp/session/${connectionName}/qr`);

      expect(res.statusCode).toBe(200);
      expect(res.body.qr).toBeDefined(); // It will be a data URL
      expect(res.body.qr).toContain("data:image/png;base64,");
      expect(mockWhatsappService.getQRCode).toHaveBeenCalledWith(
        connectionName
      );
    });

    it("should return 404 if QR code not available", async () => {
      mockWhatsappService.getQRCode.mockResolvedValueOnce(null);
      mockWhatsappService.getStatus.mockResolvedValueOnce("connected"); // e.g., session is connected, no QR
      const res = await agent.get(`/api/whatsapp/session/${connectionName}/qr`);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toContain("QR code not available");
    });

    it("should return 404 if session not found", async () => {
      mockWhatsappService.getQRCode.mockResolvedValueOnce(null);
      mockWhatsappService.getStatus.mockResolvedValueOnce("not_found");
      const res = await agent.get(`/api/whatsapp/session/${connectionName}/qr`);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe("Session not found.");
    });
  });

  describe("GET /api/whatsapp/session/:connectionName/status", () => {
    const connectionName = "testConnectionStatus";
    it("should get status of a session", async () => {
      mockWhatsappService.getStatus.mockResolvedValueOnce("authenticated");
      const res = await agent.get(
        `/api/whatsapp/session/${connectionName}/status`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ connectionName, status: "authenticated" });
      expect(mockWhatsappService.getStatus).toHaveBeenCalledWith(
        connectionName
      );
    });

    it("should return 404 if session not found for status", async () => {
      mockWhatsappService.getStatus.mockResolvedValueOnce("not_found");
      const res = await agent.get(
        `/api/whatsapp/session/${connectionName}/status`
      );
      expect(res.statusCode).toBe(404);
      expect(res.body.message).toBe("Session not found.");
    });
  });

  describe("POST /api/whatsapp/session/:connectionName/message", () => {
    const connectionName = "testConnectionMsg";
    const messageData = { to: "1234567890@c.us", message: "Hello there" };

    it("should send a message successfully", async () => {
      mockWhatsappService.sendMessage.mockResolvedValueOnce({
        id: { id: "fakeMessageId" },
      });
      const res = await agent
        .post(`/api/whatsapp/session/${connectionName}/message`)
        .send(messageData);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, messageId: "fakeMessageId" });
      expect(mockWhatsappService.sendMessage).toHaveBeenCalledWith(
        connectionName,
        messageData.to,
        messageData.message
      );
    });

    it('should return 400 if "to" field is missing', async () => {
      const res = await agent
        .post(`/api/whatsapp/session/${connectionName}/message`)
        .send({ message: "Hello" });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain(
        "Receiver 'to' and 'message' are required"
      );
    });

    it('should return 400 if "message" field is missing', async () => {
      const res = await agent
        .post(`/api/whatsapp/session/${connectionName}/message`)
        .send({ to: "123@c.us" });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain(
        "Receiver 'to' and 'message' are required"
      );
    });

    it("should handle errors from whatsappService.sendMessage (e.g., not connected)", async () => {
      mockWhatsappService.sendMessage.mockRejectedValueOnce(
        new Error("Client not connected")
      );
      mockWhatsappService.getStatus.mockResolvedValueOnce("disconnected"); // For the error response
      const res = await agent
        .post(`/api/whatsapp/session/${connectionName}/message`)
        .send(messageData);
      expect(res.statusCode).toBe(409); // Conflict, as client not in right state
      expect(res.body.error).toBe("Client not connected");
      expect(res.body.status).toBe("disconnected");
    });
  });

  describe("DELETE /api/whatsapp/session/:connectionName", () => {
    const connectionName = "testConnectionDelete";
    it("should close a session successfully", async () => {
      mockWhatsappService.closeSession.mockResolvedValueOnce(true);
      const res = await agent.delete(`/api/whatsapp/session/${connectionName}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: `Session '${connectionName}' closed.`,
      });
      expect(mockWhatsappService.closeSession).toHaveBeenCalledWith(
        connectionName
      );
    });

    it("should handle errors from whatsappService.closeSession", async () => {
      mockWhatsappService.closeSession.mockRejectedValueOnce(
        new Error("Error closing")
      );
      const res = await agent.delete(`/api/whatsapp/session/${connectionName}`);
      expect(res.statusCode).toBe(500); // Or whatever status the error handler assigns
      expect(res.body.error.message).toBe("Error closing"); // Default error from handler
    });
  });
});
