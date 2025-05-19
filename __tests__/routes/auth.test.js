//mcpclient/__tests__/routes/auth.test.js
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
import mongoose from "mongoose";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import helmet from "helmet";
import logger from "../../utils/logger.js"; // mocked

import authRoutes, { requireAuth } from "../../routes/authRoute.js";
import User from "../../models/userModel.js"; // Import User model

let app;
// No global agent needed here as tests create their own or use direct requests.

// To store emails of users created during tests for cleanup
const createdUserEmails = new Set();

const initializeTestApp = () => {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: "http://localhost:5173", credentials: true }));
  testApp.use(express.json());
  testApp.use(cookieParser());

  testApp.use("/api/auth", authRoutes);
  testApp.get("/api/protected", requireAuth, (req, res) =>
    res.json({
      message: "accessed",
      userId: req.user._id,
      email: req.user.email,
    })
  );

  testApp.use((err, req, res, next) => {
    logger.error(
      { err, path: req.path, method: req.method, body: req.body },
      "Test unhandled error in auth.test.js"
    );
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
      error: { message: err.message || "Internal Server Error" },
      ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
    });
  });
  return testApp;
};

describe("Auth Routes API", () => {
  beforeAll(async () => {
    app = initializeTestApp();
  });

  afterAll(async () => {
    // Clean up all users created during these tests
    if (createdUserEmails.size > 0) {
      try {
        await User.deleteMany({
          email: { $in: Array.from(createdUserEmails) },
        });
        createdUserEmails.clear();
      } catch (error) {
        console.error("Error cleaning up users in auth.test.js:", error);
      }
    }
  });

  const getUserData = () => {
    const email = `test-${Date.now()}@example.com`;
    // Store email for cleanup
    // createdUserEmails.add(email); // Handled by direct creation tracking below
    return {
      email: email,
      password: "password123",
      name: "Test User",
    };
  };

  describe("POST /api/auth/register", () => {
    it("should register a new user successfully", async () => {
      const currentUserData = getUserData();
      const res = await request(app)
        .post("/api/auth/register")
        .send(currentUserData);
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty(
        "message",
        "User registered successfully."
      );
      expect(res.body).toHaveProperty("userId");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ email: currentUserData.email }),
        "User registered successfully"
      );
      createdUserEmails.add(currentUserData.email); // Track for cleanup
    });

    it("should fail to register if email already exists", async () => {
      const currentUserData = getUserData();
      // First registration
      await request(app).post("/api/auth/register").send(currentUserData);
      createdUserEmails.add(currentUserData.email); // Track for cleanup

      // Attempt to register again
      const res = await request(app)
        .post("/api/auth/register")
        .send(currentUserData);
      expect(res.statusCode).toBe(409);
      expect(res.body).toHaveProperty("error", "Email already registered.");
    });

    it("should fail if email is not provided", async () => {
      const res = await request(app)
        .post("/api/auth/register")
        .send({ password: "password123" });
      expect(res.statusCode).toBe(400);
      expect(res.body).toHaveProperty(
        "error",
        "Email and password are required."
      );
    });
  });

  describe("POST /api/auth/login", () => {
    let localUserData;
    let localAgent;

    beforeEach(async () => {
      localUserData = getUserData();
      localAgent = request.agent(app);
      // Register user directly
      await request(app).post("/api/auth/register").send(localUserData);
      createdUserEmails.add(localUserData.email); // Track for cleanup
    });

    // afterEach already handled by afterAll for this structure

    it("should login an existing user successfully and set cookie", async () => {
      const res = await localAgent
        .post("/api/auth/login")
        .send({ email: localUserData.email, password: localUserData.password });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Login successful.");
      expect(res.body.user).toHaveProperty("email", localUserData.email);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"][0]).toContain("token=");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ email: localUserData.email, success: true }),
        "Login successful"
      );
    });

    it("should fail to login with incorrect password", async () => {
      const res = await localAgent
        .post("/api/auth/login")
        .send({ email: localUserData.email, password: "wrongpassword" });
      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty("error", "Invalid email or password.");
    });
  });

  describe("GET /api/protected (testing requireAuth)", () => {
    let protectedRouteAgent;
    let protectedUserData;

    beforeEach(async () => {
      protectedUserData = getUserData();
      protectedRouteAgent = request.agent(app);
      await protectedRouteAgent
        .post("/api/auth/register")
        .send(protectedUserData);
      createdUserEmails.add(protectedUserData.email); // Track for cleanup

      const loginRes = await protectedRouteAgent
        .post("/api/auth/login")
        .send(protectedUserData);
      expect(loginRes.statusCode).toBe(200);
    });

    it("should allow access with a valid token cookie (via agent)", async () => {
      const protectedRes = await protectedRouteAgent.get("/api/protected");
      expect(protectedRes.statusCode).toBe(200);
      expect(protectedRes.body).toHaveProperty("message", "accessed");
      expect(protectedRes.body).toHaveProperty("userId");
      expect(protectedRes.body.email).toBe(protectedUserData.email);
    });

    it("should deny access without a token cookie (new agent)", async () => {
      const newAgentWithoutLogin = request.agent(app);
      const res = await newAgentWithoutLogin.get("/api/protected");
      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty(
        "error",
        "Authentication required. No token provided."
      );
    });
  });

  describe("POST /api/auth/logout", () => {
    let logoutAgent;
    let logoutUserData;

    beforeEach(async () => {
      logoutUserData = getUserData();
      logoutAgent = request.agent(app);
      await logoutAgent.post("/api/auth/register").send(logoutUserData);
      createdUserEmails.add(logoutUserData.email); // Track for cleanup

      const loginRes = await logoutAgent
        .post("/api/auth/login")
        .send(logoutUserData);
      expect(loginRes.statusCode).toBe(200);
    });

    it("should logout the user and clear the cookie", async () => {
      const logoutRes = await logoutAgent.post("/api/auth/logout");

      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.body).toHaveProperty(
        "message",
        "Logged out successfully."
      );
      const cookie = logoutRes.headers["set-cookie"][0];
      expect(cookie).toContain("token=;");
      expect(cookie).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.toSatisfy(
            (v) => typeof v === "string" || v === undefined
          ),
          ip: expect.anything(),
        }),
        "User logged out."
      );

      const protectedRes = await logoutAgent.get("/api/protected");
      expect(protectedRes.statusCode).toBe(401);
    });
  });
});
