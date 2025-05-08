import { experimental_createMCPClient, generateText } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import readline from "readline/promises";

import dotenv from "dotenv";
dotenv.config();
const GEMINI_MODEL_NAME = "gemini-2.5-flash-preview-04-17";

const GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error(
    "GOOGLE_GENERATIVE_AI_API_KEY is not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const anthropic = createAnthropic({
  apiKey: ANTHROPIC_API_KEY,
});

async function main() {
  let clientOne;
  try {
    // Initialize an MCP client to connect to a `stdio` MCP server:
    const transport = new Experimental_StdioMCPTransport({
      command: "node",
      args: ["C:/mcp/weather/build/icount.js"],
    });
    clientOne = await experimental_createMCPClient({
      transport,
    });

    const toolSetOne = await clientOne.tools();
    const tools = {
      ...toolSetOne,
    };
    const google = createGoogleGenerativeAI({
      apiKey: GOOGLE_GENERATIVE_AI_API_KEY,
      model: GEMINI_MODEL_NAME,
      useSearchGrounding: true,
      useSearch: true,
    });

    // Create readline interface for user input
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("Welcome to the Shop Assistant Chatbot!");
    console.log("Type 'exit' to end the conversation.\n");

    const conversationHistory = [];

    while (true) {
      const userInput = await rl.question("You: ");

      if (userInput.toLowerCase() === "exit") {
        console.log("Goodbye! Have a great day!");
        break;
      }

      // Add user message to conversation history
      conversationHistory.push({
        role: "user",
        content: userInput,
      });

      const response = await generateText({
        // model: google(GEMINI_MODEL_NAME),
        model: anthropic("claude-3-5-sonnet-20240620"),
        tools,
        maxSteps: 10,
        system: `You are a helpful shop assistant chatbot. 
        You help users find products in a store.
        You can use the following tools to help you:
        ${Object.keys(tools)
          .map((tool) => `- ${tool}`)
          .join("\n")}.
          when a client starts a conversation with you, you should first ask for their email or phone number.
          and then use the tools to find the client info.
          if the client is not in the database, you should ask for their name and email and phone number and create a new client.
        `,
        messages: conversationHistory,
      });

      const assistantResponse = response.text;
      console.dir(response, { depth: 10 });

      // Add assistant response to conversation history
      conversationHistory.push({
        role: "assistant",
        content: assistantResponse,
      });

      console.log("\nAssistant:", assistantResponse, "\n");
    }

    rl.close();
  } catch (error) {
    console.error("An error occurred:", error);
  } finally {
    if (clientOne) {
      await clientOne.close();
    }
  }
}

main().catch(console.error);
