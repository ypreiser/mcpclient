//__tests__/routes/whatsappRoute.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";

// Mock requireAuth before importing whatsappRoutes
vi.mock("../../src/routes/authRoute.js", () => ({
  requireAuth: (req, res, next) => {
    req.user = { _id: "user123" };
    next();
  },
}));

// Mocks for other dependencies
vi.mock("../../src/utils/whatsappService.js", () => ({
  default: {
    initializeSession: vi.fn(),
    getStatus: vi.fn(),
    getQRCode: vi.fn(),
    sendMessage: vi.fn(),
    closeSession: vi.fn(),
    clientManager: {
      getSession: vi.fn(),
      removeSession: vi.fn(),
    },
  },
}));
vi.mock("../../src/models/whatsAppConnectionModel.js", () => ({
  default: {
    find: vi.fn(() => ({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockResolvedValue([]),
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

import whatsappRoutes from "../../src/routes/whatsappRoute.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/wa", whatsappRoutes);
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("WhatsApp Routes API", () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
  });

  it("GET /connections returns empty array", async () => {
    const res = await request(app).get("/api/wa/connections");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("connections");
    expect(Array.isArray(res.body.connections)).toBe(true);
  });

  it("POST /session initializes session", async () => {
    const whatsappService = (await import("../../src/utils/whatsappService.js"))
      .default;
    whatsappService.getStatus.mockResolvedValue("initializing");
    const res = await request(app)
      .post("/api/wa/session")
      .send({ connectionName: "conn1", botProfileId: "bot1" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("connectionName", "conn1");
    expect(res.body).toHaveProperty("status", "initializing");
    expect(whatsappService.initializeSession).toHaveBeenCalled();
  });

  it("POST /session returns 400 for missing fields", async () => {
    const res = await request(app).post("/api/wa/session").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("GET /session/:connectionName/qr returns QR", async () => {
    const whatsappService = (await import("../../src/utils/whatsappService.js"))
      .default;
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user123",
      status: "qr_ready",
      qr: "qrstring",
    });
    whatsappService.getQRCode.mockResolvedValue("qrstring");
    // Mock QRCode.toDataURL
    vi.mock("qrcode", () => ({
      default: {
        toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
      },
      toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,abc"),
    }));
    const res = await request(app).get("/api/wa/session/conn1/qr");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("qr");
  });

  it("GET /session/:connectionName/status returns status", async () => {
    const whatsappService = (await import("../../src/utils/whatsappService.js"))
      .default;
    whatsappService.getStatus.mockResolvedValue("connected");
    const res = await request(app).get("/api/wa/session/conn1/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "connected");
  });

  it("POST /session/:connectionName/message sends message", async () => {
    const whatsappService = (await import("../../src/utils/whatsappService.js"))
      .default;
    whatsappService.sendMessage.mockResolvedValue({ id: { id: "msgid" } });
    const res = await request(app)
      .post("/api/wa/session/conn1/message")
      .send({ to: "12345", message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
    expect(res.body).toHaveProperty("messageId", "msgid");
  });

  it("POST /session/:connectionName/message returns 400 for missing fields", async () => {
    const res = await request(app)
      .post("/api/wa/session/conn1/message")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("DELETE /session/:connectionName closes session", async () => {
    const whatsappService = (await import("../../src/utils/whatsappService.js"))
      .default;
    whatsappService.clientManager.getSession.mockReturnValue({
      userId: "user123",
    });
    whatsappService.closeSession.mockResolvedValue(true);
    const res = await request(app).delete("/api/wa/session/conn1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("success", true);
  });
});
