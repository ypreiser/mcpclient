import { experimental_createMCPClient, generateText } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import dotenv from "dotenv";
import mongoose from "mongoose"; // Required for SystemPrompt model
import SystemPrompt from "./models/systemPromptModel.js";
import logger from "./utils/logger.js";

dotenv.config();
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME 
if (!GEMINI_MODEL_NAME) {
  logger.error("GEMINI_MODEL_NAME is not set. Please set it in your environment variables.");
}

const GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!GOOGLE_GENERATIVE_AI_API_KEY) {
  logger.error(
    "GOOGLE_GENERATIVE_AI_API_KEY is not set. Please set it in your environment variables."
  );
}

// Store MCP clients globally to manage their lifecycle if needed, though typically managed by consumer.
// This simple example doesn't have a global cleanup for MCP clients from here.
// The consumer (e.g. whatsappService) should manage closing them if they are long-lived.
// For short-lived AI initializations (like in chatRoute), they are created and used per request.

/**
 * Initialize AI with dynamic system prompt name.
 * @param {string} systemPromptName - The name of the system prompt to use.
 */
export async function initializeAI(systemPromptName) {
  if (!GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured.");
  }

  try {
    logger.info(`Initializing AI with system prompt: ${systemPromptName}`);
    const systemPromptDoc = await SystemPrompt.findOne({ name: systemPromptName });
    if (!systemPromptDoc) {
      throw new Error(`System prompt "${systemPromptName}" not found.`);
    }
    if (!systemPromptDoc.mcpServers || systemPromptDoc.mcpServers.length === 0) {
      logger.warn(`No MCP servers configured in system prompt: ${systemPromptName}. Proceeding without MCP clients.`);
      // Fallback: If no MCP servers, tools will be empty.
    }

    const mcpClients = {};
    if (systemPromptDoc.mcpServers && systemPromptDoc.mcpServers.length > 0) {
      for (const server of systemPromptDoc.mcpServers) {
        if (!server.enabled) {
          logger.info(`MCP server '${server.name}' is disabled, skipping.`);
          continue;
        }
        try {
          const transport = new Experimental_StdioMCPTransport({
            command: server.command,
            args: server.args,
          });
          mcpClients[server.name] = await experimental_createMCPClient({ transport });
          logger.info(`MCP client '${server.name}' created successfully.`);
        } catch (mcpError) {
          logger.error({ err: mcpError, serverName: server.name }, `Failed to create MCP client '${server.name}'.`);
          // Decide if this is a fatal error or if the app can run with partial MCP functionality.
          // For now, we'll log and continue, meaning tools from this client won't be available.
        }
      }
    }


    let combinedTools = {};
    for (const clientName in mcpClients) {
        try {
            const client = mcpClients[clientName];
            const toolSet = await client.tools();
            combinedTools = { ...combinedTools, ...toolSet };
            logger.info(`Fetched tools from MCP client '${clientName}'. Tool count: ${Object.keys(toolSet).length}`);
        } catch (toolError) {
            logger.error({ err: toolError, clientName }, `Failed to fetch tools from MCP client '${clientName}'.`);
        }
    }


    const googleAI = createGoogleGenerativeAI({
      apiKey: GOOGLE_GENERATIVE_AI_API_KEY,
      // model: GEMINI_MODEL_NAME, // Model can be specified per generateText call
    });

    logger.info(`AI initialized successfully for system prompt: ${systemPromptName}. Total tools: ${Object.keys(combinedTools).length}`);
    
    return {
      mcpClients, // Object of named MCP clients { icount: client, another: client }
      tools: combinedTools, // Combined tools from all enabled MCP clients
      google: googleAI,
      GEMINI_MODEL_NAME, // Allow model to be specified at generation time if needed
      generateText,
      // Function to close all initialized MCP clients for this instance
      closeMcpClients: async () => {
        for (const clientName in mcpClients) {
          try {
            await mcpClients[clientName].close();
            logger.info(`MCP client '${clientName}' closed.`);
          } catch (closeErr) {
            logger.error({ err: closeErr, clientName }, `Error closing MCP client '${clientName}'.`);
          }
        }
      }
    };
  } catch (error) {
    logger.error({ err: error, systemPromptName }, "Failed to initialize AI:");
    throw error; // Re-throw to be handled by the caller
  }
}

// SIGTERM handling should be in the main server.js or service that *uses* initializeAI.
// If mcpClient.js were a standalone process, it would need its own mongoose connection and SIGTERM.
// Since it's a library, the main application (server.js) handles mongoose connection.
// Consumers of initializeAI (like whatsappService) should use the returned `closeMcpClients`
// function during their own cleanup.