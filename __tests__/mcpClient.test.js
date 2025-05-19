// __tests__/mcpClient.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeAI } from "../mcpClient.js";

// Mock the modules
vi.mock("../models/systemPromptModel.js", () => ({
  default: {
    findOne: vi.fn(),
  },
}));

vi.mock("ai", () => ({
  experimental_createMCPClient: vi.fn(),
}));

vi.mock("ai/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: vi.fn(),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Import the mocked modules
import SystemPrompt from "../models/systemPromptModel.js";
import { experimental_createMCPClient } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import logger from "../utils/logger.js";

describe("mcpClient - initializeAI", () => {
  const systemPromptName = "TestPromptForMCP";
  const mockSystemPromptDocBase = {
    name: systemPromptName,
    mcpServers: [
      { name: "server1", command: "cmd1", args: ["arg1"], enabled: true },
      { name: "server2", command: "cmd2", args: [], enabled: false }, // Disabled server
      { name: "server3", command: "cmd3", args: ["arg3"], enabled: true },
    ],
  };
  let mockSystemPromptDoc;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSystemPromptDoc = { ...mockSystemPromptDocBase };

    // Reset all mocks
    SystemPrompt.findOne.mockReset();
    experimental_createMCPClient.mockReset();
    Experimental_StdioMCPTransport.mockReset();
    createGoogleGenerativeAI.mockReset();
    logger.info.mockReset();
    logger.error.mockReset();
    logger.warn.mockReset();

    // Default mock implementations
    experimental_createMCPClient.mockImplementation(async ({ transport }) => ({
      tools: async () => ({
        [`tool_from_${transport.serverName}`]: { description: "A tool" },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }));

    Experimental_StdioMCPTransport.mockImplementation(({ command, args }) => {
      const server = mockSystemPromptDocBase.mcpServers.find(
        (s) => s.command === command
      );
      return {
        serverName: server ? server.name : "unknown_server",
      };
    });

    createGoogleGenerativeAI.mockReturnValue({});
  });

  it("should initialize AI successfully with enabled MCP servers and combine tools", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";

    // Execute
    const aiConfig = await initializeAI(systemPromptName);

    // Verify
    expect(SystemPrompt.findOne).toHaveBeenCalledWith({
      name: systemPromptName,
    });
    expect(Experimental_StdioMCPTransport).toHaveBeenCalledTimes(2);
    expect(Experimental_StdioMCPTransport).toHaveBeenCalledWith({
      command: "cmd1",
      args: ["arg1"],
    });
    expect(Experimental_StdioMCPTransport).toHaveBeenCalledWith({
      command: "cmd3",
      args: ["arg3"],
    });
    expect(experimental_createMCPClient).toHaveBeenCalledTimes(2);
    expect(createGoogleGenerativeAI).toHaveBeenCalled();
    expect(aiConfig.mcpClients).toHaveProperty("server1");
    expect(aiConfig.mcpClients).not.toHaveProperty("server2");
    expect(aiConfig.mcpClients).toHaveProperty("server3");
    expect(aiConfig.tools).toHaveProperty("tool_from_server1");
    expect(aiConfig.tools).toHaveProperty("tool_from_server3");
    expect(Object.keys(aiConfig.tools).length).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("MCP client 'server1' created successfully.")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("MCP client 'server3' created successfully.")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("MCP server 'server2' is disabled, skipping.")
    );
  });

  it("should throw error if system prompt not found", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(null);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";

    // Execute & Verify
    await expect(initializeAI(systemPromptName)).rejects.toThrow(
      `System prompt "${systemPromptName}" not found.`
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        systemPromptName,
      }),
      "Failed to initialize AI:"
    );
  });

  it("should proceed without MCP clients if mcpServers is undefined or empty", async () => {
    // Setup
    mockSystemPromptDoc.mcpServers = [];
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";

    // Execute
    const aiConfig = await initializeAI(systemPromptName);

    // Verify
    expect(logger.warn).toHaveBeenCalledWith(
      `No MCP servers configured in system prompt: ${systemPromptName}. Proceeding without MCP clients.`
    );
    expect(Object.keys(aiConfig.mcpClients)).toHaveLength(0);
    expect(Object.keys(aiConfig.tools)).toHaveLength(0);
    expect(experimental_createMCPClient).not.toHaveBeenCalled();
  });

  it("should handle failure in creating an MCP client gracefully and continue with others", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";
    const mcpCreationError = new Error(
      "MCP client creation failed for server1"
    );

    experimental_createMCPClient
      .mockRejectedValueOnce(mcpCreationError)
      .mockImplementationOnce(async ({ transport }) => ({
        tools: async () => ({
          tool_from_server3: { description: "A tool" },
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }));

    // Execute
    const aiConfig = await initializeAI(systemPromptName);

    // Verify
    expect(logger.error).toHaveBeenCalledWith(
      { err: mcpCreationError, serverName: "server1" },
      "Failed to create MCP client 'server1'."
    );
    expect(aiConfig.mcpClients).not.toHaveProperty("server1");
    expect(aiConfig.mcpClients).toHaveProperty("server3");
    expect(aiConfig.tools).not.toHaveProperty("tool_from_server1");
    expect(aiConfig.tools).toHaveProperty("tool_from_server3");
  });

  it("should handle failure in fetching tools from an MCP client gracefully", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";
    const toolFetchingError = new Error("Failed to fetch tools from server1");

    experimental_createMCPClient.mockImplementation(async ({ transport }) => {
      if (transport.serverName === "server1") {
        return {
          tools: async () => {
            throw toolFetchingError;
          },
          close: vi.fn().mockResolvedValue(undefined),
        };
      }
      return {
        tools: async () => ({
          tool_from_server3: { description: "A tool" },
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
    });

    // Execute
    const aiConfig = await initializeAI(systemPromptName);

    // Verify
    expect(logger.error).toHaveBeenCalledWith(
      { err: toolFetchingError, clientName: "server1" },
      "Failed to fetch tools from MCP client 'server1'."
    );
    expect(aiConfig.tools).not.toHaveProperty("tool_from_server1");
    expect(aiConfig.tools).toHaveProperty("tool_from_server3");
  });

  it("should call closeMcpClients on all created MCP clients", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";

    const mockClient1 = {
      tools: async () => ({ t1: {} }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const mockClient3 = {
      tools: async () => ({ t3: {} }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    experimental_createMCPClient
      .mockResolvedValueOnce(mockClient1)
      .mockResolvedValueOnce(mockClient3);

    // Execute
    const aiConfig = await initializeAI(systemPromptName);
    await aiConfig.closeMcpClients();

    // Verify
    expect(mockClient1.close).toHaveBeenCalled();
    expect(mockClient3.close).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("MCP client 'server1' closed.");
    expect(logger.info).toHaveBeenCalledWith("MCP client 'server3' closed.");
  });

  it("should handle errors during closeMcpClients gracefully", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key";
    const closeError = new Error("Close failed");

    const mockClient1 = {
      tools: async () => ({ t1: {} }),
      close: vi.fn().mockRejectedValue(closeError),
    };
    const mockClient3 = {
      tools: async () => ({ t3: {} }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    experimental_createMCPClient
      .mockResolvedValueOnce(mockClient1)
      .mockResolvedValueOnce(mockClient3);

    // Execute
    const aiConfig = await initializeAI(systemPromptName);
    await aiConfig.closeMcpClients();

    // Verify
    expect(mockClient1.close).toHaveBeenCalled();
    expect(mockClient3.close).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { err: closeError, clientName: "server1" },
      "Error closing MCP client 'server1'."
    );
    expect(logger.info).toHaveBeenCalledWith("MCP client 'server3' closed.");
  });

  it("should throw error if GOOGLE_GENERATIVE_AI_API_KEY is not configured", async () => {
    // Setup
    SystemPrompt.findOne.mockResolvedValue(mockSystemPromptDoc);
    const originalApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    // Execute & Verify
    await expect(initializeAI(systemPromptName)).rejects.toThrow(
      "GOOGLE_GENERATIVE_AI_API_KEY is not configured."
    );

    process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalApiKey;
  });
});
