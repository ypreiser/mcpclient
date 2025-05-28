// __tests__/utils/chatUtils.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isUrl, validateBotProfile } from "../../src/utils/chatUtils.js";
import BotProfile from "../../src/models/botProfileModel.js";

// Mock BotProfile model
vi.mock("../../src/models/botProfileModel.js", () => {
  const mockBotProfile = vi.fn();
  mockBotProfile.findOne = vi.fn();
  mockBotProfile.exists = vi.fn();
  return { default: mockBotProfile };
});

describe("chatUtils", () => {
  describe("isUrl", () => {
    it("returns true for valid HTTP URLs", () => {
      expect(isUrl("http://example.com")).toBe(true);
      expect(isUrl("https://example.com")).toBe(true);
    });

    it("returns true for URLs with paths, query params and fragments", () => {
      expect(isUrl("https://example.com/path/to/page")).toBe(true);
      expect(isUrl("https://example.com/search?q=test&page=1")).toBe(true);
      expect(isUrl("https://example.com/page#section")).toBe(true);
    });

    it("returns true for URLs with subdomains and ports", () => {
      expect(isUrl("https://sub.example.com")).toBe(true);
      expect(isUrl("http://localhost:3000")).toBe(true);
    });

    it("returns false for non-URL strings", () => {
      expect(isUrl("not a url")).toBe(false);
      expect(isUrl("ftp://example.com")).toBe(false); // Only http/https
      expect(isUrl("example.com")).toBe(false); // Missing protocol
    });

    it("returns false for non-string inputs", () => {
      expect(isUrl(null)).toBe(false);
      expect(isUrl(undefined)).toBe(false);
      expect(isUrl(123)).toBe(false);
      expect(isUrl({})).toBe(false);
      expect(isUrl([])).toBe(false);
    });
  });

  describe("validateBotProfile", () => {
    const mockBotProfile = {
      _id: "mockBotId",
      name: "TestBot",
      userId: "mockUserId",
    };

    beforeEach(() => {
      // Reset all mock functions before each test
      vi.clearAllMocks();
    });

    it("returns bot profile when it exists and belongs to user", async () => {
      BotProfile.findOne.mockResolvedValueOnce(mockBotProfile);

      const result = await validateBotProfile("TestBot", "mockUserId");

      expect(result).toBe(mockBotProfile);
      expect(BotProfile.findOne).toHaveBeenCalledWith({
        name: "TestBot",
        userId: "mockUserId",
      });
      expect(BotProfile.exists).not.toHaveBeenCalled();
    });

    it("throws 404 when bot profile does not exist", async () => {
      BotProfile.findOne.mockResolvedValueOnce(null);
      BotProfile.exists.mockResolvedValueOnce(false);

      await expect(
        validateBotProfile("NonexistentBot", "mockUserId")
      ).rejects.toThrow("Bot profile 'NonexistentBot' not found.");

      expect(BotProfile.findOne).toHaveBeenCalledWith({
        name: "NonexistentBot",
        userId: "mockUserId",
      });
      expect(BotProfile.exists).toHaveBeenCalledWith({
        name: "NonexistentBot",
      });
    });

    it("throws 403 when bot profile exists but belongs to another user", async () => {
      BotProfile.findOne.mockResolvedValueOnce(null);
      BotProfile.exists.mockResolvedValueOnce(true);

      await expect(
        validateBotProfile("ExistingBot", "wrongUserId")
      ).rejects.toThrow(
        "Access denied: You do not own bot profile 'ExistingBot'."
      );

      expect(BotProfile.findOne).toHaveBeenCalledWith({
        name: "ExistingBot",
        userId: "wrongUserId",
      });
      expect(BotProfile.exists).toHaveBeenCalledWith({ name: "ExistingBot" });
    });

    it("preserves error status codes", async () => {
      BotProfile.findOne.mockResolvedValueOnce(null);
      BotProfile.exists.mockResolvedValueOnce(true);

      try {
        await validateBotProfile("ExistingBot", "wrongUserId");
      } catch (err) {
        expect(err.status).toBe(403);
      }

      BotProfile.findOne.mockResolvedValueOnce(null);
      BotProfile.exists.mockResolvedValueOnce(false);

      try {
        await validateBotProfile("NonexistentBot", "mockUserId");
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });
  });
});
