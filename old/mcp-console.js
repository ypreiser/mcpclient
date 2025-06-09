//mcpclient/old/mcp-console.js
import { experimental_createMCPClient, generateText } from "ai";
import { Experimental_StdioMCPTransport } from "ai/mcp-stdio";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import readline from "readline/promises";

import dotenv from "dotenv";
dotenv.config();
const MSSQL_PASSWORD = process.env.MSSQL_PASSWORD;
const MSSQL_SERVER = process.env.MSSQL_SERVER;
const MSSQL_USER = process.env.MSSQL_USER;
const MSSQL_DATABASE = process.env.MSSQL_DATABASE;
const MAIN_COMPANY_ID = process.env.MAIN_COMPANY_ID;

if (
  !MSSQL_PASSWORD ||
  !MSSQL_SERVER ||
  !MSSQL_USER ||
  !MSSQL_DATABASE ||
  !MAIN_COMPANY_ID
) {
  console.error(
    "MSSQL varables are not set. Please set it in your environment variables."
  );
  process.exit(1);
}

const GEMINI_MODEL_NAME = "gemini-2.5-flash-preview-05-20";

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
      // command: "node",
      // args: ["C:/mcp/mcp-server/build/email-final-documents.js"],

      command: "node",
      args: ["C:/ts-sql-mcp-server/dist/server.js"],
      env: {
        MSSQL_SERVER,
        MSSQL_USER,
        MSSQL_PASSWORD,
        MSSQL_DATABASE,
        MAIN_COMPANY_ID,
      },
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

    console.log("Welcome to the DB Assistant Chatbot!");
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
        model: google(GEMINI_MODEL_NAME),
        // model: anthropic("claude-3-5-sonnet-20240620"),
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: 2048,
            },
          },
        },
        tools,
        maxSteps: 10,
        thinking: {
          enabled: true,
        },
        system: `
You are a financial data assistant. You have two types of capabilities: reading data and proposing changes.
Reading Data:
You have access to a set of specialized tools (getSupplierExpenses, getCategoryBreakdown, etc.) and an advanced executeReadOnlyQuery tool.
Your access is restricted to a single user's data. You do not need to specify a company or user ID in your requests; it is handled automatically.
Proposing Changes (CRITICAL):
You CANNOT directly change, update, or delete data.
To make a change, you must call the proposeUpdateCommand tool. This tool will generate a SQL command but will not run it.
After calling the tool, you MUST show the proposedCommand to the human user and ask for their explicit approval (e.g., "Please type 'approve' to run this command").
Example Write Workflow:
User: "Please update the notes on invoice 123 to 'Paid'."
Your Action: Call proposeUpdateCommand with tableName: 'EMAIL_FinalDocuments', primaryKeyColumn: 'DocNumber', primaryKeyValue: '123', and updates: { 'Notes': 'Paid' }.
Your Response to User: "I have prepared the following command to update the record: UPDATE EMAIL_FinalDocuments SET Notes = 'Paid' WHERE DocNumber = '123';. Please reply with 'approve' to execute this change."
        You can use the following tools to help you:
        ${Object.keys(tools)
          .map((tool) => `- ${tool}`)
          .join("\n")}.`,
        messages: conversationHistory,
      });

      const assistantResponse = response.text;
      // console.dir(response, { depth: 10 });

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
