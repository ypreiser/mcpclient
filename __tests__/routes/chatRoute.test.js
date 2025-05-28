import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Chat from "../../src/models/chatModel.js";
import chatRouter from "../../src/routes/chatRoute.js";
import mongoose from "mongoose";

// Mock Chat model
vi.mock("../../src/models/chatModel.js", () => {
  return {
    default: {
      find: vi.fn(),
      findById: vi.fn(),
      aggregate: vi.fn(),
    },
  };
});

// Create Express app for testing
const app = express();
app.use(express.json());

// Mock auth middleware
vi.mock("../../src/routes/authRoute.js", () => ({
  requireAuth: (req, res, next) => {
    if (req.headers["x-mock-user"]) {
      req.user = JSON.parse(req.headers["x-mock-user"]);
      next();
    } else {
      res.status(401).json({ error: "Unauthorized" });
    }
  },
}));

// Setup the router
app.use("/api/chats", chatRouter);

describe("Chat Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/chats", () => {
    it("should return all chats for admin users", async () => {
      const mockChats = [
        {
          _id: new mongoose.Types.ObjectId(),
          userId: { _id: "user1", email: "user1@test.com", name: "User 1" },
          updatedAt: new Date(),
          toObject: () => ({
            _id: "chat1",
            userId: "user1",
            updatedAt: new Date(),
          }),
        },
      ];

      const mockAggregateResult = [{ count: 5 }];

      Chat.find.mockReturnValue({
        populate: () => ({
          sort: () => ({
            select: () => mockChats,
          }),
        }),
      });

      Chat.aggregate.mockResolvedValueOnce(mockAggregateResult);

      const response = await request(app)
        .get("/api/chats")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "admin1",
            privlegeLevel: "admin",
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.chats).toBeDefined();
      expect(Chat.find).toHaveBeenCalledWith({});
    });

    it("should return only user's chats for regular users", async () => {
      const userId = new mongoose.Types.ObjectId();
      const mockChats = [
        {
          _id: new mongoose.Types.ObjectId(),
          updatedAt: new Date(),
          toObject: () => ({
            _id: "chat1",
            userId: userId.toString(),
            updatedAt: new Date(),
          }),
        },
      ];

      const mockAggregateResult = [{ count: 3 }];

      Chat.find.mockReturnValue({
        sort: () => ({
          select: () => mockChats,
        }),
      });

      Chat.aggregate.mockResolvedValueOnce(mockAggregateResult);

      const response = await request(app)
        .get("/api/chats")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: userId.toString(),
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.chats).toBeDefined();
      expect(Chat.find).toHaveBeenCalledWith({ userId: userId.toString() });
    });

    it("should handle errors when fetching chats", async () => {
      Chat.find.mockImplementation(() => {
        throw new Error("Database error");
      });

      const response = await request(app)
        .get("/api/chats")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "user1",
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Failed to fetch chats.");
    });

    it("should return 401 if not authenticated", async () => {
      const response = await request(app).get("/api/chats");
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/chats/:id", () => {
    it("should return a specific chat for admin", async () => {
      const mockChat = {
        _id: "chat1",
        userId: {
          _id: "user1",
          email: "user1@test.com",
          name: "User 1",
        },
        messages: [],
      };

      Chat.findById.mockReturnValue({
        populate: () => mockChat,
      });

      const response = await request(app)
        .get("/api/chats/chat1")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "admin1",
            privlegeLevel: "admin",
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.chat).toEqual(mockChat);
      expect(Chat.findById).toHaveBeenCalledWith("chat1");
    });

    it("should return user's own chat", async () => {
      const userId = "user1";
      const mockChat = {
        _id: "chat1",
        userId: {
          _id: userId,
          email: "user1@test.com",
          name: "User 1",
        },
        messages: [],
      };

      Chat.findById.mockReturnValue({
        populate: () => mockChat,
      });

      const response = await request(app)
        .get("/api/chats/chat1")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: userId,
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(200);
      expect(response.body.chat).toEqual(mockChat);
    });

    it("should return 403 when user tries to access another user's chat", async () => {
      const mockChat = {
        _id: "chat1",
        userId: {
          _id: "user2",
          email: "user2@test.com",
          name: "User 2",
        },
        messages: [],
      };

      Chat.findById.mockReturnValue({
        populate: () => mockChat,
      });

      const response = await request(app)
        .get("/api/chats/chat1")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "user1",
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Access denied.");
    });

    it("should return 404 when chat not found", async () => {
      Chat.findById.mockReturnValue({
        populate: () => null,
      });

      const response = await request(app)
        .get("/api/chats/nonexistent")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "user1",
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Chat not found.");
    });

    it("should handle errors when fetching a specific chat", async () => {
      Chat.findById.mockImplementation(() => {
        throw new Error("Database error");
      });

      const response = await request(app)
        .get("/api/chats/chat1")
        .set(
          "x-mock-user",
          JSON.stringify({
            _id: "user1",
            privlegeLevel: "user",
          })
        );

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Failed to fetch chat.");
    });

    it("should return 401 if not authenticated", async () => {
      const response = await request(app).get("/api/chats/chat1");
      expect(response.status).toBe(401);
    });
  });
});
