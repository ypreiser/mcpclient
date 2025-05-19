// __tests__/services/whatsappMessageProcessor.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"; // Added afterEach
import mongoose from "mongoose";
import WhatsAppMessageProcessor from "../../utils/whatsappMessageProcessor.js";
import { initializeAI } from "../../mcpClient.js";
import { generateText } from "ai";
import { v2 as cloudinaryV2 } from "cloudinary";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";
import Chat from "../../models/chatModel.js";
import TokenUsageRecord from "../../models/tokenUsageRecordModel.js";
import logger from "../../utils/logger.js";

const mockMessageMedia = (data, mimetype, filename) => ({
  data,
  mimetype,
  filename,
  filesize: data ? data.length : 0, // Ensure filesize is present
});

describe("WhatsAppMessageProcessor", () => {
  let processor;
  let testUser;
  let testSystemPrompt;
  let mockAiInstance;
  // Store IDs for cleanup
  let testUserId, testSystemPromptId;

  const connectionName = "test-whatsapp-conn";
  const userNumber = "1234567890";

  beforeEach(async () => {
    const timestamp = Date.now();
    testUser = await User.create({
      email: `whatsappuser-${timestamp}@example.com`,
      password: "password",
    });
    testUserId = testUser._id;

    testSystemPrompt = await SystemPrompt.create({
      name: `WhatsAppTestPrompt-${timestamp}`,
      identity: "You are a WhatsApp test bot.",
      userId: testUser._id,
    });
    testSystemPromptId = testSystemPrompt._id;

    // Ensure initializeAI is properly awaited if it's async,
    // and that it returns the structure expected by the processor
    mockAiInstance = await initializeAI(testSystemPrompt.name); // Assuming initializeAI is async
    processor = new WhatsAppMessageProcessor(mockAiInstance); // Pass the resolved AI instance

    vi.mocked(generateText)
      .mockClear()
      .mockResolvedValue({
        text: "Mocked WhatsApp AI reply",
        usage: { promptTokens: 5, completionTokens: 10 },
      });

    vi.mocked(cloudinaryV2.uploader.upload).mockClear();
  });

  afterEach(async () => {
    // Cleanup data created in beforeEach
    if (testSystemPromptId)
      await SystemPrompt.findByIdAndDelete(testSystemPromptId);
    if (testUserId) await User.findByIdAndDelete(testUserId);
    // Clean up chats and token records associated with this user/connection
    if (testUserId) {
      await Chat.deleteMany({
        userId: testUserId,
        "metadata.connectionName": connectionName,
      });
      await TokenUsageRecord.deleteMany({ userId: testUserId });
    }
    testUser = null;
    testSystemPrompt = null;
    mockAiInstance = null;
    testUserId = null;
    testSystemPromptId = null;
  });

  const mockWhatsAppMessage = (body, hasMedia = false, mediaDetails = null) => {
    const baseMessage = {
      from: `${userNumber}@c.us`,
      to: "server@c.us",
      body: body,
      hasMedia: hasMedia,
      fromMe: false, // Explicitly set for clarity
      getContact: vi.fn().mockResolvedValue({
        name: "WhatsApp Test User",
        pushname: "WUser",
        number: userNumber,
      }),
      reply: vi.fn().mockResolvedValue(true),
      downloadMedia: vi.fn(),
    };
    if (hasMedia && mediaDetails) {
      baseMessage.downloadMedia.mockResolvedValue(
        mockMessageMedia(
          mediaDetails.data,
          mediaDetails.mimetype,
          mediaDetails.filename
        )
      );
    } else if (hasMedia && !mediaDetails) {
      // Simulate download failure or empty media
      baseMessage.downloadMedia.mockResolvedValue(null);
    }
    return baseMessage;
  };

  const sessionDetails = () => ({
    userId: testUser._id,
    systemPromptId: testSystemPrompt._id,
    systemPromptName: testSystemPrompt.name,
    aiInstance: mockAiInstance, // Ensure this is the resolved AI instance
  });

  it("should process a simple text message", async () => {
    const message = mockWhatsAppMessage("Hello WhatsApp bot");
    await processor.processIncomingMessage(
      message,
      connectionName,
      sessionDetails()
    );
    expect(message.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply");
    expect(generateText).toHaveBeenCalled();
    const chatDoc = await Chat.findOne({
      sessionId: userNumber,
      "metadata.connectionName": connectionName,
    });
    expect(chatDoc).not.toBeNull();
    expect(chatDoc.messages.length).toBe(2); // User message + AI response
    expect(chatDoc.messages[0].content).toEqual([
      { type: "text", text: "Hello WhatsApp bot" },
    ]);
  });

  it("should process a message with an image attachment", async () => {
    const imageData = "base64encodedimagedata"; // Dummy base64 data
    const message = mockWhatsAppMessage("Check this image", true, {
      data: imageData,
      mimetype: "image/png",
      filename: "test_image.png",
    });
    // Mock Cloudinary upload for this test
    vi.mocked(cloudinaryV2.uploader.upload).mockResolvedValueOnce({
      secure_url: "https://fake.cloudinary.com/test_image.png",
      public_id: "test_image_id",
      bytes: imageData.length,
      created_at: new Date().toISOString(),
    });

    await processor.processIncomingMessage(
      message,
      connectionName,
      sessionDetails()
    );

    expect(message.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply");
    expect(cloudinaryV2.uploader.upload).toHaveBeenCalled();
    const chatDoc = await Chat.findOne({
      sessionId: userNumber,
      "metadata.connectionName": connectionName,
    });
    expect(chatDoc.messages[0].content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "Check this image" },
        {
          type: "image",
          image: "https://fake.cloudinary.com/test_image.png",
          mimeType: "image/png",
        },
      ])
    );
    expect(chatDoc.messages[0].attachments.length).toBe(1);
    expect(chatDoc.messages[0].attachments[0].url).toBe(
      "https://fake.cloudinary.com/test_image.png"
    );
  });

  it("should process a message with a non-image file attachment", async () => {
    const pdfData = "base64encodedpdfdata";
    const message = mockWhatsAppMessage("Here is the PDF", true, {
      data: pdfData,
      mimetype: "application/pdf",
      filename: "document.pdf",
    });
    vi.mocked(cloudinaryV2.uploader.upload).mockResolvedValueOnce({
      secure_url: "https://fake.cloudinary.com/document.pdf",
      public_id: "document_pdf_id",
      bytes: pdfData.length,
      created_at: new Date().toISOString(),
    });

    await processor.processIncomingMessage(
      message,
      connectionName,
      sessionDetails()
    );
    expect(message.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply");
    expect(cloudinaryV2.uploader.upload).toHaveBeenCalled();
    const chatDoc = await Chat.findOne({
      sessionId: userNumber,
      "metadata.connectionName": connectionName,
    });
    expect(chatDoc.messages[0].content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "Here is the PDF" },
        {
          type: "file",
          data: "https://fake.cloudinary.com/document.pdf",
          mimeType: "application/pdf",
          filename: "document.pdf",
        },
      ])
    );
    expect(chatDoc.messages[0].attachments.length).toBe(1);
  });

  it("should handle media upload failure gracefully (e.g., Cloudinary API error)", async () => {
    const message = mockWhatsAppMessage(
      "This media will fail to upload",
      true,
      { data: "somedata", mimetype: "image/jpeg", filename: "fail.jpg" }
    );
    const simulatedError = new Error("Simulated Cloudinary API upload failed");
    vi.mocked(cloudinaryV2.uploader.upload).mockRejectedValueOnce(
      simulatedError
    );

    await processor.processIncomingMessage(
      message,
      connectionName,
      sessionDetails()
    );

    expect(message.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply"); // AI should still reply based on text
    const chatDoc = await Chat.findOne({
      sessionId: userNumber,
      "metadata.connectionName": connectionName,
    });
    // Check if the text part was modified to include the system note
    const textPart = chatDoc.messages[0].content.find((p) => p.type === "text");
    expect(textPart.text).toContain(
      "This media will fail to upload [System note: Media attachment failed to process and upload.]"
    );
    expect(chatDoc.messages[0].attachments.length).toBe(0); // No attachment saved

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: simulatedError,
        mimetype: "image/jpeg",
        filename: "fail.jpg",
      }),
      "MessageProcessor: Failed to upload media to Cloudinary."
    );
  });

  it("should handle media download failure gracefully", async () => {
    const message = mockWhatsAppMessage(
      "This media will fail to download",
      true
      // No mediaDetails means downloadMedia will return null as per mockWhatsAppMessage setup
    );
    await processor.processIncomingMessage(
      message,
      connectionName,
      sessionDetails()
    );

    expect(message.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply");
    const chatDoc = await Chat.findOne({
      sessionId: userNumber,
      "metadata.connectionName": connectionName,
    });
    const textPart = chatDoc.messages[0].content.find((p) => p.type === "text");
    expect(textPart.text).toContain(
      "This media will fail to download [System note: Media attachment could not be downloaded.]"
    );
    expect(chatDoc.messages[0].attachments.length).toBe(0);

    expect(logger.warn).toHaveBeenCalledWith(
      // Logger receives the string message
      `MessageProcessor: Media download failed or media was empty for ${userNumber} on connection ${connectionName}.`
    );
  });

  it("should use existing chat history for AI context", async () => {
    const firstMessageBody = "First historical message.";
    const firstMessage = mockWhatsAppMessage(firstMessageBody);
    await processor.processIncomingMessage(
      firstMessage,
      connectionName,
      sessionDetails()
    );
    expect(firstMessage.reply).toHaveBeenCalledWith("Mocked WhatsApp AI reply"); // From first call

    vi.mocked(generateText)
      .mockClear()
      .mockResolvedValue({
        text: "AI reply to second message",
        usage: { promptTokens: 20, completionTokens: 30 },
      });
    const secondMessageBody = "Second message following up.";
    const secondMessage = mockWhatsAppMessage(secondMessageBody);
    await processor.processIncomingMessage(
      secondMessage,
      connectionName,
      sessionDetails()
    );

    expect(secondMessage.reply).toHaveBeenCalledWith(
      "AI reply to second message"
    ); // From second call
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1); // Because it was cleared
    const aiCallArgs = vi.mocked(generateText).mock.calls[0][0];

    // History should include:
    // 1. User: "First historical message."
    // 2. Assistant: "Mocked WhatsApp AI reply"
    // 3. User: "Second message following up."
    expect(aiCallArgs.messages.length).toBe(3);
    expect(aiCallArgs.messages[0].content).toEqual([
      { type: "text", text: firstMessageBody },
    ]);
    expect(aiCallArgs.messages[1].role).toBe("assistant");
    expect(aiCallArgs.messages[1].content).toEqual([
      { type: "text", text: "Mocked WhatsApp AI reply" },
    ]); // normalizeDBMessage... will wrap string
    expect(aiCallArgs.messages[2].content).toEqual([
      { type: "text", text: secondMessageBody },
    ]);
  });

  it("should reply with error if session details are incomplete", async () => {
    const message = mockWhatsAppMessage("Test");
    const incompleteSessionDetails = {
      // Missing userId
      systemPromptId: testSystemPrompt._id,
      systemPromptName: testSystemPrompt.name,
      aiInstance: mockAiInstance,
      userId: null, // Explicitly null
    };

    await processor.processIncomingMessage(
      message,
      connectionName,
      incompleteSessionDetails
    );

    expect(message.reply).toHaveBeenCalledWith(
      "Sorry, the AI service for this connection is not properly configured. Please contact support."
    );
    expect(logger.error).toHaveBeenCalledWith(
      // Logger receives the string message
      `MessageProcessor: Critical session details missing for ${connectionName}. User: null, PromptID: ${testSystemPrompt._id.toString()}, AI: true`
    );
  });
});
