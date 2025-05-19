// __tests__/services/chatService.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"; // Added afterEach
import mongoose from "mongoose";
import chatService from "../../utils/chatService.js";
import { sessions as chatServiceSessions } from "../../utils/sessionService.js";
import { initializeAI } from "../../mcpClient.js";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";
import Chat from "../../models/chatModel.js";
import { generateText } from "ai";

describe("Chat Service (sessionService & messageService)", () => {
  let testUser;
  let testSystemPrompt;
  const sessionIdPrefix = "test-session-";
  let currentSessionId;
  // Store IDs for cleanup
  let testUserId, testSystemPromptId;

  beforeEach(async () => {
    currentSessionId = `${sessionIdPrefix}${Date.now()}-${Math.random()}`;

    testUser = await User.create({
      email: `chatuser-${Date.now()}@example.com`,
      password: "password",
    });
    testUserId = testUser._id;

    testSystemPrompt = await SystemPrompt.create({
      name: `TestPromptForChat-${Date.now()}`,
      identity: "You are a test bot.",
      userId: testUser._id,
    });
    testSystemPromptId = testSystemPrompt._id;

    chatServiceSessions.clear();

    vi.mocked(initializeAI).mockClear();
    vi.mocked(generateText)
      .mockClear()
      .mockResolvedValue({
        text: "Mocked AI response for chat service",
        toolCalls: [],
        usage: { promptTokens: 15, completionTokens: 25 },
      });
  });

  afterEach(async () => {
    // Cleanup data created in beforeEach
    if (testSystemPromptId)
      await SystemPrompt.findByIdAndDelete(testSystemPromptId);
    if (testUserId) await User.findByIdAndDelete(testUserId);
    // Clean up any chats associated with this user or session ID
    if (testUserId) await Chat.deleteMany({ userId: testUserId });
    if (currentSessionId)
      await Chat.deleteMany({ sessionId: currentSessionId });

    testUser = null;
    testSystemPrompt = null;
    testUserId = null;
    testSystemPromptId = null;

    chatServiceSessions.clear();
  });

  describe("initializeSession", () => {
    it("should initialize a new chat session successfully", async () => {
      const result = await chatService.initializeSession(
        currentSessionId,
        testSystemPrompt.name,
        testUser._id
      );
      expect(result.status).toBe("active");
      expect(result.sessionId).toBe(currentSessionId);
      expect(result.systemPromptName).toBe(testSystemPrompt.name);
      expect(initializeAI).toHaveBeenCalledWith(testSystemPrompt.name);

      const sessionState = chatService.getSession(currentSessionId);
      expect(sessionState.status).toBe("active");
      expect(sessionState.userId.toString()).toBe(testUser._id.toString());
    });

    it("should throw error if system prompt is not found", async () => {
      await expect(
        chatService.initializeSession(
          currentSessionId,
          "NonExistentPrompt",
          testUser._id
        )
      ).rejects.toThrow(/not found/);
    });

    it("should throw error if user does not own system prompt", async () => {
      let otherUser, otherUserId;
      try {
        otherUser = await User.create({
          email: `other-${Date.now()}@example.com`,
          password: "password",
        });
        otherUserId = otherUser._id;

        const specificPromptName = `OwnedPrompt-${Date.now()}`;
        const specificPrompt = await SystemPrompt.create({
          name: specificPromptName,
          identity: "test",
          userId: testUser._id, // Owned by testUser
        });

        await expect(
          chatService.initializeSession(
            currentSessionId,
            specificPrompt.name,
            otherUser._id // Attempting to init with otherUser
          )
        ).rejects.toThrow(/Access denied/);

        await SystemPrompt.findByIdAndDelete(specificPrompt._id); // Clean up specific prompt
      } finally {
        if (otherUserId) await User.findByIdAndDelete(otherUserId);
      }
    });

    it("should throw error if session already exists", async () => {
      await chatService.initializeSession(
        currentSessionId,
        testSystemPrompt.name,
        testUser._id
      );
      await expect(
        chatService.initializeSession(
          currentSessionId,
          testSystemPrompt.name,
          testUser._id
        )
      ).rejects.toThrow(/already active/);
    });
  });

  describe("processMessage", () => {
    beforeEach(async () => {
      await chatService.initializeSession(
        currentSessionId,
        testSystemPrompt.name,
        testUser._id
      );
      // Ensure a Chat document exists for the session being processed
      await Chat.create({
        sessionId: currentSessionId,
        systemPromptId: testSystemPrompt._id,
        systemPromptName: testSystemPrompt.name,
        source: "webapp", // Matches what processMessage expects if it's webapp specific
        userId: testUser._id,
        messages: [],
      });
    });

    it("should process a text message and get an AI response", async () => {
      const messageContent = "Hello AI!";
      const response = await chatService.processMessage(
        currentSessionId,
        messageContent,
        testUser._id
      );

      expect(response.text).toBe("Mocked AI response for chat service");
      expect(generateText).toHaveBeenCalled();
      const chatDoc = await Chat.findOne({ sessionId: currentSessionId });
      expect(chatDoc.messages.length).toBe(2);
      expect(chatDoc.messages[0].content).toEqual([
        { type: "text", text: messageContent },
      ]);
      expect(chatDoc.messages[1].role).toBe("assistant");
    });

    it("should process a message with attachments", async () => {
      const attachments = [
        {
          url: "https://example.com/image.png",
          mimeType: "image/png",
          originalName: "image.png",
          size: 12345,
          uploadedAt: new Date().toISOString(),
        },
        {
          url: "https://example.com/doc.pdf",
          mimeType: "application/pdf",
          originalName: "doc.pdf",
          size: 54321,
          uploadedAt: new Date().toISOString(),
        },
      ];
      const messageContent = "Check these files.";
      const response = await chatService.processMessage(
        currentSessionId,
        messageContent,
        testUser._id,
        attachments
      );

      expect(response.text).toBe("Mocked AI response for chat service");
      const chatDoc = await Chat.findOne({ sessionId: currentSessionId });
      const userMessage = chatDoc.messages.find((m) => m.role === "user");
      expect(userMessage.content).toEqual(
        expect.arrayContaining([
          { type: "text", text: messageContent },
          {
            type: "image",
            image: attachments[0].url,
            mimeType: attachments[0].mimeType,
          },
          {
            type: "file",
            data: attachments[1].url,
            mimeType: attachments[1].mimeType,
            filename: attachments[1].originalName,
          },
        ])
      );
      expect(userMessage.attachments.length).toBe(2);
    });

    it("should throw error if session is not found in memory", async () => {
      await expect(
        chatService.processMessage(
          "fake-session-not-in-memory",
          "Hi",
          testUser._id
        )
      ).rejects.toThrow(/Chat session not found/);
    });

    it("should throw error if chat document is not found (consistency issue)", async () => {
      const newSessionIdForThisTest = `new-session-no-db-${Date.now()}`;
      await chatService.initializeSession(
        newSessionIdForThisTest,
        testSystemPrompt.name,
        testUser._id
      );
      // Chat document for "new-session-no-db" is NOT created here.
      await expect(
        chatService.processMessage(newSessionIdForThisTest, "Hi", testUser._id)
      ).rejects.toThrow(/Chat history could not be loaded/);
    });

    it("should correctly format historical messages for AI (text and attachments)", async () => {
      const initialAttachments = [
        {
          url: "https://example.com/history.jpg",
          mimeType: "image/jpeg",
          originalName: "history.jpg",
          size: 1000,
          uploadedAt: new Date().toISOString(),
        },
      ];
      await chatService.processMessage(
        currentSessionId,
        "First message with image",
        testUser._id,
        initialAttachments
      );

      await chatService.processMessage(
        currentSessionId,
        "Second message, text only",
        testUser._id
      );

      expect(vi.mocked(generateText).mock.calls.length).toBe(2);
      const generateTextCallArgs = vi.mocked(generateText).mock.calls[1][0];
      const messagesForAI = generateTextCallArgs.messages;

      expect(messagesForAI.length).toBe(3); // User1, Assistant1, User2
      expect(messagesForAI[0].role).toBe("user");
      expect(messagesForAI[0].content).toEqual(
        expect.arrayContaining([
          { type: "text", text: "First message with image" },
          {
            type: "image",
            image: "https://example.com/history.jpg",
            mimeType: "image/jpeg",
          },
        ])
      );
      expect(messagesForAI[1].role).toBe("assistant");
      expect(messagesForAI[1].content).toEqual([
        // Ensure content is an array of parts
        { type: "text", text: "Mocked AI response for chat service" },
      ]);
      expect(messagesForAI[2].role).toBe("user");
      expect(messagesForAI[2].content).toEqual([
        { type: "text", text: "Second message, text only" },
      ]);
    });
  });

  describe("endSession", () => {
    beforeEach(async () => {
      await chatService.initializeSession(
        currentSessionId,
        testSystemPrompt.name,
        testUser._id
      );
      await Chat.create({
        sessionId: currentSessionId,
        source: "webapp",
        userId: testUser._id,
        systemPromptId: testSystemPrompt._id,
        systemPromptName: testSystemPrompt.name,
        "metadata.isArchived": false,
      });
    });

    it("should end an active session and archive chat", async () => {
      const result = await chatService.endSession(
        currentSessionId,
        testUser._id
      );
      expect(result.status).toBe("ended");
      const sessionState = chatService.getSession(currentSessionId);
      expect(sessionState.status).toBe("not_found"); // Session removed from in-memory map

      const chatDoc = await Chat.findOne({
        sessionId: currentSessionId,
        source: "webapp",
        userId: testUser._id,
      });
      expect(chatDoc.metadata.isArchived).toBe(true);
    });

    it("should throw error if user is not authorized to end session", async () => {
      let otherUser, otherUserId;
      try {
        otherUser = await User.create({
          email: `otherender-${Date.now()}@example.com`,
          password: "password",
        });
        otherUserId = otherUser._id;
        await expect(
          chatService.endSession(currentSessionId, otherUser._id)
        ).rejects.toThrow(/Unauthorized/);
      } finally {
        if (otherUserId) await User.findByIdAndDelete(otherUserId);
      }
    });
  });
});
