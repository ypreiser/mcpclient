// Mocks must be at the very top, before any imports that use the models!
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("../../src/models/tokenUsageRecordModel.js", () => ({
  default: vi.fn(),
}));
vi.mock("../../src/models/userModel.js", () => ({
  default: { logTokenUsage: vi.fn() },
}));
vi.mock("../../src/models/botProfileModel.js", () => ({
  default: { logTokenUsage: vi.fn() },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import * as tokenUsageService from "../../src/utils/tokenUsageService.js";
import TokenUsageRecord from "../../src/models/tokenUsageRecordModel.js";
import User from "../../src/models/userModel.js";
import BotProfile from "../../src/models/botProfileModel.js";
import logger from "../../src/utils/logger.js";

describe("logTokenUsage (tokenUsageService)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs token usage and updates user and bot profile", async () => {
    const saveMock = vi.fn();
    TokenUsageRecord.mockImplementation(() => ({ save: saveMock }));
    User.logTokenUsage.mockResolvedValue({});
    BotProfile.logTokenUsage.mockResolvedValue({});
    logger.info.mockImplementation(() => {});

    const params = {
      userIdForTokenBilling: "user1",
      botProfileId: "bot1",
      botProfileName: "BotName",
      chatId: "chat1",
      modelName: "gpt-4",
      promptTokens: 10,
      completionTokens: 20,
      sessionId: "session1",
      source: "webapp",
    };
    await tokenUsageService.logTokenUsage(params);
    expect(TokenUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: params.userIdForTokenBilling,
        botProfileId: params.botProfileId,
        botProfileName: params.botProfileName,
        chatId: params.chatId,
        modelName: params.modelName,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        totalTokens: 30,
        source: params.source,
      })
    );
    expect(saveMock).toHaveBeenCalled();
    expect(User.logTokenUsage).toHaveBeenCalledWith({
      userId: params.userIdForTokenBilling,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
    });
    expect(BotProfile.logTokenUsage).toHaveBeenCalledWith({
      botProfileId: params.botProfileId,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
    });
    expect(logger.info).toHaveBeenCalled();
  });

  it("logs error and skips DB ops for invalid token counts", async () => {
    logger.error.mockImplementation(() => {});
    await tokenUsageService.logTokenUsage({
      userIdForTokenBilling: "user1",
      botProfileId: "bot1",
      botProfileName: "BotName",
      chatId: "chat1",
      modelName: "gpt-4",
      promptTokens: NaN,
      completionTokens: 20,
      sessionId: "session1",
      source: "webapp",
    });
    expect(logger.error).toHaveBeenCalled();
    expect(TokenUsageRecord).not.toHaveBeenCalled();
    expect(User.logTokenUsage).not.toHaveBeenCalled();
    expect(BotProfile.logTokenUsage).not.toHaveBeenCalled();
  });

  it("handles different sources (webapp, whatsapp)", async () => {
    const saveMock = vi.fn();
    TokenUsageRecord.mockImplementation(() => ({ save: saveMock }));
    User.logTokenUsage.mockResolvedValue({});
    BotProfile.logTokenUsage.mockResolvedValue({});
    logger.info.mockImplementation(() => {});
    await tokenUsageService.logTokenUsage({
      userIdForTokenBilling: "user1",
      botProfileId: "bot1",
      botProfileName: "BotName",
      chatId: "chat1",
      modelName: "gpt-4",
      promptTokens: 5,
      completionTokens: 5,
      sessionId: "session1",
      source: "whatsapp",
    });
    expect(TokenUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ source: "whatsapp" })
    );
    expect(logger.info).toHaveBeenCalled();
  });
});
