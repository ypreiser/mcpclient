import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks
vi.mock("../../src/mcpClient.js", () => ({
  initializeAI: vi.fn(async () => ({ closeMcpClients: vi.fn(async () => {}) })),
}));
vi.mock("../../src/models/botProfileModel.js", () => ({
  default: {
    findOne: vi.fn(),
    findById: vi.fn(),
  },
}));
vi.mock("../../src/models/chatModel.js", () => ({
  default: {
    findOneAndUpdate: vi.fn(),
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  initializeSession,
  getSession,
  endSession,
  cleanupSession,
  sessions,
} from "../../src/utils/sessionService.js";
import { initializeAI } from "../../src/mcpClient.js";
import BotProfile from "../../src/models/botProfileModel.js";
import Chat from "../../src/models/chatModel.js";
import logger from "../../src/utils/logger.js";

const botProfileId = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const sessionId = "session-123";

function resetMocks() {
  vi.clearAllMocks();
  sessions.clear();
}

function mockLean(resolvedValue) {
  return { lean: () => Promise.resolve(resolvedValue) };
}
function mockSelectLean(resolvedValue) {
  return {
    select: () => ({
      lean: () => Promise.resolve(resolvedValue),
    }),
  };
}

describe("sessionService.js", () => {
  beforeEach(() => {
    resetMocks();
    // Patch findOne and findById to return .lean() or .select().lean()
    BotProfile.findOne.mockImplementation(() => mockLean(undefined));
    BotProfile.findById.mockImplementation(() => mockSelectLean(undefined));
  });
  afterEach(resetMocks);

  it("should initialize a session successfully", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({
        _id: botProfileId,
        name: "TestBot",
        isEnabled: true,
        userId,
      })
    );
    const result = await initializeSession(sessionId, botProfileId, userId);
    expect(result.status).toBe("active");
    expect(result.sessionId).toBe(sessionId);
    expect(result.botProfileId).toBe(botProfileId);
    expect(result.botProfileName).toBe("TestBot");
    expect(sessions.has(sessionId)).toBe(true);
    expect(logger.info).toHaveBeenCalled();
  });

  it("should not initialize if userIdForTokenBilling is missing", async () => {
    await expect(
      initializeSession(sessionId, botProfileId, undefined)
    ).rejects.toThrow("User ID for token billing is required");
    expect(logger.error).toHaveBeenCalled();
  });

  it("should not initialize if session already exists", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    await expect(
      initializeSession(sessionId, botProfileId, userId)
    ).rejects.toThrow("already active");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("should throw if bot profile not found", async () => {
    BotProfile.findOne.mockImplementation(() => mockLean(null));
    BotProfile.findById.mockImplementation(() => mockSelectLean(null));
    await expect(
      initializeSession(sessionId, botProfileId, userId)
    ).rejects.toThrow("not found");
    expect(logger.warn).toHaveBeenCalled();
  });
  it("should throw if user does not own the bot profile", async () => {
    BotProfile.findOne.mockImplementation(() => mockLean(null));
    BotProfile.findById.mockImplementation(() =>
      mockSelectLean({ _id: botProfileId, userId: "other", isEnabled: true })
    );
    await expect(
      initializeSession(sessionId, botProfileId, userId)
    ).rejects.toThrow("Access denied");
    expect(logger.warn).toHaveBeenCalled();
  });
  it("should throw if bot profile is disabled", async () => {
    BotProfile.findOne.mockImplementation(() => mockLean(null));
    BotProfile.findById.mockImplementation(() =>
      mockSelectLean({ _id: botProfileId, userId, isEnabled: false })
    );
    await expect(
      initializeSession(sessionId, botProfileId, userId)
    ).rejects.toThrow("disabled");
    expect(logger.warn).toHaveBeenCalled();
  });
  it("should throw if bot profile is disabled (explicit check)", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: false, userId })
    );
    await expect(
      initializeSession(sessionId, botProfileId, userId)
    ).rejects.toThrow("disabled");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("should clean up session and call aiInstance.closeMcpClients", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    const session = sessions.get(sessionId);
    session.aiInstance.closeMcpClients = vi.fn(async () => {});
    await cleanupSession(sessionId);
    expect(session.aiInstance.closeMcpClients).toHaveBeenCalled();
    expect(sessions.has(sessionId)).toBe(false);
    expect(logger.info).toHaveBeenCalled();
  });

  it("should handle error in aiInstance.closeMcpClients during cleanup", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    const session = sessions.get(sessionId);
    session.aiInstance.closeMcpClients = vi.fn(async () => {
      throw new Error("fail");
    });
    await cleanupSession(sessionId);
    expect(logger.error).toHaveBeenCalled();
    expect(sessions.has(sessionId)).toBe(false);
  });

  it("should get session info", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    const info = getSession(sessionId);
    expect(info.status).toBe("active");
    expect(info.botProfileName).toBe("TestBot");
    expect(info.userId).toBe(userId);
  });

  it("should return not_found for missing session", () => {
    const info = getSession("nope");
    expect(info.status).toBe("not_found");
  });

  it("should end session and archive chat", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    Chat.findOneAndUpdate.mockResolvedValue({ sessionId });
    const result = await endSession(sessionId, userId);
    expect(result.status).toBe("ended");
    expect(result.message).toContain("ended");
    expect(logger.info).toHaveBeenCalled();
  });

  it("should not end session if not found", async () => {
    const result = await endSession("nope", userId);
    expect(result.status).toBe("not_found");
  });

  it("should throw if unauthorized user tries to end session", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    await expect(endSession(sessionId, "other")).rejects.toThrow(
      "Unauthorized"
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("should handle error during chat archiving in endSession", async () => {
    BotProfile.findOne.mockImplementation(() =>
      mockLean({ _id: botProfileId, name: "TestBot", isEnabled: true, userId })
    );
    await initializeSession(sessionId, botProfileId, userId);
    Chat.findOneAndUpdate.mockRejectedValue(new Error("fail"));
    await expect(endSession(sessionId, userId)).rejects.toThrow(
      "internal error"
    );
    expect(logger.error).toHaveBeenCalled();
  });
});
