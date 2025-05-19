//mcpclient/mcpClient.js
import { experimental_createMCPClient } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import dotenv from "dotenv";
import SystemPrompt from "./models/systemPromptModel.js";
import logger from "./utils/logger.js";

dotenv.config();

/**
 * Initialize AI with dynamic system prompt name.
 * @param {string} systemPromptName - The name of the system prompt to use.
 */
export async function initializeAI(systemPromptName) {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const error = new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured.");
    logger.error({ err: error, systemPromptName }, "Failed to initialize AI");
    throw error;
  }

  try {
    const systemPromptDoc = await SystemPrompt.findOne({
      name: systemPromptName,
    });

    if (!systemPromptDoc) {
      const error = new Error(`System prompt "${systemPromptName}" not found.`);
      logger.error({ err: error, systemPromptName }, "Failed to initialize AI");
      throw error;
    }

    if (
      !systemPromptDoc.mcpServers ||
      systemPromptDoc.mcpServers.length === 0
    ) {
      logger.warn(
        `No MCP servers configured in system prompt: ${systemPromptName}. Proceeding without MCP clients.`
      );
      return {
        mcpClients: {},
        tools: {},
        google: createGoogleGenerativeAI({
          apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        }),
        closeMcpClients: async () => {},
      };
    }

    const mcpClients = {};
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
        mcpClients[server.name] = await experimental_createMCPClient({
          transport,
        });
        logger.info(`MCP client '${server.name}' created successfully.`);
      } catch (mcpError) {
        logger.error(
          { err: mcpError, serverName: server.name },
          `Failed to create MCP client '${server.name}'.`
        );
      }
    }

    let combinedTools = {};
    for (const clientName in mcpClients) {
      try {
        const client = mcpClients[clientName];
        const toolSet = await client.tools();
        combinedTools = { ...combinedTools, ...toolSet };
        logger.info(
          `Fetched tools from MCP client '${clientName}'. Tool count: ${
            Object.keys(toolSet).length
          }`
        );
      } catch (toolError) {
        logger.error(
          { err: toolError, clientName },
          `Failed to fetch tools from MCP client '${clientName}'.`
        );
      }
    }

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });

    logger.info(
      `AI initialized successfully for system prompt: ${systemPromptName}. Total tools: ${
        Object.keys(combinedTools).length
      }`
    );

    return {
      mcpClients,
      tools: combinedTools,
      google,
      closeMcpClients: async () => {
        for (const clientName in mcpClients) {
          const client = mcpClients[clientName];
          try {
            await client.close();
            logger.info(`MCP client '${clientName}' closed.`);
          } catch (closeError) {
            logger.error(
              { err: closeError, clientName },
              `Error closing MCP client '${clientName}'.`
            );
          }
        }
      },
    };
  } catch (error) {
    logger.error({ err: error, systemPromptName }, "Failed to initialize AI");
    throw error;
  }
}
