// src\utils\whatsappEventHandler.js
import logger from "../utils/logger.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";

const MAX_RECONNECT_ATTEMPTS = parseInt(
  process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS || "5"
);
const RECONNECT_INITIAL_DELAY_MS = parseInt(
  process.env.WHATSAPP_RECONNECT_DELAY_MS || "5000"
);

class WhatsAppEventHandler {
  constructor(sessionsMap, messageProcessor, initializeSessionFn) {
    this.sessions = sessionsMap;
    this.messageProcessor = messageProcessor;
    this.initializeSession = initializeSessionFn;
  }

  registerEventHandlers(client, connectionName) {
    client.on("qr", (qr) => this.onQR(qr, connectionName));
    client.on("ready", () => this.onReady(connectionName));
    client.on("authenticated", () => this.onAuthenticated(connectionName));
    client.on("auth_failure", (msg) => this.onAuthFailure(msg, connectionName));
    client.on("disconnected", (reason) =>
      this.onDisconnected(reason, connectionName)
    );
    client.on("message", (message) => this.onMessage(message, connectionName));
    client.on("change_state", (state) =>
      logger.info(
        `EventHandler: WhatsApp client state change for '${connectionName}': ${state}`
      )
    );
    client.on("error", (error) =>
      logger.error(
        { err: error, connectionName },
        `EventHandler: WhatsApp client error for '${connectionName}'.`
      )
    );
  }

  onQR(qr, connectionName) {
    logger.info(
      `EventHandler: QR Code received for '${connectionName}'. Scan required.`
    );
    const session = this.sessions.get(connectionName);
    if (session) {
      session.qr = qr;
      session.status = "qr_ready";
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "qr_pending_scan",
        false
      ); // Auto-reconnect disabled
    } else
      logger.error(
        `CRITICAL: Session '${connectionName}' not found in map for 'qr' event.`
      );
  }

  onReady(connectionName) {
    // Or 'connected' depending on wwebjs version for full operational readiness
    logger.info(
      `EventHandler: WhatsApp client is ready for '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);
    if (session) {
      session.status = "connected"; // Or "authenticated" if that's the more stable state post-ready
      session.qr = null;
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      const phoneNumber = session.client?.info?.wid?.user || null;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "connected",
        true,
        phoneNumber
      );
    }
  }

  onAuthenticated(connectionName) {
    logger.info(
      `EventHandler: WhatsApp client authenticated for '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);
    if (session) {
      session.status = "authenticated";
      session.qr = null;
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      const phoneNumber = session.client?.info?.wid?.user || null;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "authenticated",
        true,
        phoneNumber
      );
    }
  }

  async onAuthFailure(errorMsg, connectionName) {
    logger.error(
      `EventHandler: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`
    );
    const session = this.sessions.get(connectionName);
    if (session) {
      session.status = "auth_failed";
      session.isReconnecting = false;
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "auth_failed",
        false
      );
      if (typeof session.closeCallback === "function") {
        await session.closeCallback(true, true); // forceClose, authFailure
      }
    } else {
      // If session doesn't exist in map, update DB directly
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "auth_failed",
        false
      );
    }
  }

  async onDisconnected(reason, connectionName) {
    logger.warn(
      `EventHandler: WhatsApp client disconnected for '${connectionName}'. Reason: ${reason}`
    );
    const session = this.sessions.get(connectionName);

    if (
      !session ||
      [
        "closed_manual",
        "closed_forced",
        "auth_failed",
        "disconnected_permanent",
      ].includes(session.status)
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} not found or in terminal state (${session?.status}). No reconnect.`
      );
      return;
    }
    if (
      session.isReconnecting &&
      (session.status === "reconnecting" || session.status === "initializing")
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} already in reconnect/init cycle. Ignoring disconnect.`
      );
      return;
    }

    // Check DB for autoReconnect flag if session doesn't have it (e.g., fresh start)
    let autoReconnectEnabled = session.autoReconnect;
    if (autoReconnectEnabled === undefined) {
      const dbConn = await connectionPersistence.getByConnectionName(
        connectionName
      );
      autoReconnectEnabled = dbConn ? dbConn.autoReconnect : false; // Default to false if not found
      if (session) session.autoReconnect = autoReconnectEnabled; // Cache it
    }

    if (!autoReconnectEnabled) {
      logger.info(
        `EventHandler: Auto-reconnect disabled for ${connectionName}. Marking as disconnected.`
      );
      session.status = "disconnected";
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "disconnected",
        false
      );
      if (typeof session.closeCallback === "function")
        await session.closeCallback(true); // Force close
      return;
    }

    await connectionPersistence.updateConnectionStatus(
      connectionName,
      "reconnecting",
      true
    );
    session.status = "reconnecting";
    session.isReconnecting = true;
    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `EventHandler: Max runtime reconnect attempts for ${connectionName}. Disabling auto-reconnect.`
      );
      session.isReconnecting = false;
      session.status = "disconnected_permanent";
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "disconnected_permanent",
        false
      );
      if (typeof session.closeCallback === "function")
        await session.closeCallback(true);
      return;
    }

    if (session.client) {
      try {
        await session.client.destroy();
      } catch (e) {
        logger.error({ err: e }, `Error destroying client ${connectionName}`);
      }
      session.client = null;
    }

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, session.reconnectAttempts - 1),
      60000
    ); // Exponential backoff up to 1 min
    logger.info(
      `EventHandler: Scheduling runtime reconnect for ${connectionName} in ${
        delay / 1000
      }s (Attempt ${session.reconnectAttempts}).`
    );

    setTimeout(async () => {
      const currentSession = this.sessions.get(connectionName);
      if (!currentSession || !currentSession.isReconnecting) {
        logger.info(
          `EventHandler: Runtime reconnect for ${connectionName} aborted.`
        );
        return;
      }
      try {
        await this.initializeSession(
          connectionName,
          currentSession.botProfileId,
          currentSession.userId,
          true
        );
      } catch (error) {
        logger.error(
          { err: error },
          `EventHandler: Scheduled runtime reconnect for ${connectionName} failed.`
        );
        // Disconnected event will fire again if init fails, leading to next attempt or max out
      }
    }, delay);
  }

  async onMessage(message, connectionName) {
    if (message.fromMe || message.isStatus) return; // isStatus for wwebjs v1.23+

    const session = this.sessions.get(connectionName);
    if (!session || !["connected", "authenticated"].includes(session.status)) {
      logger.warn(
        `EventHandler: Message for ${connectionName} from ${message.from} but session not ready (Status: ${session?.status}).`
      );
      return;
    }
    logger.info(
      `EventHandler: Message received for ${connectionName} from ${message.from}`
    );
    // Pass the full session entry which includes aiInstance, botProfileId, userId, etc.
    await this.messageProcessor.processIncomingMessage(
      message,
      connectionName,
      session
    );
  }
}

export default WhatsAppEventHandler;
