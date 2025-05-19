//mcpclient/utils/logger.js
import fs from "fs";
fs.writeFileSync("full.log", "test");
import pino from "pino";
import path from "path";

const logLevel = process.env.LOG_LEVEL || "info";
const isProduction = process.env.NODE_ENV === "production";

const loggerOptions = {
  level: logLevel,
  // base: { pid: process.pid }, // Add pid for better correlation if needed
  timestamp: pino.stdTimeFunctions.isoTime, // Use ISO time format (recommended)
};

// In production, remove the pretty transport and let Pino output raw JSON
if (!isProduction) {
  loggerOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard", // Or use 'isoTime' here too
      ignore: "pid,hostname", // Hide pid and hostname for console readability
    },
  };
}
// In production (isProduction is true), the default Pino output (JSON to stdout/stderr) is used.

// Always log to a file in addition to console
const logFilePath = path.join(process.cwd(), "full.log");

if (!loggerOptions.transport) {
  loggerOptions.transport = {};
}
loggerOptions.transport.targets = [
  // Console (pretty in dev, raw in prod)
  loggerOptions.transport?.target
    ? {
        target: loggerOptions.transport.target,
        options: loggerOptions.transport.options,
        level: logLevel,
      }
    : {
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level: logLevel,
      },
  // File
  {
    target: "pino/file",
    options: { destination: logFilePath, mkdir: true },
    level: logLevel,
  },
];

delete loggerOptions.transport.target;
delete loggerOptions.transport.options;

const logger = pino(loggerOptions);

export default logger;
