//mcpclient/__tests__/setup/setup.js
process.env.NODE_ENV = "test"; // Set this first before any imports

import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import User from "../../models/userModel.js";
import SystemPrompt from "../../models/systemPromptModel.js";
import Chat from "../../models/chatModel.js";
import TokenUsageRecord from "../../models/tokenUsageRecordModel.js";
import WhatsAppConnection from "../../models/whatsAppConnectionModel.js";

// --- Mock Logger ---
vi.mock("../../utils/logger.js", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => mockLogger,
  };
  return {
    default: mockLogger,
  };
});

// --- Mock Vercel AI SDK ('ai' package) ---
const mockGenerateTextFn = vi.fn().mockResolvedValue({
  text: "Mocked AI response from 'ai' SDK",
  toolCalls: [],
  finishReason: "stop",
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateText: mockGenerateTextFn,
  };
});

// --- Mock Vercel AI SDK Google Provider ('@ai-sdk/google') ---
const mockGoogleProvider = vi.fn((modelName) => ({
  provider: "google",
  modelId: modelName,
}));
vi.mock("@ai-sdk/google", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    google: mockGoogleProvider,
  };
});

// --- Mock Cloudinary ---
const mockCloudinaryConfig = {
  // Store the mock config
  cloud_name: "test-cloud-from-mock",
  api_key: "test-api-key",
  api_secret: "test-api-secret",
  secure: true,
};
vi.mock("cloudinary", () => {
  const mockActualCloudinary = {
    v2: {
      config: vi.fn(() => mockActualCloudinary.v2._config), // Return the stored config
      _config: mockCloudinaryConfig, // Store the actual config object
      uploader: {
        upload: vi.fn().mockImplementation((dataUri, options) => {
          const public_id = `test_public_id_${Date.now()}`;
          return Promise.resolve({
            public_id: public_id,
            version: 12345,
            signature: "test_signature",
            width: 100,
            height: 100,
            format: "png",
            resource_type: options.resource_type || "image",
            created_at: new Date().toISOString(),
            tags: [],
            bytes: dataUri?.length || 1000,
            type: "upload",
            etag: "test_etag",
            placeholder: false,
            url: `http://res.cloudinary.com/${mockActualCloudinary.v2._config.cloud_name}/image/upload/v12345/${public_id}.png`,
            secure_url: `https://res.cloudinary.com/${mockActualCloudinary.v2._config.cloud_name}/image/upload/v12345/${public_id}.png`,
            original_filename: options.public_id || "test_file",
          });
        }),
      },
      url: vi.fn(
        (publicId, options) =>
          `https://res.cloudinary.com/${mockActualCloudinary.v2._config.cloud_name}/image/upload/${publicId}`
      ),
    },
  };
  return mockActualCloudinary; // Return the structured mock
});

// --- Mock MCP Client (mcpClient.js) ---
vi.mock("../../mcpClient.js", () => {
  return {
    initializeAI: vi.fn().mockResolvedValue({
      google: mockGoogleProvider,
      GEMINI_MODEL_NAME: "gemini-1.5-flash-TEST",
      tools: [],
      systemPromptText: "Mocked System Prompt Text from mcpClient",
      generateText: mockGenerateTextFn,
      closeMcpClients: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  process.env.MONGODB_URI = mongoUri;
  process.env.JWT_SECRET = "test-jwt-secret";
  process.env.NODE_ENV = "test";
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-api-key-for-ai-sdk";

  // Set these for Cloudinary to be "configured" according to whatsappMessageProcessor's check
  process.env.CLOUDINARY_CLOUD_NAME = mockCloudinaryConfig.cloud_name;
  process.env.CLOUDINARY_API_KEY = mockCloudinaryConfig.api_key;
  process.env.CLOUDINARY_API_SECRET = mockCloudinaryConfig.api_secret;

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }
});

afterEach(async () => {
  // MODIFICATION: Removed database clearing from global afterEach.
  // Each test file should be responsible for cleaning up its own data.
  // const collections = mongoose.connection.collections;
  // for (const key in collections) {
  //   const collection = collections[key];
  //   await collection.deleteMany({});
  // }
  vi.clearAllMocks(); // Mock clearing is still good practice.
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});
