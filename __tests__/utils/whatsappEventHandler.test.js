// __tests__/utils/whatsappEventHandler.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import WhatsAppEventHandler from "../../src/utils/whatsappEventHandler.js";
import persistence from "../../src/utils/whatsappConnectionPersistence.js";

// Mocks
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../src/utils/whatsappConnectionPersistence.js", () => {
  const updateConnectionStatus = vi.fn().mockResolvedValue();
  const getByConnectionName = vi.fn();
  return {
    default: {
      updateConnectionStatus,
      getByConnectionName,
    },
  };
});

function makeSession(overrides = {}) {
  return {
    userId: "user1",
    status: "connected",
    isReconnecting: false,
    reconnectAttempts: 0,
    autoReconnect: true,
    ...overrides,
  };
}

describe("WhatsAppEventHandler", () => {
  let sessions, handler, messageProcessor, initializeSession;
  beforeEach(() => {
    sessions = new Map();
    messageProcessor = { processIncomingMessage: vi.fn() };
    initializeSession = vi.fn();
    handler = new WhatsAppEventHandler(
      sessions,
      messageProcessor,
      initializeSession
    );
    vi.clearAllMocks();
  });

  it("onQR updates session and calls updateConnectionStatus", () => {
    sessions.set("conn1", makeSession());
    handler.onQR("qrstr", "conn1");
    expect(sessions.get("conn1").qr).toBe("qrstr");
    expect(sessions.get("conn1").status).toBe("qr_ready");
    expect(persistence.updateConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "user1",
      "qr_pending_scan",
      false
    );
  });

  it("onReady updates session and calls updateConnectionStatus", () => {
    sessions.set(
      "conn1",
      makeSession({ client: { info: { wid: { user: "555" } } } })
    );
    handler.onReady("conn1");
    expect(sessions.get("conn1").status).toBe("connected");
    expect(persistence.updateConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "user1",
      "connected",
      true,
      "555"
    );
  });

  it("onAuthenticated updates session and calls updateConnectionStatus", () => {
    sessions.set(
      "conn1",
      makeSession({ client: { info: { wid: { user: "555" } } } })
    );
    handler.onAuthenticated("conn1");
    expect(sessions.get("conn1").status).toBe("authenticated");
    expect(persistence.updateConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "user1",
      "authenticated",
      true,
      "555"
    );
  });

  it("onAuthFailure updates session, calls updateConnectionStatus, and closeCallback", async () => {
    const closeCallback = vi.fn();
    sessions.set("conn1", makeSession({ closeCallback }));
    persistence.updateConnectionStatus.mockResolvedValue();
    await handler.onAuthFailure("fail", "conn1");
    expect(sessions.get("conn1").status).toBe("auth_failed");
    expect(persistence.updateConnectionStatus).toHaveBeenCalledWith(
      "conn1",
      "user1",
      "auth_failed",
      false
    );
    expect(closeCallback).toHaveBeenCalledWith(true, true);
  });

  it("onDisconnected disables reconnect if autoReconnect is false", async () => {
    const closeCallback = vi.fn();
    sessions.set("conn1", makeSession({ autoReconnect: false, closeCallback }));
    persistence.updateConnectionStatus.mockResolvedValue();
    await handler.onDisconnected("reason", "conn1");
    expect(sessions.get("conn1").status).toBe("disconnected");
    expect(closeCallback).toHaveBeenCalledWith(true);
  });

  it.skip("onDisconnected schedules reconnect if autoReconnect is true", async () => {
    sessions.set("conn1", makeSession({ reconnectAttempts: 0 }));
    persistence.updateConnectionStatus.mockResolvedValue();
    global.setTimeout = vi.fn((fn) => fn()); // run immediately
    await handler.onDisconnected("reason", "conn1");
    expect(sessions.get("conn1").status).toBe("reconnecting");
    expect(handler.initializeSession).toHaveBeenCalledWith(
      "conn1",
      undefined,
      "user1",
      true
    );
  });

  it("onMessage calls processIncomingMessage if session is ready", async () => {
    sessions.set("conn1", makeSession({ status: "connected" }));
    const msg = { fromMe: false, isStatus: false };
    await handler.onMessage(msg, "conn1");
    expect(messageProcessor.processIncomingMessage).toHaveBeenCalledWith(
      msg,
      "conn1",
      sessions.get("conn1")
    );
  });

  it("onMessage does nothing if fromMe or isStatus", async () => {
    sessions.set("conn1", makeSession({ status: "connected" }));
    const msg = { fromMe: true, isStatus: false };
    await handler.onMessage(msg, "conn1");
    expect(messageProcessor.processIncomingMessage).not.toHaveBeenCalled();
  });
});
