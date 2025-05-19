// __tests__/services/tokenUsageService.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"; // Added afterEach
import mongoose from "mongoose";
import { logTokenUsage } from "../../utils/tokenUsageService.js";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";
import TokenUsageRecord from "../../models/tokenUsageRecordModel.js";
import Chat from "../../models/chatModel.js";
import logger from "../../utils/logger.js"; // Mocked

describe("Token Usage Service", () => {
  let testUser;
  let testSystemPrompt;
  let testChat;
  // Store IDs for cleanup
  let testUserId, testSystemPromptId, testChatId;

  beforeEach(async () => {
    const timestamp = Date.now();
    testUser = await User.create({
      email: `tokenuser-${timestamp}@example.com`,
      password: "password",
    });
    testUserId = testUser._id;

    testSystemPrompt = await SystemPrompt.create({
      name: `TokenTestPrompt-${timestamp}`,
      identity: "Test prompt for tokens",
      userId: testUser._id,
    });
    testSystemPromptId = testSystemPrompt._id;

    testChat = await Chat.create({
      sessionId: `token-chat-session-${timestamp}`,
      systemPromptId: testSystemPrompt._id,
      systemPromptName: testSystemPrompt.name,
      source: "webapp",
      userId: testUser._id,
      messages: [],
    });
    testChatId = testChat._id;

    vi.spyOn(User, "logTokenUsage").mockClear();
    vi.spyOn(SystemPrompt, "logTokenUsage").mockClear();
  });

  afterEach(async () => {
    // Cleanup data created in beforeEach
    if (testChatId) await Chat.findByIdAndDelete(testChatId);
    if (testSystemPromptId)
      await SystemPrompt.findByIdAndDelete(testSystemPromptId);
    if (testUserId) await User.findByIdAndDelete(testUserId);
    // Clean up token usage records associated with the test user or chat
    if (testUserId) await TokenUsageRecord.deleteMany({ userId: testUserId });

    testChatId = null;
    testSystemPromptId = null;
    testUserId = null;
    testUser = null;
    testSystemPrompt = null;
    testChat = null;
  });

  it("should log token usage and update User and SystemPrompt models", async () => {
    const usageData = {
      userIdForTokenBilling: testUser._id,
      systemPromptId: testSystemPrompt._id,
      systemPromptName: testSystemPrompt.name,
      chatId: testChat._id,
      modelName: "gemini-test-model",
      promptTokens: 100,
      completionTokens: 150,
      sessionId: testChat.sessionId,
      source: "webapp",
    };

    await logTokenUsage(usageData);

    const record = await TokenUsageRecord.findOne({ chatId: testChat._id });
    expect(record).not.toBeNull();
    expect(record.promptTokens).toBe(100);
    expect(record.completionTokens).toBe(150);
    expect(record.totalTokens).toBe(250);
    expect(record.userId.toString()).toBe(testUser._id.toString());

    expect(User.logTokenUsage).toHaveBeenCalledWith({
      userId: testUser._id,
      promptTokens: 100,
      completionTokens: 150,
    });

    expect(SystemPrompt.logTokenUsage).toHaveBeenCalledWith({
      systemPromptId: testSystemPrompt._id,
      promptTokens: 100,
      completionTokens: 150,
    });

    const updatedUser = await User.findById(testUser._id);
    expect(updatedUser.totalLifetimePromptTokens).toBe(100);
    expect(updatedUser.totalLifetimeCompletionTokens).toBe(150);

    const updatedPrompt = await SystemPrompt.findById(testSystemPrompt._id);
    expect(updatedPrompt.totalPromptTokensUsed).toBe(100);
    expect(updatedPrompt.totalCompletionTokensUsed).toBe(150);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: testUser._id,
        promptTokens: 100,
        completionTokens: 150,
        totalTokens: 250,
        source: "webapp",
        sessionId: testChat.sessionId,
      }),
      "Token usage logged for webapp chat."
    );
  });

  it("should throw an error if User.logTokenUsage fails", async () => {
    vi.mocked(User.logTokenUsage).mockRejectedValueOnce(
      new Error("User update failed")
    );
    const usageData = {
      userIdForTokenBilling: testUser._id,
      systemPromptId: testSystemPrompt._id,
      systemPromptName: testSystemPrompt.name,
      chatId: testChat._id,
      modelName: "gemini-test-model",
      promptTokens: 10,
      completionTokens: 20,
      sessionId: "test-session",
      source: "webapp",
    };
    await expect(logTokenUsage(usageData)).rejects.toThrow(
      "User update failed"
    );
  });

  it("should throw an error if SystemPrompt.logTokenUsage fails", async () => {
    vi.mocked(SystemPrompt.logTokenUsage).mockRejectedValueOnce(
      new Error("Prompt update failed")
    );
    const usageData = {
      userIdForTokenBilling: testUser._id,
      systemPromptId: testSystemPrompt._id,
      systemPromptName: testSystemPrompt.name,
      chatId: testChat._id,
      modelName: "gemini-test-model",
      promptTokens: 10,
      completionTokens: 20,
      sessionId: "test-session",
      source: "webapp",
    };
    await expect(logTokenUsage(usageData)).rejects.toThrow(
      "Prompt update failed"
    );
  });
});
