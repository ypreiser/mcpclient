// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true, // Use Jest-like globals (describe, it, expect, etc.)
    environment: "node", // Specify the test environment
    setupFiles: ["./__tests__/setup/setup.js"], // Global setup file (we'll create this)
    coverage: {
      provider: "v8", // or 'istanbul'
      reporter: ["text", "json", "html"],
      exclude: [
        // Files/patterns to exclude from coverage
        "node_modules/",
        "__tests__/",
        "vitest.config.js",
        "coverage/",
        "server.js", // Often, the main server entry point is lightly tested via integration tests
        "models/", // Models are typically tested indirectly via service/route tests
        "utils/logger.js", // Logger is hard to unit test effectively without complexity
      ],
    },
    testTimeout: 15000, // Increase timeout for tests involving DB or server start
    hookTimeout: 15000, // Timeout for beforeAll/afterAll hooks
  },
});
