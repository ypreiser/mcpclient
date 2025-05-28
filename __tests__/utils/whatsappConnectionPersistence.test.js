// __tests__/utils/whatsappConnectionPersistence.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import WhatsAppConnectionPersistence from "../../src/utils/whatsappConnectionPersistence.js";

vi.mock("../../src/models/whatsAppConnectionModel.js", () => ({
  default: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    find: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    })),
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const WhatsAppConnection = (
  await import("../../src/models/whatsAppConnectionModel.js")
).default;
const logger = (await import("../../src/utils/logger.js")).default;

describe("WhatsAppConnectionPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getByConnectionName returns connection", async () => {
    WhatsAppConnection.findOne.mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue({ connectionName: "conn1" }),
    });
    const result = await WhatsAppConnectionPersistence.getByConnectionName(
      "conn1",
      "user1"
    );
    expect(result).toEqual({ connectionName: "conn1" });
  });

  it("getByConnectionName throws if no userId", async () => {
    await expect(
      WhatsAppConnectionPersistence.getByConnectionName("conn1")
    ).rejects.toThrow("User ID is required");
  });

  it("saveConnectionDetails upserts and returns connection", async () => {
    WhatsAppConnection.findOneAndUpdate.mockResolvedValue({
      connectionName: "conn1",
    });
    const result = await WhatsAppConnectionPersistence.saveConnectionDetails(
      "conn1",
      "bot1",
      "user1",
      "connected",
      true
    );
    expect(result).toEqual({ connectionName: "conn1" });
  });

  it("saveConnectionDetails throws if no userId", async () => {
    await expect(
      WhatsAppConnectionPersistence.saveConnectionDetails(
        "conn1",
        "bot1",
        undefined,
        "connected",
        true
      )
    ).rejects.toThrow("User ID is required");
  });

  it("saveConnectionDetails handles duplicate key error", async () => {
    WhatsAppConnection.findOneAndUpdate.mockRejectedValue({ code: 11000 });
    await expect(
      WhatsAppConnectionPersistence.saveConnectionDetails(
        "conn1",
        "bot1",
        "user1",
        "connected",
        true
      )
    ).rejects.toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        connectionName: "conn1",
        userId: "user1",
      }),
      expect.stringContaining("Duplicate key error")
    );
  });

  it("updateConnectionStatus updates if userId present", async () => {
    WhatsAppConnection.updateOne.mockResolvedValue({ matchedCount: 1 });
    await WhatsAppConnectionPersistence.updateConnectionStatus(
      "conn1",
      "user1",
      "connected",
      true
    );
    expect(WhatsAppConnection.updateOne).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("updateConnectionStatus logs and returns if no userId", async () => {
    await WhatsAppConnectionPersistence.updateConnectionStatus(
      "conn1",
      undefined,
      "connected",
      true
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("updateConnectionStatus logs warn if no match", async () => {
    WhatsAppConnection.updateOne.mockResolvedValue({ matchedCount: 0 });
    await WhatsAppConnectionPersistence.updateConnectionStatus(
      "conn1",
      "user1",
      "connected",
      true
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it("updateConnectionStatus logs error on db error", async () => {
    WhatsAppConnection.updateOne.mockRejectedValue(new Error("fail"));
    await WhatsAppConnectionPersistence.updateConnectionStatus(
      "conn1",
      "user1",
      "connected",
      true
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("updateLastAttemptedReconnect updates if userId present", async () => {
    WhatsAppConnection.updateOne.mockResolvedValue({});
    await WhatsAppConnectionPersistence.updateLastAttemptedReconnect(
      "conn1",
      "user1"
    );
    expect(WhatsAppConnection.updateOne).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it("updateLastAttemptedReconnect logs and returns if no userId", async () => {
    await WhatsAppConnectionPersistence.updateLastAttemptedReconnect(
      "conn1",
      undefined
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("updateLastAttemptedReconnect logs error on db error", async () => {
    WhatsAppConnection.updateOne.mockRejectedValue(new Error("fail"));
    await WhatsAppConnectionPersistence.updateLastAttemptedReconnect(
      "conn1",
      "user1"
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it("getConnectionsToReconnect returns array", async () => {
    WhatsAppConnection.find()
      .select()
      .lean.mockResolvedValue([
        { connectionName: "conn1", userId: "user1", botProfileId: "bot1" },
      ]);
    const result =
      await WhatsAppConnectionPersistence.getConnectionsToReconnect();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toHaveProperty("connectionName", "conn1");
  });

  it("getConnectionsToReconnect logs error and returns [] on db error", async () => {
    WhatsAppConnection.find()
      .select()
      .lean.mockRejectedValue(new Error("fail"));
    const result =
      await WhatsAppConnectionPersistence.getConnectionsToReconnect();
    expect(logger.error).toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
