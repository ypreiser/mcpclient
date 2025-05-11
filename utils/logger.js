import pino from "pino";

const logLevel = process.env.LOG_LEVEL || "info";
const isProduction = process.env.NODE_ENV === 'production';

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

const logger = pino(loggerOptions);

export default logger;