// __tests__/mcpClient.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import mongoose from "mongoose";
import { initializeAI } from "../src/mcpClient.js"; // Adjust path if necessary
import BotProfile from "../src/models/botProfileModel.js"; // Adjust path if necessary
import logger from "../src/utils/logger.js"; // Mocked in global setup

// Mock external dependencies precisely
vi.mock("../src/utils/json2llm.js", () => ({
  botProfileToNaturalLanguage: vi.fn(),
}));

// It's often cleaner to mock the entire module and then selectively provide implementations
// or track calls on the mocked functions.
vi.mock("ai", async (importOriginal) => {
  const originalModule = await importOriginal();
  return {
    ...originalModule, // Spread original exports if some are not mocked and needed
    experimental_createMCPClient: vi.fn(),
  };
});

vi.mock("ai/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: vi.fn(() => ({})), // Mock constructor to return a dummy object
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

describe("initializeAI", () => {
  const mockBotProfileId = new mongoose.Types.ObjectId().toString();
  const mockBotProfileData = {
    // Use a consistent data object
    _id: mockBotProfileId,
    name: "Test Bot Profile",
    identity: "Test Identity",
    mcpServers: [
      { name: "server1", command: "cmd1", args: ["arg1"], enabled: true },
      { name: "server2", command: "cmd2", enabled: false },
      { name: "server3", command: "cmd3", enabled: true },
    ],
    // No toObject needed here as .lean() is mocked to return this plain object
  };
  const mockSystemPrompt = "This is a mock system prompt.";
  const mockGoogleProvider = { model: vi.fn() }; // A simple mock for the provider

  let originalGeminiModelName;
  let originalApiKey;

  // Dynamically imported mocks to be used within tests/setup
  let botProfileToNaturalLanguageMock;
  let experimental_createMCPClientMock;
  let Experimental_StdioMCPTransportMock; // Though its constructor is mocked
  let createGoogleGenerativeAIMock;

  beforeEach(async () => {
    // Store original env vars
    originalGeminiModelName = process.env.GEMINI_MODEL_NAME;
    originalApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    // Set default env vars for most tests
    process.env.GEMINI_MODEL_NAME = "gemini-pro-test";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-gai-key";

    // Import mocked functions to interact with them
    const json2llmMockModule = await import("../src/utils/json2llm.js");
    botProfileToNaturalLanguageMock =
      json2llmMockModule.botProfileToNaturalLanguage;

    const aiMockModule = await import("ai");
    experimental_createMCPClientMock =
      aiMockModule.experimental_createMCPClient;

    const aiSdkGoogleMockModule = await import("@ai-sdk/google");
    createGoogleGenerativeAIMock =
      aiSdkGoogleMockModule.createGoogleGenerativeAI;

    // Setup default mock behaviors
    vi.spyOn(BotProfile, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(mockBotProfileData),
    });
    botProfileToNaturalLanguageMock.mockReturnValue(mockSystemPrompt);
    createGoogleGenerativeAIMock.mockReturnValue(mockGoogleProvider);

    // Reset and re-spy on logger methods (as clearAllMocks is in global afterEach)
    // If not using global clearAllMocks, you might clear specific mocks here.
    // For this example, assuming global setup handles clearing, so we just ensure spies are fresh.
    vi.spyOn(logger, "info");
    vi.spyOn(logger, "warn");
    vi.spyOn(logger, "error");
    vi.spyOn(logger, "debug");
  });

  afterEach(() => {
    // Restore original env vars
    process.env.GEMINI_MODEL_NAME = originalGeminiModelName;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalApiKey;
    vi.restoreAllMocks(); // Restore all mocks to their original state
  });

  it("should initialize AI services successfully with enabled MCP servers", async () => {
    const mockMcpClient1 = {
      tools: vi.fn().mockResolvedValue({ toolA: "defA" }),
      close: vi.fn(),
    };
    const mockMcpClient3 = {
      tools: vi.fn().mockResolvedValue({ toolC: "defC" }),
      close: vi.fn(),
    };
    experimental_createMCPClientMock
      .mockResolvedValueOnce(mockMcpClient1)
      .mockResolvedValueOnce(mockMcpClient3);

    const aiInstance = await initializeAI(mockBotProfileId);

    expect(BotProfile.findById).toHaveBeenCalledWith(mockBotProfileId);
    expect(botProfileToNaturalLanguageMock).toHaveBeenCalledWith(
      mockBotProfileData
    );
    expect(experimental_createMCPClientMock).toHaveBeenCalledTimes(2);
    expect(mockMcpClient1.tools).toHaveBeenCalled();
    expect(mockMcpClient3.tools).toHaveBeenCalled();
    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({
      apiKey: "test-gai-key",
    });

    expect(aiInstance.mcpClients.server1).toBe(mockMcpClient1);
    expect(aiInstance.tools).toEqual({ toolA: "defA", toolC: "defC" });
    expect(aiInstance.botProfileText).toBe(mockSystemPrompt);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ botProfileId: mockBotProfileId }),
      "Initializing AI services for bot profile ID."
    );
  });

  it("should throw an error if botProfileId is invalid", async () => {
    const invalidId = "invalid-id";
    await expect(initializeAI(invalidId)).rejects.toThrow(
      `Invalid botProfileId format: ${invalidId}`
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ botProfileId: invalidId }),
      "Provided botProfileId is not a valid MongoDB ObjectId."
    );
  });

  it("should throw an error if BotProfile is not found", async () => {
    vi.spyOn(BotProfile, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    await expect(initializeAI(mockBotProfileId)).rejects.toThrow(
      `Bot profile with id '${mockBotProfileId}' not found.`
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ botProfileId: mockBotProfileId }),
      "Bot profile not found during AI initialization."
    );
  });

  it("should warn if generated system prompt text is empty", async () => {
    botProfileToNaturalLanguageMock.mockReturnValue("");

    await initializeAI(mockBotProfileId);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botProfileId: mockBotProfileId,
        name: mockBotProfileData.name,
      }),
      "Generated system prompt text is empty. AI will operate without a system instruction."
    );
  });

  it("should handle error when creating an MCP client and log it", async () => {
    experimental_createMCPClientMock
      .mockRejectedValueOnce(new Error("MCP creation failed for server1"))
      .mockResolvedValueOnce({
        tools: vi.fn().mockResolvedValue({ toolC: "defC" }),
        close: vi.fn(),
      }); // Mock for server3

    const aiInstance = await initializeAI(mockBotProfileId);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        botProfileId: mockBotProfileId,
        serverName: "server1",
      }),
      "Failed to create MCP client 'server1'."
    );
    expect(aiInstance.mcpClients).not.toHaveProperty("server1");
    expect(aiInstance.tools).toEqual({ toolC: "defC" });
  });

  it("should handle error when fetching tools from an MCP client", async () => {
    const mockMcpClient1Error = {
      tools: vi.fn().mockRejectedValue(new Error("Tool fetch failed")),
      close: vi.fn(),
    };
    const mockMcpClient3Good = {
      tools: vi.fn().mockResolvedValue({ toolC: "defC" }),
      close: vi.fn(),
    };
    experimental_createMCPClientMock
      .mockResolvedValueOnce(mockMcpClient1Error)
      .mockResolvedValueOnce(mockMcpClient3Good);

    const aiInstance = await initializeAI(mockBotProfileId);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        botProfileId: mockBotProfileId,
        clientName: "server1",
      }),
      "Failed to fetch tools from MCP client 'server1'."
    );
    expect(aiInstance.tools).toEqual({ toolC: "defC" });
  });

  it("should call close on all successfully created MCP clients via closeMcpClients", async () => {
    const mockMcpClient1 = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockMcpClient3 = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    experimental_createMCPClientMock
      .mockResolvedValueOnce(mockMcpClient1)
      .mockResolvedValueOnce(mockMcpClient3);

    const aiInstance = await initializeAI(mockBotProfileId);
    await aiInstance.closeMcpClients();

    expect(mockMcpClient1.close).toHaveBeenCalledTimes(1);
    expect(mockMcpClient3.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ clientName: "server1" }),
      "MCP client 'server1' closed."
    );
  });

  it("should handle error when closing an MCP client", async () => {
    const mockMcpClient1 = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockRejectedValue(new Error("Close failed")),
    };
    const mockMcpClient3 = {
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    };
    experimental_createMCPClientMock
      .mockResolvedValueOnce(mockMcpClient1)
      .mockResolvedValueOnce(mockMcpClient3);

    const aiInstance = await initializeAI(mockBotProfileId);
    await aiInstance.closeMcpClients();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        clientName: "server1",
      }),
      "Error closing MCP client 'server1'."
    );
    expect(mockMcpClient3.close).toHaveBeenCalledTimes(1);
  });

  it("should throw error if GOOGLE_GENERATIVE_AI_API_KEY is missing", async () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    await expect(initializeAI(mockBotProfileId)).rejects.toThrow(
      "Google Generative AI API Key is not configured."
    );
    expect(logger.error).toHaveBeenCalledWith(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set."
    );
  });

  it("should log error if GEMINI_MODEL_NAME is not set but still proceed", async () => {
    delete process.env.GEMINI_MODEL_NAME;
    await initializeAI(mockBotProfileId); // Should still complete
    expect(logger.error).toHaveBeenCalledWith("GEMINI_MODEL_NAME is not set.");
  });

  it("should handle a BotProfile with no MCP servers defined", async () => {
    const profileNoServers = { ...mockBotProfileData, mcpServers: undefined };
    vi.spyOn(BotProfile, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(profileNoServers),
    });

    const aiInstance = await initializeAI(mockBotProfileId);
    expect(experimental_createMCPClientMock).not.toHaveBeenCalled();
    expect(aiInstance.mcpClients).toEqual({});
    expect(aiInstance.tools).toEqual({});
  });

  it("should handle a BotProfile with an empty mcpServers array", async () => {
    const profileEmptyServers = { ...mockBotProfileData, mcpServers: [] };
    vi.spyOn(BotProfile, "findById").mockReturnValue({
      lean: vi.fn().mockResolvedValue(profileEmptyServers),
    });

    const aiInstance = await initializeAI(mockBotProfileId);
    expect(experimental_createMCPClientMock).not.toHaveBeenCalled();
    expect(aiInstance.mcpClients).toEqual({});
    expect(aiInstance.tools).toEqual({});
  });
});
