import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  initializeSession,
  getSession,
  processMessage,
  endSession,
} from "../../src/utils/sessionService.js";
import { processMessage as processMsg } from "../../src/utils/messageService.js";
import chatService from "../../src/utils/chatService.js";

vi.mock("../../src/utils/sessionService.js");
vi.mock("../../src/utils/messageService.js");

vi.mock("../../src/utils/messageService.js", () => ({
  processMessage: vi.fn(),
}));

describe("chatService.js", () => {
  const sessionId = "test-session-123";
  const botProfileId = "bot-profile-456";
  const userId = "user-789";
  const message = "test message";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("initializeSession", () => {
    it("should call sessionService.initializeSession with correct parameters", async () => {
      const mockResult = { status: "active", sessionId };
      initializeSession.mockResolvedValue(mockResult);

      const result = await chatService.initializeSession(
        sessionId,
        botProfileId,
        userId
      );

      expect(initializeSession).toHaveBeenCalledWith(
        sessionId,
        botProfileId,
        userId
      );
      expect(result).toEqual(mockResult);
    });

    it("should throw error if sessionService.initializeSession fails", async () => {
      const error = new Error("Initialization failed");
      initializeSession.mockRejectedValue(error);

      await expect(
        chatService.initializeSession(sessionId, botProfileId, userId)
      ).rejects.toThrow("Initialization failed");
    });
  });

  describe("getSession", () => {
    it("should call sessionService.getSession with correct parameters", () => {
      const mockSession = { status: "active", sessionId };
      getSession.mockReturnValue(mockSession);

      const result = chatService.getSession(sessionId);

      expect(getSession).toHaveBeenCalledWith(sessionId);
      expect(result).toEqual(mockSession);
    });

    it("should handle not found session", () => {
      const mockNotFound = { status: "not_found" };
      getSession.mockReturnValue(mockNotFound);

      const result = chatService.getSession("nonexistent-session");

      expect(result).toEqual(mockNotFound);
      expect(getSession).toHaveBeenCalledWith("nonexistent-session");
    });
  });

  describe("processMessage", () => {
    it("should call messageService.processMessage with correct parameters", async () => {
      const mockResponse = { text: "AI response", toolCalls: [] };
      processMsg.mockResolvedValue(mockResponse);

      const result = await chatService.processMessage(
        sessionId,
        message,
        userId,
        []
      );

      expect(processMsg).toHaveBeenCalledWith(
        sessionId,
        message,
        userId,
        []
      );
      expect(result).toEqual(mockResponse);
    });

    it("should handle attachments correctly", async () => {
      const attachments = [{ url: "test.jpg", type: "image/jpeg" }];
      const mockResponse = {
        text: "AI response with attachment",
        toolCalls: [],
      };
      processMsg.mockResolvedValue(mockResponse);

      const result = await chatService.processMessage(
        sessionId,
        message,
        userId,
        attachments
      );

      expect(processMsg).toHaveBeenCalledWith(
        sessionId,
        message,
        userId,
        attachments
      );
      expect(result).toEqual(mockResponse);
    });

    it("should throw error if messageService.processMessage fails", async () => {
      const error = new Error("Processing failed");
      processMsg.mockRejectedValue(error);

      await expect(
        chatService.processMessage(sessionId, message, userId)
      ).rejects.toThrow("Processing failed");
    });
  });

  describe("endSession", () => {
    it("should call sessionService.endSession with correct parameters", async () => {
      const mockResult = { status: "ended", message: "Session ended" };
      endSession.mockResolvedValue(mockResult);

      const result = await chatService.endSession(sessionId, userId);

      expect(endSession).toHaveBeenCalledWith(sessionId, userId);
      expect(result).toEqual(mockResult);
    });

    it("should handle not found session gracefully", async () => {
      const mockNotFound = { status: "not_found" };
      endSession.mockResolvedValue(mockNotFound);

      const result = await chatService.endSession(
        "nonexistent-session",
        userId
      );

      expect(result).toEqual(mockNotFound);
      expect(endSession).toHaveBeenCalledWith("nonexistent-session", userId);
    });

    it("should throw error if sessionService.endSession fails", async () => {
      const error = new Error("End session failed");
      endSession.mockRejectedValue(error);

      await expect(chatService.endSession(sessionId, userId)).rejects.toThrow(
        "End session failed"
      );
    });
  });
});
