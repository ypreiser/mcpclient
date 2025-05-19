// mcpclient/routes/uploadRoute.js
import express from "express";
import multer from "multer";
import upload from "../utils/uploadMiddleware.js";
import logger from "../utils/logger.js";

const router = express.Router();

// File upload endpoint (public)
router.post("/", upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) {
      logger.warn({}, "Upload attempt with no file.");
      return res.status(400).json({ error: "No file uploaded." });
    }
    // Security: `uploadMiddleware` handles file type and size checks.
    // `req.file.path` from multer-storage-cloudinary is the URL to the file.
    const fileMeta = {
      url: req.file.path, // Cloudinary URL
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      // Consider adding `public_id: req.file.filename` if using `CloudinaryStorage`'s `filename` mapping to `public_id`
      // For the default `multer-storage-cloudinary`, `req.file.filename` might be the `public_id`.
    };
    logger.info({ file: fileMeta }, "File uploaded successfully");
    res.status(201).json({ file: fileMeta });
  } catch (error) {
    // Multer errors (e.g., file too large, invalid type from fileFilter) might be caught here
    logger.error({ err: error }, "Error during file upload processing");
    if (error.message.includes("Invalid file type")) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof multer.MulterError) {
      return res
        .status(400)
        .json({ error: `File upload error: ${error.message}` });
    }
    next(error); // Pass to global error handler
  }
});

export default router;
