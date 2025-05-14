// __tests__/setup/setup.js
import { beforeAll, afterAll, afterEach, vi } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import User from "../../models/userModel.js"; // Adjust path as needed
import SystemPrompt from "../../models/systemPromptModel.js"; // Adjust path
import Chat from "../../models/chatModel.js"; // Adjust path
import TokenUsageRecord from "../../models/tokenUsageRecordModel.js"; // Adjust path
// Import other models as you write tests for them

vi.mock("../../utils/logger.js", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => mockLogger, // Support for child loggers
  };
  return {
    default: mockLogger,
  };
});

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  process.env.MONGODB_URI = mongoUri; // Set for the application to use
  process.env.JWT_SECRET = "test-secret"; // Use a fixed secret for tests
  process.env.NODE_ENV = "test";

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }
});

afterEach(async () => {
  // Clean up the database after each test
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
  // Clear all mocks
  vi.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});
