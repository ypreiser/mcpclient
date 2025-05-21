// storageProviders/gcsProvider.js
// Stub for Google Cloud Storage provider. Implement with multer-gcs or similar.
import multer from "multer";

export function getGCSStorage(logger) {
  logger.warn("Google Cloud Storage provider is not yet implemented.");
  // Return a dummy storage for now
  return multer.memoryStorage();
}
