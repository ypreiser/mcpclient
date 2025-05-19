//mcpclient/utils/uploadMiddleware.js

import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import logger from "../utils/logger.js"; // Assuming logger is in ../utils

// Allowed file types (extend as needed) - Should align with what your Cloudinary account and AI model supports
const allowedMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "text/plain", // .txt
  "text/csv", // .csv
  "audio/mpeg", // .mp3
  "audio/wav", // .wav
  "audio/ogg", // .ogg
  "video/mp4", // .mp4
  "video/webm", // .webm
];

// Cloudinary config (set your credentials in env vars)
if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  logger.warn(
    "Cloudinary environment variables (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET) are not fully set. File uploads will likely fail."
  );
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true, // Use HTTPS
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    // Determine resource type based on mime type for Cloudinary
    let resource_type = "raw"; // Default to raw for general files
    if (file.mimetype.startsWith("image/")) {
      resource_type = "image";
    } else if (file.mimetype.startsWith("video/")) {
      resource_type = "video";
    } else if (file.mimetype.startsWith("audio/")) {
      // Cloudinary handles audio typically as 'video' resource type or 'raw' if specific audio processing is not needed.
      // For AI processing, 'raw' might be safer unless you know the AI specifically benefits from Cloudinary's video type for audio.
      resource_type = "video"; // Or "raw"
    }

    return {
      folder: process.env.CLOUDINARY_FOLDER || "chatbot_uploads", // Your desired folder in Cloudinary
      public_id: uuidv4(), // Generate a unique public ID
      resource_type: resource_type,
      // format: path.extname(file.originalname).replace(".", ""), // Cloudinary can often auto-detect format
      // You can add other Cloudinary upload options here, e.g., quality, format transformation
    };
  },
  // filename is not strictly necessary here as public_id is used by Cloudinary
  // but can be useful for local temp storage if that was part of the chain.
  // For CloudinaryStorage, `file.path` will be the Cloudinary URL.
});

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
  storage: storage, // Use the Cloudinary storage engine
  fileFilter: fileFilter, // Apply the file type filter
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES || "20971520") }, // 20MB default, configurable via env
});

export default upload;
