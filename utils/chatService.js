// chatService.js
import { initializeSession, getSession, endSession } from "./sessionService.js";
import { processMessage } from "./messageService.js";

const chatService = {
  initializeSession,
  getSession,
  processMessage,
  endSession,
};

export default chatService;
export { initializeSession, getSession, processMessage, endSession };
