// src\mcpClient.js
import { experimental_createMCPClient } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import dotenv from "dotenv";
import mongoose from "mongoose";
import BotProfile from "./models/botProfileModel.js";
import { botProfileToNaturalLanguage } from "./utils/json2llm.js"; // Import the converter
import logger from "./utils/logger.js";

dotenv.config();

export async function initializeAI(botProfileId) {
  try {
    // Read env vars inside the function for testability
    const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME;
    const GOOGLE_GENERATIVE_AI_API_KEY =
      process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    logger.info(
      { botProfileId },
      `Initializing AI services for bot profile ID.`
    );
    if (!mongoose.Types.ObjectId.isValid(botProfileId)) {
      logger.error(
        { botProfileId },
        "Provided botProfileId is not a valid MongoDB ObjectId."
      );
      throw new Error(`Invalid botProfileId format: ${botProfileId}`);
    }

    if (!GOOGLE_GENERATIVE_AI_API_KEY) {
      logger.error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");
      throw new Error("Google Generative AI API Key is not configured.");
    }
    if (!GEMINI_MODEL_NAME) {
      logger.error("GEMINI_MODEL_NAME is not set.");
    }

    const botProfileDoc = await BotProfile.findById(botProfileId).lean();
    if (!botProfileDoc) {
      logger.error(
        { botProfileId },
        "Bot profile not found during AI initialization."
      );
      throw new Error(`Bot profile with id '${botProfileId}' not found.`);
    }

    logger.debug(
      {
        botProfileId,
        name: botProfileDoc.name,
        mcpServersCount: botProfileDoc.mcpServers?.length || 0,
      },
      "Loaded bot profile for AI initialization."
    );

    // Generate the system prompt text from the bot profile
    const botProfileText = botProfileToNaturalLanguage(botProfileDoc); // botProfileDoc is already a plain object due to .lean()
    if (!botProfileText || botProfileText.trim() === "") {
      logger.warn(
        { botProfileId, name: botProfileDoc.name },
        "Generated system prompt text is empty. AI will operate without a system instruction."
      );
    } else {
      logger.info(
        {
          botProfileId,
          name: botProfileDoc.name,
          botProfileLength: botProfileText.length,
        },
        "System prompt text generated."
      );
    }

    const mcpClients = {};
    if (botProfileDoc.mcpServers && botProfileDoc.mcpServers.length > 0) {
      for (const serverConfig of botProfileDoc.mcpServers) {
        if (!serverConfig.enabled) {
          logger.info(
            { botProfileId, serverName: serverConfig.name },
            `MCP server '${serverConfig.name}' is disabled, skipping.`
          );
          continue;
        }
        try {
          const transport = new Experimental_StdioMCPTransport({
            command: serverConfig.command,
            args: serverConfig.args || [],
          });
          mcpClients[serverConfig.name] = await experimental_createMCPClient({
            transport,
          });
          logger.info(
            { botProfileId, serverName: serverConfig.name },
            `MCP client '${serverConfig.name}' created successfully.`
          );
        } catch (mcpError) {
          logger.error(
            { err: mcpError, botProfileId, serverName: serverConfig.name },
            `Failed to create MCP client '${serverConfig.name}'.`
          );
        }
      }
    }

    let combinedTools = {};
    for (const clientName in mcpClients) {
      try {
        const client = mcpClients[clientName];
        const toolSet = await client.tools();
        combinedTools = { ...combinedTools, ...toolSet };
        logger.info(
          { botProfileId, clientName, toolCount: Object.keys(toolSet).length },
          `Fetched tools from MCP client '${clientName}'.`
        );
      } catch (toolError) {
        logger.error(
          { err: toolError, botProfileId, clientName },
          `Failed to fetch tools from MCP client '${clientName}'.`
        );
      }
    }

    const google = createGoogleGenerativeAI({
      apiKey: GOOGLE_GENERATIVE_AI_API_KEY,
    });

    logger.info(
      {
        botProfileId,
        name: botProfileDoc.name,
        totalTools: Object.keys(combinedTools).length,
      },
      `AI services initialized successfully for bot profile.`
    );

    return {
      mcpClients,
      tools: combinedTools,
      google,
      GEMINI_MODEL_NAME,
      botProfileText: botProfileText,
      closeMcpClients: async () => {
        // ... (implementation as before)
        logger.info({ botProfileId }, "Closing MCP clients for AI instance.");
        for (const clientName in mcpClients) {
          try {
            if (
              mcpClients[clientName] &&
              typeof mcpClients[clientName].close === "function"
            ) {
              await mcpClients[clientName].close();
              logger.info(
                { botProfileId, clientName },
                `MCP client '${clientName}' closed.`
              );
            }
          } catch (closeErr) {
            logger.error(
              { err: closeErr, botProfileId, clientName },
              `Error closing MCP client '${clientName}'.`
            );
          }
        }
      },
    };
  } catch (error) {
    logger.error(
      { err: error, botProfileId },
      "Critical failure during AI services initialization:"
    );
    throw error;
  }
}
