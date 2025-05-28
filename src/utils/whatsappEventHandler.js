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
    if (session && session.userId) {
      // Ensure session and userId exist
      session.qr = qr;
      session.status = "qr_ready";
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      // Pass userId to updateConnectionStatus
      connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId, // <<< PASSING CORRECT userId
        "qr_pending_scan",
        false // Auto-reconnect disabled
      );
    } else {
      logger.error(
        {
          connectionName,
          sessionExists: !!session,
          userIdExists: !!session?.userId,
        },
        `EventHandler Critical: Session or session.userId not found in map for 'qr' event on ${connectionName}. Cannot update persistence correctly.`
      );
    }
  }

  onReady(connectionName) {
    logger.info(
      `EventHandler: WhatsApp client is ready for '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);
    if (session && session.userId) {
      // Ensure session and userId exist
      session.status = "connected";
      session.qr = null;
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      const phoneNumber = session.client?.info?.wid?.user || null;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId, // <<< PASSING CORRECT userId
        "connected",
        true,
        phoneNumber
      );
    } else {
      logger.error(
        {
          connectionName,
          sessionExists: !!session,
          userIdExists: !!session?.userId,
        },
        `EventHandler Critical: Session or session.userId not found in map for 'ready' event on ${connectionName}. Cannot update persistence correctly.`
      );
    }
  }

  onAuthenticated(connectionName) {
    logger.info(
      `EventHandler: WhatsApp client authenticated for '${connectionName}'.`
    );
    const session = this.sessions.get(connectionName);
    if (session && session.userId) {
      // Ensure session and userId exist
      session.status = "authenticated";
      session.qr = null;
      session.isReconnecting = false;
      session.reconnectAttempts = 0;
      const phoneNumber = session.client?.info?.wid?.user || null;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId, // <<< PASSING CORRECT userId
        "authenticated",
        true,
        phoneNumber
      );
    } else {
      logger.error(
        {
          connectionName,
          sessionExists: !!session,
          userIdExists: !!session?.userId,
        },
        `EventHandler Critical: Session or session.userId not found in map for 'authenticated' event on ${connectionName}. Cannot update persistence correctly.`
      );
    }
  }

  async onAuthFailure(errorMsg, connectionName) {
    logger.error(
      `EventHandler: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`
    );
    const session = this.sessions.get(connectionName);
    if (session && session.userId) {
      // Ensure session and userId exist
      session.status = "auth_failed";
      session.isReconnecting = false;
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId, // <<< PASSING CORRECT userId
        "auth_failed",
        false
      );
      if (typeof session.closeCallback === "function") {
        await session.closeCallback(true, true);
      }
    } else {
      logger.error(
        {
          connectionName,
          sessionExists: !!session,
          userIdExists: !!session?.userId,
        },
        `EventHandler: Session or session.userId not found during auth_failure for ${connectionName}. Attempting DB update if possible.`
      );
      // If we don't know the userId, we can't scope the DB update properly.
      // This implies a problem with session setup if userId is missing.
      // One option is to find *any* connection with this name and mark it, but that's risky.
      // For now, we'll log the error. The session cleanup itself should handle removing it from the map.
      // If `closeCallback` was called, it would try to update persistence with the details it has.
    }
  }

  async onDisconnected(reason, connectionName) {
    logger.warn(
      `EventHandler: WhatsApp client disconnected for '${connectionName}'. Reason: ${reason}`
    );
    const session = this.sessions.get(connectionName);

    if (
      !session ||
      !session.userId ||
      [
        "closed_manual",
        "closed_forced",
        "auth_failed",
        "disconnected_permanent",
      ].includes(session.status)
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} (User: ${session?.userId}) not found or in terminal state (${session?.status}). No reconnect.`
      );
      return;
    }
    if (
      session.isReconnecting &&
      (session.status === "reconnecting" || session.status === "initializing")
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} (User: ${session.userId}) already in reconnect/init cycle. Ignoring disconnect.`
      );
      return;
    }

    let autoReconnectEnabled = session.autoReconnect;
    if (autoReconnectEnabled === undefined) {
      const dbConn = await connectionPersistence.getByConnectionName(
        connectionName,
        session.userId
      );
      autoReconnectEnabled = dbConn ? dbConn.autoReconnect : false;
      session.autoReconnect = autoReconnectEnabled;
    }

    if (!autoReconnectEnabled) {
      logger.info(
        `EventHandler: Auto-reconnect disabled for ${connectionName} (User: ${session.userId}). Marking as disconnected.`
      );
      session.status = "disconnected";
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId,
        "disconnected",
        false
      );
      if (typeof session.closeCallback === "function")
        await session.closeCallback(true);
      return;
    }

    await connectionPersistence.updateConnectionStatus(
      connectionName,
      session.userId,
      "reconnecting",
      true
    );
    session.status = "reconnecting";
    session.isReconnecting = true;
    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `EventHandler: Max runtime reconnect attempts for ${connectionName} (User: ${session.userId}). Disabling auto-reconnect.`
      );
      session.isReconnecting = false;
      session.status = "disconnected_permanent";
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        session.userId,
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
        logger.error(
          { err: e, connectionName, userId: session.userId },
          `Error destroying client`
        );
      }
      session.client = null;
    }

    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, session.reconnectAttempts - 1),
      60000
    );
    logger.info(
      `EventHandler: Scheduling runtime reconnect for ${connectionName} (User: ${
        session.userId
      }) in ${delay / 1000}s (Attempt ${session.reconnectAttempts}).`
    );

    setTimeout(async () => {
      const currentSession = this.sessions.get(connectionName);
      if (
        !currentSession ||
        !currentSession.isReconnecting ||
        currentSession.userId?.toString() !== session.userId?.toString()
      ) {
        // also check userId match
        logger.info(
          `EventHandler: Runtime reconnect for ${connectionName} (Original User: ${session.userId}) aborted (session changed/removed/flag cleared).`
        );
        return;
      }
      try {
        // initializeSession expects botProfileId, not name.
        await this.initializeSession(
          connectionName,
          currentSession.botProfileId,
          currentSession.userId,
          true
        );
      } catch (error) {
        logger.error(
          { err: error, connectionName, userId: currentSession.userId },
          `EventHandler: Scheduled runtime reconnect failed.`
        );
      }
    }, delay);
  }

  async onMessage(message, connectionName) {
    if (message.fromMe || message.isStatus) return;

    const session = this.sessions.get(connectionName);
    if (
      !session ||
      !session.userId ||
      !["connected", "authenticated"].includes(session.status)
    ) {
      logger.warn(
        `EventHandler: Message for ${connectionName} from ${message.from} but session not ready (Status: ${session?.status}, User: ${session?.userId}). Ignoring.`
      );
      return;
    }
    logger.info(
      `EventHandler: Message received for ${connectionName} (User: ${session.userId}) from ${message.from}`
    );
    await this.messageProcessor.processIncomingMessage(
      message,
      connectionName,
      session
    );
  }
}

export default WhatsAppEventHandler;
