// __tests__/utils/whatsappMessageProcessor.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import WhatsAppMessageProcessor from "../../src/utils/whatsappMessageProcessor.js";

// Mocks for all dependencies
vi.mock("../../src/models/chatModel.js", () => ({
  default: {
    findOneAndUpdate: vi.fn().mockResolvedValue({
      messages: [],
      save: vi.fn().mockResolvedValue(),
      _id: "chatid",
    }),
  },
}));
vi.mock("../../src/models/userModel.js", () => ({ default: {} }));
vi.mock("../../src/models/tokenUsageRecordModel.js", () => ({ default: {} }));
vi.mock("../../src/models/botProfileModel.js", () => ({
  default: {
    findById: vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn().mockResolvedValue({ name: "BotName" }),
      })),
    })),
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("cloudinary", () => ({
  v2: {
    uploader: {
      upload: vi.fn().mockResolvedValue({ secure_url: "https://img.url" }),
    },
    config: vi.fn(),
  },
}));
vi.mock("ai", () => ({
  generateText: vi
    .fn()
    .mockResolvedValue({
      text: "AI response",
      usage: { promptTokens: 1, completionTokens: 1 },
    }),
}));
vi.mock("../../src/utils/messageContentUtils.js", () => ({
  normalizeDbMessageContentForAI: vi.fn((c) => c),
}));
vi.mock("../../src/utils/tokenUsageService.js", () => ({
  logTokenUsage: vi.fn(),
}));

function makeMessage({
  body = "hi",
  hasMedia = false,
  from = "12345@wa",
  isStatus = false,
  fromMe = false,
  downloadMedia,
  getContact,
  reply,
} = {}) {
  return {
    body,
    hasMedia,
    from,
    isStatus,
    fromMe,
    downloadMedia: downloadMedia || vi.fn(),
    getContact:
      getContact ||
      vi.fn().mockResolvedValue({ name: "User", pushname: "UserPush" }),
    reply: reply || vi.fn().mockResolvedValue(),
  };
}

describe("WhatsAppMessageProcessor", () => {
  let processor;
  beforeEach(() => {
    processor = new WhatsAppMessageProcessor(() => ({}));
    vi.clearAllMocks();
  });

  it("replies if AI instance is missing", async () => {
    const msg = makeMessage();
    await processor.processIncomingMessage(msg, "conn1", {});
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining("AI for this chat is not ready")
    );
  });

  it("replies if no processable content", async () => {
    const msg = makeMessage({ body: "", hasMedia: false });
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("AI for this chat is not ready")
    );
  });

  it("handles image media", async () => {
    const msg = makeMessage({
      hasMedia: true,
      downloadMedia: vi
        .fn()
        .mockResolvedValue({
          mimetype: "image/png",
          data: "base64data",
          filename: "img.png",
        }),
    });
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("AI for this chat is not ready")
    );
  });

  it("handles non-image media", async () => {
    const msg = makeMessage({
      hasMedia: true,
      downloadMedia: vi
        .fn()
        .mockResolvedValue({
          mimetype: "application/pdf",
          data: "base64data",
          filename: "file.pdf",
        }),
    });
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    expect(msg.reply).not.toHaveBeenCalledWith(
      expect.stringContaining("AI for this chat is not ready")
    );
  });

  it("handles error in media download", async () => {
    const msg = makeMessage({
      hasMedia: true,
      downloadMedia: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining("error processing your attachment")
    );
  });

  it("handles missing session details", async () => {
    const msg = makeMessage();
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    await processor.processIncomingMessage(msg, "conn1", { aiInstance });
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining(
        "AI service for this connection is not properly configured"
      )
    );
  });

  it("handles error in AI SDK call", async () => {
    const msg = makeMessage();
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    const { generateText } = await import("ai");
    generateText.mockRejectedValueOnce(new Error("AI fail"));
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    expect(msg.reply).toHaveBeenCalledWith(
      expect.stringContaining("error processing your message")
    );
  });

  it("handles error in reply after AI SDK error", async () => {
    const msg = makeMessage({
      reply: vi.fn().mockRejectedValue(new Error("fail")),
    });
    const aiInstance = {
      google: 1,
      GEMINI_MODEL_NAME: 1,
      botProfileText: 1,
      tools: [],
    };
    const { generateText } = await import("ai");
    generateText.mockRejectedValueOnce(new Error("AI fail"));
    await processor.processIncomingMessage(msg, "conn1", {
      userId: "u",
      botProfileId: "b",
      aiInstance,
    });
    // No throw, just logs
    expect(msg.reply).toHaveBeenCalled();
  });
});
