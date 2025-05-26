// storageProviders/cloudinaryProvider.js
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v4 as uuidv4 } from "uuid";

export function getCloudinaryStorage(logger) {
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
    secure: true,
  });

  return new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
      let resource_type = "raw";
      if (file.mimetype.startsWith("image/")) {
        resource_type = "image";
      } else if (file.mimetype.startsWith("video/")) {
        resource_type = "video";
      } else if (file.mimetype.startsWith("audio/")) {
        resource_type = "video";
      }
      return {
        folder: process.env.CLOUDINARY_FOLDER || "chatbot_uploads",
        public_id: uuidv4(),
        resource_type,
      };
    },
  });
}
