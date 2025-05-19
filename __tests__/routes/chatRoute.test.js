// __tests__/routes/chatRoute.test.js
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
import chatRoutes from "../../routes/chatRoute.js";
import authRoutes, { requireAuth } from "../../routes/authRoute.js";
import User from "../../models/userModel.js";
import Chat from "../../models/chatModel.js";
import SystemPrompt from "../../models/systemPromptModel.js"; // Needed for chat creation

let app;
let adminAgent;
let user1Agent;
let user2Agent;
let adminUser, user1, user2;
let sysPromptUser1, sysPromptUser2; // System prompts for creating chats
let chatUser1_1, chatUser1_2, chatUser2_1;

let createdUserIds = [];
let createdSystemPromptIds = [];
let createdChatIds = [];

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
  testApp.use("/api/chats", asyncMiddleware(requireAuth), chatRoutes);

  testApp.use((err, req, res, next) => {
    logger.error(
      { err, path: req.path, method: req.method, userId: req.user?._id },
      "Test unhandled error in chatRoute.test.js"
    );
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Internal Server Error",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  });
  return testApp;
};

const createAndLoginUser = async (
  emailSuffix,
  name,
  privlegeLevel = "user"
) => {
  const email = `chat-user-${emailSuffix}-${Date.now()}@example.com`;
  const password = "password123";
  const userCredentials = { email, password, name, privlegeLevel };

  const registerRes = await request(app)
    .post("/api/auth/register")
    .send(userCredentials);
  expect(registerRes.statusCode).toBe(201);
  const createdUser = await User.findOne({ email });
  expect(createdUser).toBeDefined();
  if (privlegeLevel === "admin" && createdUser) {
    createdUser.privlegeLevel = "admin";
    await createdUser.save();
  }
  createdUserIds.push(createdUser._id);

  const agent = request.agent(app);
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ email, password });
  expect(loginRes.statusCode).toBe(200);
  return { agent, user: createdUser };
};

const createSystemPromptForUser = async (user, nameSuffix) => {
  const prompt = await SystemPrompt.create({
    name: `TestPrompt-ChatRoute-${nameSuffix}-${Date.now()}`,
    identity: "Test bot for chat route",
    userId: user._id,
  });
  createdSystemPromptIds.push(prompt._id);
  return prompt;
};

const createChatForUser = async (
  user,
  systemPrompt,
  sessionIdSuffix,
  source = "webapp"
) => {
  const chat = await Chat.create({
    sessionId: `session-${sessionIdSuffix}-${Date.now()}`,
    systemPromptId: systemPrompt._id,
    systemPromptName: systemPrompt.name,
    source: source,
    userId: user._id,
    messages: [{ role: "user", content: "Hello", timestamp: new Date() }],
    metadata: { userName: user.name, lastActive: new Date() },
  });
  createdChatIds.push(chat._id);
  return chat;
};

describe("Chat Routes API (/api/chats)", () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    app = initializeTestApp();

    const adminData = await createAndLoginUser("admin", "Admin User", "admin");
    adminAgent = adminData.agent;
    adminUser = adminData.user;

    const user1Data = await createAndLoginUser("user1", "Test User 1");
    user1Agent = user1Data.agent;
    user1 = user1Data.user;
    sysPromptUser1 = await createSystemPromptForUser(user1, "user1");

    const user2Data = await createAndLoginUser("user2", "Test User 2");
    user2Agent = user2Data.agent;
    user2 = user2Data.user;
    sysPromptUser2 = await createSystemPromptForUser(user2, "user2");
  });

  beforeEach(async () => {
    // Clear previous chats but keep users and prompts
    if (createdChatIds.length > 0) {
      await Chat.deleteMany({ _id: { $in: createdChatIds } });
      createdChatIds = [];
    }
    // Create chats for the tests
    chatUser1_1 = await createChatForUser(user1, sysPromptUser1, "u1c1");
    chatUser1_2 = await createChatForUser(user1, sysPromptUser1, "u1c2");
    chatUser2_1 = await createChatForUser(user2, sysPromptUser2, "u2c1");
  });

  afterAll(async () => {
    try {
      if (createdChatIds.length > 0)
        await Chat.deleteMany({ _id: { $in: createdChatIds } });
      if (createdSystemPromptIds.length > 0)
        await SystemPrompt.deleteMany({ _id: { $in: createdSystemPromptIds } });
      if (createdUserIds.length > 0)
        await User.deleteMany({ _id: { $in: createdUserIds } });
    } catch (error) {
      console.error("Error in chatRoute.test.js afterAll:", error);
    }
  });

  describe("GET /api/chats", () => {
    it("should allow admin to list all chats", async () => {
      const res = await adminAgent.get("/api/chats");
      expect(res.statusCode).toBe(200);
      expect(res.body.chats).toBeInstanceOf(Array);
      expect(res.body.chats.length).toBeGreaterThanOrEqual(3); // chatUser1_1, chatUser1_2, chatUser2_1
      const chatIds = res.body.chats.map((c) => c._id.toString());
      expect(chatIds).toContain(chatUser1_1._id.toString());
      expect(chatIds).toContain(chatUser2_1._id.toString());
    });

    it("should allow a regular user to list only their own chats", async () => {
      const res = await user1Agent.get("/api/chats");
      expect(res.statusCode).toBe(200);
      expect(res.body.chats).toBeInstanceOf(Array);
      expect(res.body.chats.length).toBe(2); // chatUser1_1, chatUser1_2
      const chatIds = res.body.chats.map((c) => c._id.toString());
      expect(chatIds).toContain(chatUser1_1._id.toString());
      expect(chatIds).toContain(chatUser1_2._id.toString());
      expect(chatIds).not.toContain(chatUser2_1._id.toString());
    });

    it("should return empty array if user has no chats", async () => {
      const newUserNoChatData = await createAndLoginUser(
        "nochat",
        "No Chat User"
      );
      const res = await newUserNoChatData.agent.get("/api/chats");
      expect(res.statusCode).toBe(200);
      expect(res.body.chats).toEqual([]);
    });

    it("should deny unauthenticated access to list chats", async () => {
      const res = await request(app).get("/api/chats");
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/chats/:id", () => {
    it("should allow admin to get any specific chat", async () => {
      const res = await adminAgent.get(`/api/chats/${chatUser1_1._id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.chat).toBeDefined();
      expect(res.body.chat._id.toString()).toBe(chatUser1_1._id.toString());
      expect(res.body.chat.userId.email).toBe(user1.email);
    });

    it("should allow a regular user to get their own specific chat", async () => {
      const res = await user1Agent.get(`/api/chats/${chatUser1_1._id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.chat).toBeDefined();
      expect(res.body.chat._id.toString()).toBe(chatUser1_1._id.toString());
    });

    it("should deny a regular user from getting another user's specific chat", async () => {
      const res = await user1Agent.get(`/api/chats/${chatUser2_1._id}`);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe("Access denied.");
    });

    it("should return 404 if chat ID does not exist (admin access)", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await adminAgent.get(`/api/chats/${fakeId}`);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe("Chat not found.");
    });

    it("should return 404 if chat ID does not exist (user access)", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await user1Agent.get(`/api/chats/${fakeId}`);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe("Chat not found.");
    });

    it("should deny unauthenticated access to get a specific chat", async () => {
      const res = await request(app).get(`/api/chats/${chatUser1_1._id}`);
      expect(res.statusCode).toBe(401);
    });
  });
});
