// __tests__/utils/whatsappService.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import whatsappService from "../../src/utils/whatsappService.js";

// Mocks for dependencies
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock("../../src/utils/whatsappClientManager.js", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getSession: vi.fn(),
      createAndInitializeClient: vi.fn(),
      destroyClient: vi.fn(),
      removeSession: vi.fn(),
      sessions: new Map(),
    })),
  };
});
vi.mock("../../src/utils/whatsappEventHandler.js", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      registerEventHandlers: vi.fn(),
      sessions: new Map(),
    })),
  };
});
vi.mock("../../src/utils/whatsappMessageProcessor.js", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      processIncomingMessage: vi.fn(),
    })),
  };
});
vi.mock("../../src/utils/whatsappConnectionPersistence.js", () => {
  return {
    default: {
      getByConnectionName: vi.fn(),
      saveConnectionDetails: vi.fn(),
      updateConnectionStatus: vi.fn(),
      updateLastAttemptedReconnect: vi.fn(),
      getConnectionsToReconnect: vi.fn(),
    },
  };
});
vi.mock("../../src/models/whatsAppConnectionModel.js", () => ({
  default: {
    findOneAndUpdate: vi.fn(),
    find: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
      populate: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
    })),
  },
}));

// Helper to reset mocks
function clearAllMocks() {
  vi.clearAllMocks();
}

describe("whatsappService", () => {
  beforeEach(() => {
    clearAllMocks();
    whatsappService.isShuttingDown = false; // Ensure clean state for isShuttingDown
  });

  it("should initialize a session and call clientManager.createAndInitializeClient", async () => {
    const spy = whatsappService.clientManager.createAndInitializeClient;
    spy.mockResolvedValue();
    await expect(
      whatsappService.initializeSession("conn1", "bot1", "user1")
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      "conn1",
      "bot1",
      "user1",
      false,
      expect.any(Function)
    );
  });

  it("should throw if shutdown in progress on initializeSession", async () => {
    // beforeEach ensures whatsappService.isShuttingDown is false initially
    whatsappService.isShuttingDown = true;
    try {
      await expect(
        whatsappService.initializeSession("conn1", "bot1", "user1")
      ).rejects.toThrow("Service is shutting down.");
    } finally {
      whatsappService.isShuttingDown = false; // Ensure it's reset even if expect throws
    }
  });

  it("should get QR code if session is ready", async () => {
    whatsappService.clientManager.getSession.mockReturnValue({
      status: "qr_ready",
      qr: "qrstring",
    });
    const qr = await whatsappService.getQRCode("conn1");
    expect(qr).toBe("qrstring");
  });

  it("should return null if QR code not ready", async () => {
    whatsappService.clientManager.getSession.mockReturnValue({
      status: "connected",
      qr: null,
    });
    const qr = await whatsappService.getQRCode("conn1");
    expect(qr).toBeNull();
  });

  it("should get status from in-memory session", async () => {
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user1",
      status: "connected",
    });
    const status = await whatsappService.getStatus("conn1", "user1");
    expect(status).toBe("connected");
  });

  it("should get status from DB if not in memory", async () => {
    whatsappService.clientManager.getSession.mockReturnValue(undefined);
    const connectionPersistence = (
      await import("../../src/utils/whatsappConnectionPersistence.js")
    ).default;
    connectionPersistence.getByConnectionName.mockResolvedValue({
      lastKnownStatus: "db_status",
    });
    const status = await whatsappService.getStatus("conn1", "user1");
    expect(status).toBe("db_status");
  });

  it("should send message if session is ready", async () => {
    const sendMessageMock = vi.fn().mockResolvedValue({ id: { id: "msgid" } });
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user1",
      status: "connected",
      client: { sendMessage: sendMessageMock },
    });
    const result = await whatsappService.sendMessage(
      "conn1",
      "user1",
      "to",
      "msg"
    );
    expect(sendMessageMock).toHaveBeenCalledWith("to", "msg");
    expect(result).toEqual({ id: { id: "msgid" } });
  });

  it("should throw if sendMessage called when session not ready", async () => {
    whatsappService.clientManager.getSession.mockReturnValue(undefined);
    await expect(
      whatsappService.sendMessage("conn1", "user1", "to", "msg")
    ).rejects.toThrow();
  });

  it("should close session and call destroyClient", async () => {
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user1",
      botProfileId: "bot1",
    });
    whatsappService.clientManager.destroyClient.mockResolvedValue(
      "closed_manual"
    );
    const connectionPersistence = (
      await import("../../src/utils/whatsappConnectionPersistence.js")
    ).default;
    connectionPersistence.saveConnectionDetails.mockResolvedValue();
    const result = await whatsappService.closeSession("conn1");
    expect(whatsappService.clientManager.destroyClient).toHaveBeenCalledWith(
      "conn1",
      false,
      false
    );
    expect(connectionPersistence.saveConnectionDetails).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("should call updateConnectionStatus if botProfileId missing on close", async () => {
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user1",
    });
    whatsappService.clientManager.destroyClient.mockResolvedValue(
      "closed_manual"
    );
    const connectionPersistence = (
      await import("../../src/utils/whatsappConnectionPersistence.js")
    ).default;
    connectionPersistence.saveConnectionDetails.mockResolvedValue();
    connectionPersistence.updateConnectionStatus.mockResolvedValue();
    const result = await whatsappService.closeSession("conn1");
    expect(connectionPersistence.updateConnectionStatus).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it("should load and reconnect persisted sessions", async () => {
    const connectionPersistence = (
      await import("../../src/utils/whatsappConnectionPersistence.js")
    ).default;
    connectionPersistence.getConnectionsToReconnect.mockResolvedValue([
      { connectionName: "conn1", botProfileId: "bot1", userId: "user1" },
    ]);
    whatsappService.clientManager.getSession.mockReturnValue(undefined);
    whatsappService.initializeSession = vi.fn().mockResolvedValue();
    connectionPersistence.updateLastAttemptedReconnect.mockResolvedValue();
    await whatsappService.loadAndReconnectPersistedSessions();
    expect(
      connectionPersistence.updateLastAttemptedReconnect
    ).toHaveBeenCalledWith("conn1", "user1");
    expect(whatsappService.initializeSession).toHaveBeenCalledWith(
      "conn1",
      "bot1",
      "user1",
      true
    );
  });

  it("should handle graceful shutdown", async () => {
    whatsappService.clientManager.sessions.set("conn1", {});
    whatsappService.closeSession = vi.fn().mockResolvedValue();
    await whatsappService.gracefulShutdown();
    expect(whatsappService.closeSession).toHaveBeenCalledWith("conn1", false);
  });
});
