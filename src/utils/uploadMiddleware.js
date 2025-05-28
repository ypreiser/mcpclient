// src\utils\uploadMiddleware.js
//mcpclient/utils/uploadMiddleware.js

import multer from "multer";
import logger from "../utils/logger.js"; // Assuming logger is in ../utils
import { getCloudinaryStorage } from "./storageProviders/cloudinaryProvider.js";
import { getS3Storage } from "./storageProviders/s3Provider.js";
import { getGCSStorage } from "./storageProviders/gcsProvider.js";

// Allowed file types (extend as needed)
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

// Select storage provider based on env var
function getStorageProvider(logger) {
  const provider = (
    process.env.FILE_STORAGE_PROVIDER || "cloudinary"
  ).toLowerCase();
  if (provider === "cloudinary") return getCloudinaryStorage(logger);
  if (provider === "s3") return getS3Storage(logger);
  if (provider === "gcs" || provider === "google" || provider === "googlecloud")
    return getGCSStorage(logger);
  logger.warn(
    `Unknown FILE_STORAGE_PROVIDER '${provider}', defaulting to Cloudinary.`
  );
  return getCloudinaryStorage(logger);
}

const storage = getStorageProvider(logger);

const fileFilter = (req, file, cb) => {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    logger.warn(
      `Upload rejected for file '${file.originalname}' due to invalid MIME type: ${file.mimetype}`
    );
    cb(
      new Error(
        `Invalid file type: ${
          file.mimetype
        }. Allowed types are: ${allowedMimeTypes.join(", ")}.`
      ),
      false
    );
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES || "20971520") },
});

export default upload;
export { getStorageProvider, fileFilter };
