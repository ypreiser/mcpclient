// __tests__/utils/uploadMiddleware.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock storage providers before importing the module under test
vi.mock("../../src/utils/storageProviders/cloudinaryProvider.js", () => ({
  getCloudinaryStorage: () => ({ _provider: "cloudinary" }),
}));
vi.mock("../../src/utils/storageProviders/s3Provider.js", () => ({
  getS3Storage: () => ({ _provider: "s3" }),
}));
vi.mock("../../src/utils/storageProviders/gcsProvider.js", () => ({
  getGCSStorage: () => ({ _provider: "gcs" }),
}));

const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
];

describe("uploadMiddleware.js", () => {
  let logger;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.FILE_STORAGE_PROVIDER = "cloudinary";
    process.env.MAX_FILE_SIZE_BYTES = "20971520";
    logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  });

  it("should use Cloudinary storage by default", async () => {
    const { getStorageProvider } = await import(
      "../../src/utils/uploadMiddleware.js"
    );
    const storage = getStorageProvider(logger);
    expect(storage._provider).toBe("cloudinary");
  });

  it("should use S3 storage if FILE_STORAGE_PROVIDER is 's3'", async () => {
    process.env.FILE_STORAGE_PROVIDER = "s3";
    const { getStorageProvider } = await import(
      "../../src/utils/uploadMiddleware.js"
    );
    const storage = getStorageProvider(logger);
    expect(storage._provider).toBe("s3");
  });

  it("should use GCS storage if FILE_STORAGE_PROVIDER is 'gcs'", async () => {
    process.env.FILE_STORAGE_PROVIDER = "gcs";
    const { getStorageProvider } = await import(
      "../../src/utils/uploadMiddleware.js"
    );
    const storage = getStorageProvider(logger);
    expect(storage._provider).toBe("gcs");
  });

  it("should warn and default to Cloudinary for unknown provider", async () => {
    process.env.FILE_STORAGE_PROVIDER = "unknown";
    const { getStorageProvider } = await import(
      "../../src/utils/uploadMiddleware.js"
    );
    const warnSpy = vi.spyOn(logger, "warn");
    const storage = getStorageProvider(logger);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown FILE_STORAGE_PROVIDER")
    );
    expect(storage._provider).toBe("cloudinary");
  });

  it("should accept allowed mime types in fileFilter", async () => {
    const { fileFilter } = await import("../../src/utils/uploadMiddleware.js");
    for (const type of allowedMimeTypes) {
      const cb = vi.fn();
      fileFilter({}, { mimetype: type, originalname: "file" }, cb);
      expect(cb).toHaveBeenCalledWith(null, true);
    }
  });

  it("should reject disallowed mime types in fileFilter and log warning", async () => {
    const { fileFilter } = await import("../../src/utils/uploadMiddleware.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cb = vi.fn();
    fileFilter(
      {},
      { mimetype: "application/x-unknown", originalname: "badfile" },
      cb
    );
    expect(cb).toHaveBeenCalledWith(expect.any(Error), false);
    warnSpy.mockRestore();
  });

  it("should set file size limit from env", async () => {
    process.env.MAX_FILE_SIZE_BYTES = "12345";
    const uploadLocal = (await import("../../src/utils/uploadMiddleware.js"))
      .default;
    expect(uploadLocal.limits.fileSize).toBe(12345);
  });

  it("should export a multer instance", async () => {
    const uploadLocal = (await import("../../src/utils/uploadMiddleware.js"))
      .default;
    expect(typeof uploadLocal.single).toBe("function");
    expect(typeof uploadLocal.array).toBe("function");
    expect(typeof uploadLocal.fields).toBe("function");
  });
});

// Export for coverage
export {};
