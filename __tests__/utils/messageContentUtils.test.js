import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";

// Mock logger.warn globally (Vitest ESM style)
vi.mock("../../src/utils/logger.js", () => ({
  default: { warn: vi.fn() },
}));

let logger;
let normalizeDbMessageContentForAI;
beforeAll(async () => {
  logger = (await import("../../src/utils/logger.js")).default;
  normalizeDbMessageContentForAI = (
    await import("../../src/utils/messageContentUtils.js")
  ).normalizeDbMessageContentForAI;
});

describe("normalizeDbMessageContentForAI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unavailable for null dbMessage", () => {
    expect(normalizeDbMessageContentForAI(null)).toEqual([
      { type: "text", text: "[System: Message content unavailable]" },
    ]);
  });

  it("returns unavailable for undefined dbMessage", () => {
    expect(normalizeDbMessageContentForAI(undefined)).toEqual([
      { type: "text", text: "[System: Message content unavailable]" },
    ]);
  });

  it("returns unavailable for dbMessage.content null", () => {
    expect(normalizeDbMessageContentForAI({ content: null })).toEqual([
      { type: "text", text: "[System: Message content unavailable]" },
    ]);
  });

  it("returns unavailable for dbMessage.content undefined", () => {
    expect(normalizeDbMessageContentForAI({})).toEqual([
      { type: "text", text: "[System: Message content unavailable]" },
    ]);
  });

  it("returns empty for dbMessage.content as empty string", () => {
    expect(normalizeDbMessageContentForAI({ content: "" })).toEqual([
      { type: "text", text: "[System: Message content empty]" },
    ]);
  });

  it("returns trimmed text for dbMessage.content as string", () => {
    expect(
      normalizeDbMessageContentForAI({ content: "  hello world  " })
    ).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("returns valid text part from array", () => {
    expect(
      normalizeDbMessageContentForAI({
        content: [{ type: "text", text: "hi" }],
      })
    ).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns valid image part from array", () => {
    expect(
      normalizeDbMessageContentForAI({
        content: [
          {
            type: "image",
            image: "https://example.com/img.png",
            mimeType: "image/png",
          },
        ],
      })
    ).toEqual([
      {
        type: "image",
        image: "https://example.com/img.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("returns valid file part from array", () => {
    expect(
      normalizeDbMessageContentForAI({
        content: [
          {
            type: "file",
            data: "https://example.com/file.pdf",
            mimeType: "application/pdf",
            filename: "file.pdf",
          },
        ],
      })
    ).toEqual([
      {
        type: "file",
        data: "https://example.com/file.pdf",
        mimeType: "application/pdf",
        filename: "file.pdf",
      },
    ]);
  });

  it("skips invalid image part (bad URL)", () => {
    const result = normalizeDbMessageContentForAI({
      content: [{ type: "image", image: "not-a-url", mimeType: "image/png" }],
    });
    expect(result).toEqual([
      {
        type: "text",
        text: "[System: Message content unprocessable or empty after normalization]",
      },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips invalid file part (bad URL)", () => {
    const result = normalizeDbMessageContentForAI({
      content: [
        {
          type: "file",
          data: "not-a-url",
          mimeType: "application/pdf",
          filename: "file.pdf",
        },
      ],
    });
    expect(result).toEqual([
      {
        type: "text",
        text: "[System: Message content unprocessable or empty after normalization]",
      },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips invalid image part (missing mimeType)", () => {
    const result = normalizeDbMessageContentForAI({
      content: [{ type: "image", image: "https://example.com/img.png" }],
    });
    expect(result).toEqual([
      {
        type: "text",
        text: "[System: Message content unprocessable or empty after normalization]",
      },
    ]);
  });

  it("skips invalid file part (missing filename)", () => {
    const result = normalizeDbMessageContentForAI({
      content: [
        {
          type: "file",
          data: "https://example.com/file.pdf",
          mimeType: "application/pdf",
        },
      ],
    });
    expect(result).toEqual([
      {
        type: "text",
        text: "[System: Message content unprocessable or empty after normalization]",
      },
    ]);
  });

  it("returns only valid parts in a mixture", () => {
    const result = normalizeDbMessageContentForAI({
      content: [
        { type: "text", text: "hi" },
        {
          type: "image",
          image: "https://example.com/img.png",
          mimeType: "image/png",
        },
        {
          type: "file",
          data: "https://example.com/file.pdf",
          mimeType: "application/pdf",
          filename: "file.pdf",
        },
        { type: "image", image: "bad-url", mimeType: "image/png" },
        {
          type: "file",
          data: "bad-url",
          mimeType: "application/pdf",
          filename: "file.pdf",
        },
        {
          type: "file",
          data: "https://example.com/file2.pdf",
          mimeType: "application/pdf",
        },
      ],
    });
    expect(result).toEqual([
      { type: "text", text: "hi" },
      {
        type: "image",
        image: "https://example.com/img.png",
        mimeType: "image/png",
      },
      {
        type: "file",
        data: "https://example.com/file.pdf",
        mimeType: "application/pdf",
        filename: "file.pdf",
      },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns unprocessable for array with no valid parts", () => {
    const result = normalizeDbMessageContentForAI({
      content: [{ type: "image", image: "bad-url", mimeType: "image/png" }],
    });
    expect(result).toEqual([
      {
        type: "text",
        text: "[System: Message content unprocessable or empty after normalization]",
      },
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns unexpected format for non-string, non-array content", () => {
    expect(normalizeDbMessageContentForAI({ content: 123 })).toEqual([
      { type: "text", text: "[System: Message content in unexpected format]" },
    ]);
  });
});
