// src\starter.js
//mcpclient/starter.js
import { app, initializeMongoDB, gracefulShutdown } from "./server.js";
import logger from "./utils/logger.js";

async function startServer() {
  try {
    await initializeMongoDB();

    const PORT = process.env.PORT || 3000;

    const server = app.listen(PORT, () => {
      logger.info(
        `Server running on port ${PORT} in ${
          process.env.NODE_ENV || "development"
        } mode`
      );
    });

    // Handle graceful shutdown
    const handleShutdown = (signal) => {
      logger.info(`${signal} received, shutting down...`);
      gracefulShutdown(signal, server);
    };

    // Process-wide event handlers for termination signals
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));

    return server;
  } catch (error) {
    logger.error({ err: error }, "Failed to start server:");
    process.exit(1);
  }
}

// Only start the server if this file is run directly, not when imported as a module
if (import.meta.url === import.meta.url) {
  startServer();
}

export default startServer;
