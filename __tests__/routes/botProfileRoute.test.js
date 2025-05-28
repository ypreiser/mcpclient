// Integration tests for botProfileRoute.js
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import dotenv from "dotenv";
import botProfileRoutes from "../../src/routes/botProfileRoute.js";
import authRoutes, { requireAuth } from "../../src/routes/authRoute.js";
import logger from "../../src/utils/logger.js";

let app;
let userToken;
let userId;
let createdProfileId;
const validProfile = {
  name: "TestBot",
  identity: "I am a test bot.",
  description: "A bot for testing.",
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
  // Error handler
  testApp.use((err, req, res, next) => {
    logger.error({ err }, "Test unhandled error");
    res
      .status(err.status || 500)
      .json({ error: { message: err.message || "Internal Server Error" } });
  });
  return testApp;
};

const testUser = {
  email: "botprofiletest@example.com",
  password: "password123",
  name: "BotProfile Tester",
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
  userId = loginRes.body.user._id;
  // Do NOT create a bot profile here. Each test will create its own as needed.
});

describe("BotProfile API Integration", () => {
  it("should create a new bot profile", async () => {
    const res = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty("_id");
    expect(res.body).toHaveProperty("name", validProfile.name);
    createdProfileId = res.body._id;
  });

  it("should not allow duplicate bot profile names for the same user", async () => {
    // Create the first profile
    await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    // Attempt duplicate
    const res = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/already exists/);
  });

  it("should get all bot profiles for the user", async () => {
    // Create a profile
    await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const res = await request(app)
      .get("/api/botProfile/")
      .set("Cookie", userToken);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("should get a bot profile by ID", async () => {
    // Create a profile
    const createRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const id = createRes.body._id;
    const res = await request(app)
      .get(`/api/botProfile/${id}`)
      .set("Cookie", userToken);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("_id", id);
  });

  it("should get a bot profile by name", async () => {
    // Create a profile
    await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const res = await request(app)
      .get(`/api/botProfile/byName/${validProfile.name}`)
      .set("Cookie", userToken);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("name", validProfile.name);
  });

  it("should update a bot profile", async () => {
    // Create a profile
    const createRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const id = createRes.body._id;
    const res = await request(app)
      .put(`/api/botProfile/${id}`)
      .set("Cookie", userToken)
      .send({ description: "Updated description." });
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("description", "Updated description.");
  });

  it("should not allow changing name or userId via update", async () => {
    // Create a profile
    const createRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const id = createRes.body._id;
    const res = await request(app)
      .put(`/api/botProfile/${id}`)
      .set("Cookie", userToken)
      .send({ name: "HackerBot", userId: "1234567890abcdef12345678" });
    expect(res.statusCode).toBe(400);
    expect(
      res.body.errors.some((e) => e.msg && e.msg.includes("cannot be changed"))
    ).toBe(true);
  });

  it("should delete a bot profile", async () => {
    // Create a profile
    const createRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const id = createRes.body._id;
    const res = await request(app)
      .delete(`/api/botProfile/${id}`)
      .set("Cookie", userToken);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("message");
  });

  it("should return 404 for getting a deleted profile", async () => {
    // Create and delete a profile
    const createRes = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send(validProfile);
    const id = createRes.body._id;
    await request(app).delete(`/api/botProfile/${id}`).set("Cookie", userToken);
    const res = await request(app)
      .get(`/api/botProfile/${id}`)
      .set("Cookie", userToken);
    expect(res.statusCode).toBe(404);
  });

  it("should return validation error for missing required fields", async () => {
    const res = await request(app)
      .post("/api/botProfile/")
      .set("Cookie", userToken)
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.errors).toBeDefined();
  });
});
