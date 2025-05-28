// __tests__/utils/whatsappClientManager.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import WhatsAppClientManager from "../../src/utils/whatsappClientManager.js";

// Mocks
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../../src/utils/whatsappConnectionPersistence.js", () => ({
  default: {
    saveConnectionDetails: vi.fn(),
  },
}));
vi.mock("../../src/models/botProfileModel.js", () => ({
  default: {
    findOne: vi.fn(),
    exists: vi.fn(),
  },
}));
vi.mock("../../src/mcpClient.js", () => ({
  initializeAI: vi
    .fn()
    .mockResolvedValue({ botProfileText: "text", closeMcpClients: vi.fn() }),
}));
vi.mock("../../src/utils/json2llm.js", () => ({
  botProfileToNaturalLanguage: vi.fn(() => "profileText"),
}));
vi.mock("wwebjs-mongo", () => ({ MongoStore: vi.fn() }));
vi.mock("whatsapp-web.js", () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(),
      destroy: vi.fn().mockResolvedValue(),
      info: { wid: { user: "555" } },
    })),
    RemoteAuth: vi.fn(),
  },
  Client: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(),
    destroy: vi.fn().mockResolvedValue(),
    info: { wid: { user: "555" } },
  })),
  RemoteAuth: vi.fn(),
}));

function makeEventHandler() {
  return {
    registerEventHandlers: vi.fn(),
  };
}

describe("WhatsAppClientManager", () => {
  let manager, eventHandler;
  beforeEach(() => {
    eventHandler = makeEventHandler();
    manager = new WhatsAppClientManager(eventHandler);
    vi.clearAllMocks();
  });

  it("getOrCreateSessionEntry creates and returns a session", () => {
    const session = manager.getOrCreateSessionEntry("conn1", { userId: "u" });
    expect(session.userId).toBe("u");
    expect(manager.sessions.has("conn1")).toBe(true);
  });

  it("getSession returns undefined for missing session", () => {
    expect(manager.getSession("none")).toBeUndefined();
  });

  it("createAndInitializeClient throws if already managed", async () => {
    manager.getOrCreateSessionEntry("conn1", {
      client: {},
      status: "connected",
    });
    await expect(
      manager.createAndInitializeClient("conn1", "bot1", "user1")
    ).rejects.toThrow(/already active/);
  });

  it("createAndInitializeClient throws if reconnect in progress", async () => {
    manager.getOrCreateSessionEntry("conn1", {
      isReconnecting: true,
      status: "reconnecting",
    });
    await expect(
      manager.createAndInitializeClient("conn1", "bot1", "user1")
    ).rejects.toThrow(/currently attempting to reconnect/);
  });

  it("createAndInitializeClient throws if bot profile not found", async () => {
    const BotProfile = (await import("../../src/models/botProfileModel.js"))
      .default;
    BotProfile.findOne.mockResolvedValue(null);
    BotProfile.exists.mockResolvedValue(false);
    await expect(
      manager.createAndInitializeClient("conn1", "bot1", "user1")
    ).rejects.toThrow(/not found/);
  });

  it("createAndInitializeClient initializes client and session", async () => {
    const BotProfile = (await import("../../src/models/botProfileModel.js"))
      .default;
    BotProfile.findOne.mockResolvedValue({
      _id: "bot1",
      name: "Bot",
      toObject: () => ({}),
    });
    const { initializeAI } = await import("../../src/mcpClient.js");
    initializeAI.mockResolvedValue({
      botProfileText: "text",
      closeMcpClients: vi.fn(),
    });
    const { botProfileToNaturalLanguage } = await import(
      "../../src/utils/json2llm.js"
    );
    botProfileToNaturalLanguage.mockReturnValue("profileText");
    const client = await manager.createAndInitializeClient(
      "conn1",
      "bot1",
      "user1"
    );
    expect(client).toBeDefined();
    expect(manager.sessions.get("conn1").status).toBe("initializing");
  });

  it("cleanupClientResources destroys client and closes MCP clients", async () => {
    const closeMcpClients = vi.fn();
    manager.sessions.set("conn1", {
      client: { destroy: vi.fn().mockResolvedValue() },
      aiInstance: { closeMcpClients },
    });
    await manager.cleanupClientResources("conn1");
    expect(closeMcpClients).toHaveBeenCalled();
    expect(manager.sessions.get("conn1").client).toBeNull();
  });

  it("removeSession deletes session and logs", () => {
    manager.sessions.set("conn1", {});
    manager.removeSession("conn1");
    expect(manager.sessions.has("conn1")).toBe(false);
  });

  it("destroyClient returns not_found if no session", async () => {
    const result = await manager.destroyClient("none");
    expect(result).toBe("not_found");
  });

  it("destroyClient sets status and calls cleanup", async () => {
    manager.sessions.set("conn1", { isReconnecting: true });
    manager.cleanupClientResources = vi.fn().mockResolvedValue();
    const result = await manager.destroyClient("conn1", true, true);
    expect(result).toBe("auth_failed");
    expect(manager.sessions.get("conn1").status).toBe("auth_failed");
    expect(manager.cleanupClientResources).toHaveBeenCalledWith("conn1", false);
  });
});
