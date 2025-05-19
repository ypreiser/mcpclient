// __tests__/routes/systemPromptRoute.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import logger from "../../utils/logger.js"; // mocked
import systemPromptRoutes from "../../routes/systemPromptRoute.js";
import authRoutes, { requireAuth } from "../../routes/authRoute.js";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";

let app;
let agent;
let testUser;

const initializeTestApp = () => {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(
    cors({
      origin: "http://localhost:5173",
      credentials: true,
      exposedHeaders: ["set-cookie"],
    })
  );
  testApp.use(express.json());
  testApp.use(cookieParser());

  process.env.NODE_ENV = "test";

  // Optional: Keep for debugging if necessary, otherwise can be removed
  // testApp.use((req, res, next) => {
  //   console.log('Request details:', {
  //     method: req.method,
  //     path: req.path,
  //     cookies: req.cookies,
  //   });
  //   next();
  // });

  const asyncMiddleware = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  testApp.use("/api/auth", authRoutes);
  testApp.use("/api/systemprompt", asyncMiddleware(requireAuth));
  testApp.use("/api/systemprompt", systemPromptRoutes);

  testApp.get("/api/testauth", asyncMiddleware(requireAuth), (req, res) => {
    res.status(200).json({ message: "auth ok", userId: req.user._id });
  });

  testApp.use((err, req, res, next) => {
    // console.error('Error in test app:', err); // Keep for debugging if needed
    logger.error(
      { err, path: req.path, method: req.method, userId: req.user?._id },
      "Test unhandled error in systemPromptRoute test"
    );
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Internal Server Error",
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  });

  return testApp;
};

describe("System Prompt API (/api/systemprompt)", () => {
  const userCredentials = {
    email: `promptadmin-${Date.now()}@example.com`,
    password: "password123",
    name: "Prompt Admin",
  };

  const getPromptData = (name = "test") => ({
    name: `${name}-${Date.now()}`,
    identity: "Test Bot Identity",
    primaryLanguage: "English",
    secondaryLanguages: ["Spanish"],
    knowledgeDomains: ["Testing"],
    description: "A test system prompt",
  });

  beforeAll(async () => {
    try {
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(process.env.MONGODB_URI);
      }

      app = initializeTestApp();

      const registerRes = await request(app)
        .post("/api/auth/register")
        .set("Accept", "application/json")
        .send(userCredentials);
      expect(registerRes.statusCode).toBe(201);

      agent = request.agent(app);

      const loginRes = await agent
        .post("/api/auth/login")
        .set("Accept", "application/json")
        .send(userCredentials);

      // Optional: Keep login response logging for debugging if necessary
      // console.log('Login response:', {
      //   status: loginRes.statusCode,
      //   headers: loginRes.headers,
      //   body: loginRes.body
      // });

      expect(loginRes.statusCode).toBe(200);
      expect(loginRes.body.user).toBeDefined();
      expect(loginRes.body.user.userId).toBeDefined();
      expect(loginRes.headers["set-cookie"]).toBeDefined();

      testUser = await User.findById(loginRes.body.user.userId);
      expect(testUser).toBeDefined(); // Ensure user was found

      const verifyAuth = await agent
        .get("/api/testauth")
        .set("Accept", "application/json");

      // Optional: Keep auth verification logging for debugging
      // console.log('Auth verification response:', {
      //   status: verifyAuth.statusCode,
      //   body: verifyAuth.body
      // });

      expect(verifyAuth.statusCode).toBe(200);
      expect(verifyAuth.body.message).toBe("auth ok");
      expect(verifyAuth.body.userId).toBe(testUser._id.toString());
    } catch (error) {
      console.error("Error in test setup (systemPromptRoute.test.js):", error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (testUser) {
        await SystemPrompt.deleteMany({ userId: testUser._id });
        await User.findByIdAndDelete(testUser._id);
      }
    } catch (error) {
      console.error(
        "Error in test cleanup (systemPromptRoute.test.js):",
        error
      );
      // Do not rethrow in afterAll to ensure other cleanup/tests can proceed
    }
  });

  describe("POST /api/systemprompt", () => {
    it("should create a new system prompt successfully", async () => {
      const promptData = getPromptData("test-prompt");
      const res = await agent
        .post("/api/systemprompt")
        .set("Accept", "application/json")
        .send(promptData);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty("name", promptData.name);
      expect(res.body).toHaveProperty("identity", promptData.identity);
      // MODIFICATION: Check for 'userId' instead of 'user'
      expect(res.body).toHaveProperty("userId", testUser._id.toString());
    });

    it("should fail to create a prompt with a duplicate name for the same user", async () => {
      const currentPromptData = getPromptData("dup-test");

      const firstRes = await agent
        .post("/api/systemprompt")
        .set("Accept", "application/json")
        .send(currentPromptData);
      expect(firstRes.statusCode).toBe(201);

      const res = await agent
        .post("/api/systemprompt")
        .set("Accept", "application/json")
        .send(currentPromptData);
      expect(res.statusCode).toBe(409);
      expect(res.body).toHaveProperty("error");
    });

    it("should fail if required fields (name, identity) are missing", async () => {
      const res = await agent
        .post("/api/systemprompt")
        .set("Accept", "application/json")
        .send({ primaryLanguage: "English" }); // Missing name and identity
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  describe("GET /api/systemprompt", () => {
    it("should get all system prompts for the authenticated user", async () => {
      const promptData = getPromptData("ListTest");
      const createRes = await agent
        .post("/api/systemprompt")
        .set("Accept", "application/json")
        .send(promptData);
      expect(createRes.statusCode).toBe(201);

      const res = await agent
        .get("/api/systemprompt")
        .set("Accept", "application/json");

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const createdPromptInList = res.body.find(
        (p) => p.name === promptData.name
      );
      expect(createdPromptInList).toBeDefined();
      expect(createdPromptInList).toHaveProperty(
        "userId",
        testUser._id.toString()
      );
      // Ensure at least one prompt is returned if we created one
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/systemprompt/:name", () => {
    let createdPromptData;
    let promptIdToClean; // Store ID for cleanup

    beforeEach(async () => {
      createdPromptData = getPromptData("SpecificGet");
      const createRes = await agent
        .post("/api/systemprompt")
        .send(createdPromptData);
      expect(createRes.statusCode).toBe(201);
      promptIdToClean = createRes.body._id; // Assuming _id is returned
    });

    afterEach(async () => {
      if (promptIdToClean) {
        await SystemPrompt.findByIdAndDelete(promptIdToClean);
        promptIdToClean = null;
      }
    });

    it("should get a specific system prompt by name", async () => {
      const res = await agent.get(
        `/api/systemprompt/${createdPromptData.name}`
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.name).toBe(createdPromptData.name);
      expect(res.body.identity).toBe(createdPromptData.identity);
      expect(res.body.userId).toBe(testUser._id.toString());
    });

    it("should return 404 if prompt name not found for the user", async () => {
      const res = await agent.get("/api/systemprompt/NonExistentPromptName");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PUT /api/systemprompt/:name", () => {
    let promptToUpdateData;
    let promptIdToClean;

    beforeEach(async () => {
      promptToUpdateData = getPromptData("UpdateTest");
      const createRes = await agent
        .post("/api/systemprompt")
        .send(promptToUpdateData);
      expect(createRes.statusCode).toBe(201);
      promptIdToClean = createRes.body._id;
    });

    afterEach(async () => {
      if (promptIdToClean) {
        await SystemPrompt.findByIdAndDelete(promptIdToClean);
        promptIdToClean = null;
      }
    });

    it("should update an existing system prompt", async () => {
      const updates = {
        identity: "Updated identity via agent",
        isActive: false,
      };

      const res = await agent
        .put(`/api/systemprompt/${promptToUpdateData.name}`)
        .send(updates);

      expect(res.statusCode).toBe(200);
      expect(res.body.identity).toBe(updates.identity);
      expect(res.body.isActive).toBe(updates.isActive);
      expect(res.body.userId).toBe(testUser._id.toString());
    });

    it("should return 404 if trying to update a non-existent prompt", async () => {
      const res = await agent
        .put("/api/systemprompt/FakePromptToUpdate")
        .send({ identity: "new" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/systemprompt/:name", () => {
    let promptToDeleteData;
    // No need for promptIdToClean here, as the test itself deletes it.

    beforeEach(async () => {
      promptToDeleteData = getPromptData("DeleteTest");
      const createRes = await agent
        .post("/api/systemprompt")
        .send(promptToDeleteData);
      expect(createRes.statusCode).toBe(201);
      // If the delete test fails, this prompt might linger. The afterAll hook for the main describe block should catch it.
    });

    it("should delete a system prompt", async () => {
      const res = await agent.delete(
        `/api/systemprompt/${promptToDeleteData.name}`
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Prompt deleted successfully");

      const deletedPrompt = await SystemPrompt.findOne({
        name: promptToDeleteData.name,
        userId: testUser._id,
      });
      expect(deletedPrompt).toBeNull();
    });

    it("should return 404 if trying to delete a non-existent prompt", async () => {
      const res = await agent.delete(
        "/api/systemprompt/NonExistentPromptToDelete"
      );
      expect(res.statusCode).toBe(404);
    });
  });
});
