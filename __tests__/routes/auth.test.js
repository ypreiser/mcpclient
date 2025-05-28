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
import logger from "../../src/utils/logger.js"; // mocked

import authRoutes, { requireAuth } from "../../src/routes/authRoute.js";

// Minimal app setup for testing auth routes specifically
let app;
let server; // To hold the http.Server instance for proper closing

const initializeTestApp = () => {
  dotenv.config(); // Load .env variables
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors({ origin: "http://localhost:5173", credentials: true }));
  testApp.use(express.json());
  testApp.use(cookieParser());

  // Mock the global error handler or use a simplified one for tests
  // eslint-disable-next-line no-unused-vars
  testApp.use((err, req, res, next) => {
    logger.error({ err }, "Test unhandled error"); // Use the mocked logger
    res.status(err.status || 500).json({
      error: { message: err.message || "Internal Server Error" },
    });
  });

  testApp.use("/api/auth", authRoutes);
  // Dummy protected route for testing requireAuth
  testApp.get("/api/protected", requireAuth, (req, res) =>
    res.json({ message: "accessed", userId: req.user._id })
  );

  return testApp;
};

// Ensure logger methods are spies for all tests
beforeAll(() => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "debug").mockImplementation(() => {});
  vi.spyOn(logger, "fatal").mockImplementation(() => {});
});

describe("Auth Routes API", () => {
  beforeAll(async () => {
    // Set up test environment
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "test-secret-key";

    app = initializeTestApp(); // Initialize the app instance for this test suite
  });

  afterAll(async () => {
    // if (server) {
    //   server.close();
    // }
  });

  const userData = {
    email: "test@example.com",
    password: "password123",
    name: "Test User",
  };

  describe("POST /api/auth/register", () => {
    it("should register a new user successfully", async () => {
      const res = await request(app).post("/api/auth/register").send(userData);
      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty(
        "message",
        "User registered successfully."
      );
      expect(res.body).toHaveProperty("userId");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ email: userData.email }),
        "User registered successfully"
      );
    });

    it("should fail to register if email already exists", async () => {
      await request(app).post("/api/auth/register").send(userData); // First registration
      const res = await request(app).post("/api/auth/register").send(userData); // Attempt second
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
    beforeEach(async () => {
      // Ensure user is registered before each login test
      await request(app).post("/api/auth/register").send(userData);
    });

    it("should login an existing user successfully and set cookie", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: userData.email, password: userData.password });

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty("message", "Login successful.");
      expect(res.body.user).toHaveProperty("email", userData.email);
      expect(res.headers["set-cookie"]).toBeDefined();
      expect(res.headers["set-cookie"][0]).toContain("token=");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ email: userData.email, success: true }),
        "Login successful"
      );
    });

    it("should fail to login with incorrect password", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: userData.email, password: "wrongpassword" });
      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty("error", "Invalid email or password.");
    });
  });

  describe("GET /api/protected (testing requireAuth)", () => {
    beforeEach(async () => {
      await request(app).post("/api/auth/register").send(userData);
    });

    it("should allow access with a valid token cookie", async () => {
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ email: userData.email, password: userData.password });

      const tokenCookie = loginRes.headers["set-cookie"][0];

      const protectedRes = await request(app)
        .get("/api/protected")
        .set("Cookie", tokenCookie); // Send cookie with the request

      expect(protectedRes.statusCode).toBe(200);
      expect(protectedRes.body).toHaveProperty("message", "accessed");
      expect(protectedRes.body).toHaveProperty("userId");
    });

    it("should deny access without a token cookie", async () => {
      const res = await request(app).get("/api/protected");
      expect(res.statusCode).toBe(401);
      expect(res.body).toHaveProperty(
        "error",
        "Authentication required. No token provided."
      );
    });
  });

  describe("POST /api/auth/logout", () => {
    it("should logout the user and clear the cookie", async () => {
      // First, register and login to get a cookie
      await request(app).post("/api/auth/register").send(userData);
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ email: userData.email, password: userData.password });
      const tokenCookie = loginRes.headers["set-cookie"][0];

      const logoutRes = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", tokenCookie); // Send original cookie to ensure it's processed if needed by logout logic

      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.body).toHaveProperty(
        "message",
        "Logged out successfully."
      );
      // Check if the cookie is cleared      // Check if cookie is cleared (either by Max-Age=0 or Expires in the past)
      const cookie = logoutRes.headers["set-cookie"][0];
      expect(cookie).toContain("token=;");
      expect(cookie).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/);
      expect(logger.info).toHaveBeenCalledWith(
        expect.anything(),
        "User logged out."
      ); // User ID might be undefined if cookie is cleared before log
    });
  });
});
