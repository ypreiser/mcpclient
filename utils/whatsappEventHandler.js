//mcpclient/utils/whatsappEventHandler.js
import logger from "../utils/logger.js";
import connectionPersistence from "./whatsappConnectionPersistence.js";
// WhatsAppMessageProcessor will be instantiated and passed by WhatsAppService

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INITIAL_DELAY_MS = 5000;

class WhatsAppEventHandler {
  constructor(sessionsMap, messageProcessor, initializeSessionFn) {
    this.sessions = sessionsMap; // Reference to the shared sessions Map from ClientManager/WhatsAppService
    this.messageProcessor = messageProcessor;
    this.initializeSession = initializeSessionFn; // Function to re-initialize a session
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
      `EventHandler: QR Code received for '${connectionName}'. Manual scan required.`
    );
    const current = this.sessions.get(connectionName);
    if (current) {
      current.qr = qr;
      current.status = "qr_ready";
      current.isReconnecting = false;
      current.reconnectAttempts = 0;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "qr_pending_scan",
        false
      );
      logger.info(
        `EventHandler: Session ${connectionName} status updated to qr_ready. Auto-reconnection disabled pending scan.`
      );
    } else {
      logger.error(
        `CRITICAL: Session '${connectionName}' not found in map when 'qr' event fired.`
      );
    }
  }

  onReady(connectionName) {
    logger.info(
      `EventHandler: WhatsApp client is ready for '${connectionName}'.`
    );
    const current = this.sessions.get(connectionName);
    if (current) {
      current.status = "connected";
      current.qr = null;
      current.isReconnecting = false;
      current.reconnectAttempts = 0;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "connected",
        true
      );
    }
  }

  onAuthenticated(connectionName) {
    logger.info(
      `EventHandler: WhatsApp client authenticated for '${connectionName}'.`
    );
    const current = this.sessions.get(connectionName);
    if (current) {
      current.status = "authenticated";
      current.qr = null;
      current.isReconnecting = false;
      current.reconnectAttempts = 0;
      connectionPersistence.updateConnectionStatus(
        connectionName,
        "authenticated",
        true
      );
    }
  }

  async onAuthFailure(errorMsg, connectionName) {
    logger.error(
      `EventHandler: WhatsApp authentication failed for '${connectionName}'. Error: ${errorMsg}`
    );
    const current = this.sessions.get(connectionName);
    if (current) {
      current.status = "auth_failed";
      current.isReconnecting = false;
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "auth_failed",
        false
      );
      // The main service's closeSession should be called here to ensure full cleanup
      // This creates a slight circular dependency if not handled carefully.
      // For now, we assume the main service will handle the full closure.
      // Or, ClientManager can emit an event that WhatsAppService listens to.
      if (typeof current.closeCallback === "function") {
        await current.closeCallback(true, true); // forceClose = true, calledFromAuthFailure = true
      }
    } else {
      logger.error(`Session ${connectionName} not found during auth_failure.`);
      const conn = await connectionPersistence.getByConnectionName(
        connectionName
      );
      if (conn) {
        await connectionPersistence.updateConnectionStatus(
          connectionName,
          "auth_failed",
          false
        );
      }
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
        "closed",
        "closed_forced",
        "auth_failed",
        "disconnected_permanent",
      ].includes(session.status)
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} not found or in terminal state. No reconnect action. Status: ${session?.status}`
      );
      if (!session) {
        const connEntry = await connectionPersistence.getByConnectionName(
          connectionName
        );
        if (connEntry && connEntry.autoReconnect) {
          await connectionPersistence.updateConnectionStatus(
            connectionName,
            `disconnected: ${reason}`,
            true
          );
        }
      }
      return;
    }

    if (
      session.isReconnecting &&
      (session.status === "reconnecting" || session.status === "initializing")
    ) {
      logger.info(
        `EventHandler: Session ${connectionName} already in reconnect/init cycle. Ignoring duplicate disconnect.`
      );
      return;
    }

    await connectionPersistence.updateConnectionStatus(
      connectionName,
      "reconnecting",
      session.autoReconnect !== undefined ? session.autoReconnect : true
    );

    session.status = "reconnecting";
    session.isReconnecting = true;
    session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

    logger.info(
      `EventHandler: Session ${connectionName} runtime reconnect attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}.`
    );

    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `EventHandler: Max runtime reconnect attempts for ${connectionName}. Giving up cycle.`
      );
      session.isReconnecting = false;
      session.status = "disconnected_permanent";
      await connectionPersistence.updateConnectionStatus(
        connectionName,
        "disconnected_permanent",
        false
      );
      if (typeof session.closeCallback === "function") {
        await session.closeCallback(true); // forceClose
      }
      return;
    }

    if (session.client) {
      try {
        await session.client.destroy();
        logger.info(
          `EventHandler: Old client for ${connectionName} destroyed for reconnect attempt ${session.reconnectAttempts}.`
        );
      } catch (e) {
        logger.error(
          { err: e },
          `EventHandler: Error destroying client ${connectionName} during reconnect prep.`
        );
      }
      session.client = null;
    }

    const delay = RECONNECT_INITIAL_DELAY_MS * session.reconnectAttempts;
    logger.info(
      `EventHandler: Scheduling runtime reconnect for ${connectionName} in ${
        delay / 1000
      }s.`
    );

    setTimeout(async () => {
      const currentSessionState = this.sessions.get(connectionName);
      if (!currentSessionState || !currentSessionState.isReconnecting) {
        logger.info(
          `EventHandler: Runtime reconnect for ${connectionName} aborted (session removed/flag cleared).`
        );
        return;
      }
      try {
        logger.info(
          `EventHandler: Executing scheduled runtime reconnect for ${connectionName} (Attempt ${currentSessionState.reconnectAttempts})`
        );
        // We need a way to call the main initializeSession function from the WhatsAppService facade
        await this.initializeSession(
          connectionName,
          currentSessionState.systemPromptName,
          currentSessionState.userId,
          true // isRetry = true
        );
      } catch (error) {
        logger.error(
          { err: error },
          `EventHandler: Scheduled runtime reconnect for ${connectionName} failed.`
        );
      }
    }, delay);
  }

  async onMessage(message, connectionName) {
    if (message.fromMe || message.from === "status@broadcast") return;

    const currentSession = this.sessions.get(connectionName);
    if (
      !currentSession ||
      !["connected", "authenticated"].includes(currentSession.status)
    ) {
      logger.warn(
        `EventHandler: Message for ${connectionName} from ${message.from} but session not ready (Status: ${currentSession?.status}). Ignoring.`
      );
      return;
    }
    logger.info(
      `EventHandler: Message received for ${connectionName} from ${message.from}`
    );
    await this.messageProcessor.processIncomingMessage(
      message,
      connectionName,
      currentSession
    );
  }
}

export default WhatsAppEventHandler;
