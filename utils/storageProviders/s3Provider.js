// storageProviders/s3Provider.js
// Stub for S3 storage provider. Implement with multer-s3 or similar.
import multer from "multer";
import multerS3 from "multer-s3";
import AWS from "aws-sdk";

export function getS3Storage(logger) {
  // Check required env vars
  const requiredVars = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "S3_BUCKET_NAME",
  ];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length) {
    logger.warn(
      `Missing S3 environment variables: ${missing.join(
        ", "
      )}. File uploads will likely fail.`
    );
  }

  // Configure AWS SDK
  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });

  const s3 = new AWS.S3();

  return multerS3({
    s3,
    bucket: process.env.S3_BUCKET_NAME,
    acl: process.env.S3_ACL || "public-read",
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      // Use a unique filename (UUID or timestamp + original name)
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(
        null,
        `${process.env.S3_FOLDER || "chatbot_uploads"}/${uniqueSuffix}-${
          file.originalname
        }`
      );
    },
    // Optionally, you can add metadata, cacheControl, etc.
  });
}
