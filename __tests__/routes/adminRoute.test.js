// __tests__/routes/adminRoute.test.js
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
import adminRoutes from "../../routes/adminRoute.js";
import authRoutes, { requireAuth } from "../../routes/authRoute.js";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";

let app;
let adminAgent;
let userAgent;
let adminUser;
let regularUser;
let createdUserIds = [];
let createdSystemPromptIds = [];

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

  // Mount auth routes for login
  testApp.use("/api/auth", authRoutes);
  // Mount admin routes, protected by requireAuth (which includes admin check via middleware in adminRoute.js itself)
  testApp.use("/api/admin", asyncMiddleware(requireAuth), adminRoutes);

  testApp.use((err, req, res, next) => {
    logger.error(
      { err, path: req.path, method: req.method, userId: req.user?._id },
      "Test unhandled error in adminRoute.test.js"
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
  email,
  password,
  name,
  privlegeLevel = "user"
) => {
  const userCredentials = { email, password, name, privlegeLevel };
  // Register user directly without agent
  const registerRes = await request(app)
    .post("/api/auth/register")
    .send(userCredentials);
  expect(registerRes.statusCode).toBe(201);
  const createdUser = await User.findOne({ email });
  expect(createdUser).toBeDefined();
  if (privlegeLevel === "admin" && createdUser) {
    // Ensure admin privilege is set correctly
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

describe("Admin Routes API (/api/admin)", () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    app = initializeTestApp();

    const adminData = await createAndLoginUser(
      `admin-${Date.now()}@example.com`,
      "password123",
      "Admin User",
      "admin"
    );
    adminAgent = adminData.agent;
    adminUser = adminData.user;

    const userData = await createAndLoginUser(
      `user-${Date.now()}@example.com`,
      "password123",
      "Regular User"
    );
    userAgent = userData.agent;
    regularUser = userData.user;
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: createdUserIds } });
      }
      if (createdSystemPromptIds.length > 0) {
        await SystemPrompt.deleteMany({ _id: { $in: createdSystemPromptIds } });
      }
    } catch (error) {
      console.error("Error in adminRoute.test.js afterAll:", error);
    }
    createdUserIds = [];
    createdSystemPromptIds = [];
  });

  describe("GET /api/admin/users", () => {
    it("should allow admin to list all users", async () => {
      const res = await adminAgent.get("/api/admin/users");
      expect(res.statusCode).toBe(200);
      expect(res.body.users).toBeInstanceOf(Array);
      expect(res.body.users.length).toBeGreaterThanOrEqual(2); // Admin and regular user
      const foundAdmin = res.body.users.find(
        (u) => u.email === adminUser.email
      );
      expect(foundAdmin).toBeDefined();
    });

    it("should deny non-admin from listing users", async () => {
      const res = await userAgent.get("/api/admin/users");
      expect(res.statusCode).toBe(403); // Forbidden
      expect(res.body.error).toBe("Admin access required.");
    });

    it("should deny unauthenticated access to list users", async () => {
      const res = await request(app).get("/api/admin/users");
      expect(res.statusCode).toBe(401); // Unauthorized
    });
  });

  describe("GET /api/admin/user/:id", () => {
    it("should allow admin to get a specific user details", async () => {
      const res = await adminAgent.get(`/api/admin/user/${regularUser._id}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(regularUser.email);
    });

    it("should return 404 if user ID does not exist (admin access)", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await adminAgent.get(`/api/admin/user/${fakeId}`);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe("User not found.");
    });

    it("should deny non-admin from getting user details", async () => {
      const res = await userAgent.get(`/api/admin/user/${adminUser._id}`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/admin/user/:id/prompts", () => {
    let prompt1;
    beforeEach(async () => {
      // Create prompts for the regularUser
      prompt1 = await SystemPrompt.create({
        name: `UserPrompt1-${Date.now()}`,
        identity: "User Test Bot 1",
        userId: regularUser._id,
      });
      createdSystemPromptIds.push(prompt1._id);
    });

    afterEach(async () => {
      if (prompt1) await SystemPrompt.findByIdAndDelete(prompt1._id);
      createdSystemPromptIds = createdSystemPromptIds.filter(
        (id) => id.toString() !== prompt1._id.toString()
      );
      prompt1 = null;
    });

    it("should allow admin to list prompts for a specific user", async () => {
      const res = await adminAgent.get(
        `/api/admin/user/${regularUser._id}/prompts`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.prompts).toBeInstanceOf(Array);
      expect(res.body.prompts.length).toBeGreaterThanOrEqual(1);
      const foundPrompt = res.body.prompts.find((p) => p.name === prompt1.name);
      expect(foundPrompt).toBeDefined();
    });

    it("should return empty array if user has no prompts (admin access)", async () => {
      // Create a new user with no prompts
      const noPromptUserData = await createAndLoginUser(
        `nopromptuser-${Date.now()}@example.com`,
        "password123",
        "No Prompt User"
      );
      const res = await adminAgent.get(
        `/api/admin/user/${noPromptUserData.user._id}/prompts`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.prompts).toEqual([]);
    });

    it("should deny non-admin from listing another user's prompts", async () => {
      const res = await userAgent.get(
        `/api/admin/user/${adminUser._id}/prompts`
      );
      expect(res.statusCode).toBe(403);
    });
  });

  describe("PATCH /api/admin/user/:id/privilege", () => {
    it("should allow admin to change a user's privilege to admin", async () => {
      const res = await adminAgent
        .patch(`/api/admin/user/${regularUser._id}/privilege`)
        .send({ privlegeLevel: "admin" });
      expect(res.statusCode).toBe(200);
      expect(res.body.user.privlegeLevel).toBe("admin");

      const updatedUser = await User.findById(regularUser._id);
      expect(updatedUser.privlegeLevel).toBe("admin");
      // Revert for other tests
      updatedUser.privlegeLevel = "user";
      await updatedUser.save();
    });

    it("should allow admin to change a user's privilege to user", async () => {
      // First make user admin
      await User.findByIdAndUpdate(regularUser._id, { privlegeLevel: "admin" });

      const res = await adminAgent
        .patch(`/api/admin/user/${regularUser._id}/privilege`)
        .send({ privlegeLevel: "user" });
      expect(res.statusCode).toBe(200);
      expect(res.body.user.privlegeLevel).toBe("user");
      const updatedUser = await User.findById(regularUser._id);
      expect(updatedUser.privlegeLevel).toBe("user");
    });

    it("should deny non-admin from changing privilege", async () => {
      const res = await userAgent
        .patch(`/api/admin/user/${adminUser._id}/privilege`)
        .send({ privlegeLevel: "user" });
      expect(res.statusCode).toBe(403);
    });

    it("should fail if privilege level is invalid", async () => {
      const res = await adminAgent
        .patch(`/api/admin/user/${regularUser._id}/privilege`)
        .send({ privlegeLevel: "superuser" }); // Invalid level
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe("Invalid privilege level.");
    });

    it("should return 404 if user ID does not exist for privilege change", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await adminAgent
        .patch(`/api/admin/user/${fakeId}/privilege`)
        .send({ privlegeLevel: "admin" });
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe("User not found.");
    });
  });
});
