// Integration tests for publicChatRoute.js
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import publicChatRoutes from "../../src/routes/publicChatRoute.js";
import botProfileRoutes from "../../src/routes/botProfileRoute.js";
import authRoutes, { requireAuth } from "../../src/routes/authRoute.js";
import logger from "../../src/utils/logger.js";

vi.mock("../../src/utils/chatService.js", () => ({
  default: {
    processMessage: vi.fn(),
    endSession: vi.fn(),
    initializeSession: vi.fn(),
    getSession: vi.fn(),
  },
}));
import chatService from "../../src/utils/chatService.js";

let app;
let userToken;
let botProfileId;
let sessionId;

const testUser = {
  email: "publicchattest@example.com",
  password: "password123",
  name: "PublicChat Tester",
};

const validProfile = {
  name: "ChatBot",
  identity: "I am a chat bot.",
  description: "A bot for public chat.",
  communicationStyle: "Friendly",
  isEnabled: true,
};

const initializeTestApp = () => {
  dotenv.config();
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: "http://localhost:5173", credentials: true }));
  testApp.use(express.json());
  testApp.use(cookieParser());
  testApp.use("/api/auth", authRoutes);
  testApp.use("/api/botProfile", requireAuth, botProfileRoutes);
  testApp.use("/api/publicChat", publicChatRoutes);
  testApp.use((err, req, res, next) => {
    logger.error({ err }, "Test unhandled error");
    res
      .status(err.status || 500)
      .json({ error: { message: err.message || "Internal Server Error" } });
  });
  return testApp;
};

beforeAll(() => {
  app = initializeTestApp();
});

beforeEach(async () => {
  // Register and login a fresh user before each test
  await request(app).post("/api/auth/register").send(testUser);
  const loginRes = await request(app)
    .post("/api/auth/login")
    .send({ email: testUser.email, password: testUser.password });
  userToken = loginRes.headers["set-cookie"][0];
  // Do NOT create a bot profile here. Each test will create its own as needed.
  botProfileId = undefined;
  sessionId = undefined;
});

describe("PublicChat API Integration", () => {
  it("should start a new public chat session", async () => {
    // Create a bot profile
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/start`)
      .send();
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty("sessionId");
    expect(res.body).toHaveProperty("botProfileName");
    sessionId = res.body.sessionId;
  });

  it("should not start a session with invalid botProfileId", async () => {
    const res = await request(app)
      .post(`/api/publicChat/invalidid/start`)
      .send();
    expect(res.statusCode).toBe(400);
  });

  it("should not start a session with a non-existent botProfileId", async () => {
    const res = await request(app)
      .post(`/api/publicChat/507f1f77bcf86cd799439011/start`)
      .send();
    expect(res.statusCode).toBe(404);
  });

  it("should send a message in a public chat session", async () => {
    // Create a bot profile and start a session
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const startRes = await request(app)
      .post(`/api/publicChat/${botProfileId}/start`)
      .send();
    sessionId = startRes.body.sessionId;
    chatService.processMessage.mockResolvedValue({
      text: "Mocked AI Response",
      toolCalls: [],
    });
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/msg`)
      .send({ sessionId, message: "Hello!" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("text", "Mocked AI Response");
    expect(chatService.processMessage).toHaveBeenCalled();
  });

  it("should return 400 for missing sessionId in /msg", async () => {
    // Create a bot profile
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/msg`)
      .send({ message: "Hi" });
    expect(res.statusCode).toBe(400);
  });

  it("should return 400 for empty message and no attachments", async () => {
    // Create a bot profile and start a session
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const startRes = await request(app)
      .post(`/api/publicChat/${botProfileId}/start`)
      .send();
    sessionId = startRes.body.sessionId;
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/msg`)
      .send({ sessionId, message: "   " });
    expect(res.statusCode).toBe(400);
  });

  it("should end a public chat session", async () => {
    // Create a bot profile and start a session
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const startRes = await request(app)
      .post(`/api/publicChat/${botProfileId}/start`)
      .send();
    sessionId = startRes.body.sessionId;
    chatService.endSession.mockResolvedValue();
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/end`)
      .send({ sessionId });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("message");
    expect(chatService.endSession).toHaveBeenCalled();
  });

  it("should return 400 for missing sessionId in /end", async () => {
    // Create a bot profile
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const res = await request(app)
      .post(`/api/publicChat/${botProfileId}/end`)
      .send({});
    expect(res.statusCode).toBe(400);
  });

  it("should get chat history (empty for new session)", async () => {
    // Create a bot profile and start a session
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const startRes = await request(app)
      .post(`/api/publicChat/${botProfileId}/start`)
      .send();
    sessionId = startRes.body.sessionId;
    const res = await request(app)
      .get(`/api/publicChat/${botProfileId}/history?sessionId=${sessionId}`)
      .send();
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(Array.isArray(res.body.messages)).toBe(true);
  });

  it("should return 400 for missing sessionId in /history", async () => {
    // Create a bot profile
    const botRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    botProfileId = botRes.body._id;
    const res = await request(app)
      .get(`/api/publicChat/${botProfileId}/history`)
      .send();
    expect(res.statusCode).toBe(400);
  });
});
