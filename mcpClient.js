import { experimental_createMCPClient, generateText } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import SystemPrompt from "./models/systemPromptModel.js"; // or fetch via API if not in same process

dotenv.config();
const GEMINI_MODEL_NAME = "gemini-2.5-flash-preview-04-17";

const GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error(
    "GOOGLE_GENERATIVE_AI_API_KEY is not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Initialize MCP client and tools
let clientOne;
let tools;
let google;
let systemPrompt = null;

/**
 * Initialize AI with dynamic system prompt name.
 * @param {string} systemPromptName - The name of the system prompt to use.
 */
export async function initializeAI(systemPromptName) {
  try {
    // Fetch system prompt by name (dynamic)
    const systemPrompt = await SystemPrompt.findOne({ name: systemPromptName });
    if (!systemPrompt || !systemPrompt.mcpServers) {
      throw new Error(
        `No MCP servers configured in system prompt: ${systemPromptName}`
      );
    }

    // Create a client for each enabled MCP server
    const clients = {};
    for (const server of systemPrompt.mcpServers) {
      if (!server.enabled) continue;
      const transport = new Experimental_StdioMCPTransport({
        command: server.command,
        args: server.args,
      });
      clients[server.name] = await experimental_createMCPClient({ transport });
    }

    // Optionally, you can also fetch tools for each client if needed
    // For now, just use the first client for tools (if you want to keep this logic)
    const firstClient = Object.values(clients)[0];
    let tools = {};
    if (firstClient) {
      const toolSet = await firstClient.tools();
      tools = { ...toolSet };
    }

    const google = createGoogleGenerativeAI({
      apiKey: GOOGLE_GENERATIVE_AI_API_KEY,
      model: GEMINI_MODEL_NAME,
    });

    return {
      clients, // { icount: ..., another: ... }
      tools,
      google,
      GEMINI_MODEL_NAME,
      generateText,
    };
  } catch (error) {
    console.error("Failed to initialize AI:", error);
    process.exit(1);
  }
}

// Handle cleanup on server shutdown
process.on("SIGTERM", async () => {
  if (clientOne) {
    await clientOne.close();
  }
  await mongoose.connection.close();
  process.exit(0);
});
