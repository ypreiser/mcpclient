// mcpclient/controllers/botProfileController.js
import BotProfile from "../models/botProfileModel.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";

const botProfileController = {
  getAllProfilesForUser: async (req, res, next) => {
    try {
      const profiles = await BotProfile.find({ userId: req.user._id })
        .select("name _id isEnabled createdAt updatedAt communicationStyle tags description")
        .sort({ updatedAt: -1 });
      
      logger.info({ userId: req.user._id, count: profiles.length }, "Fetched bot profiles for user.");
      res.json(profiles);
    } catch (error) {
      logger.error({ err: error, userId: req.user._id }, "Failed to fetch bot profiles for user");
      next(error);
    }
  },

  getProfileByName: async (req, res, next) => {
    try {
      const { name } = req.params;
      if (!req.user?._id) {
          logger.warn({ profileName: name }, "Attempt to fetch profile by name without authenticated user.");
          return res.status(401).json({ message: "Authentication required." });
      }

      const profile = await BotProfile.findOne({
        name: name,
        userId: req.user._id,
      });

      if (!profile) {
        logger.warn({ profileName: name, userId: req.user._id }, "Bot profile not found by name for user.");
        return res.status(404).json({ message: "Bot profile not found." });
      }
      logger.info({ profileName: name, userId: req.user._id, profileId: profile._id }, "Fetched bot profile by name.");
      res.json(profile);
    } catch (error) {
      logger.error({ err: error, profileName: req.params.name, userId: req.user?._id }, "Failed to fetch bot profile by name");
      next(error);
    }
  },

  getProfileById: async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            logger.warn({ profileId: id, userId: req.user?._id }, "Invalid profile ID format provided.");
            return res.status(400).json({ message: "Invalid bot profile ID format." });
        }

        const profile = await BotProfile.findOne({
            _id: id,
            userId: req.user._id,
        });

        if (!profile) {
            logger.warn({ profileId: id, userId: req.user?._id }, "Bot profile not found by ID for user.");
            return res.status(404).json({ message: "Bot profile not found." });
        }
        logger.info({ profileId: id, userId: req.user?._id }, "Fetched bot profile by ID.");
        res.json(profile);
    } catch (error) {
        logger.error({ err: error, profileId: req.params.id, userId: req.user?._id }, "Failed to fetch bot profile by ID");
        next(error);
    }
  },

  createProfile: async (req, res, next) => {
    try {
      // Ensure req.user and req.user._id are present (should be guaranteed by requireAuth)
      if (!req.user || !req.user._id) {
        logger.error({ path: req.path, method: req.method }, "Critical: req.user._id not found in createProfile. Auth middleware issue?");
        return res.status(500).json({ message: "User authentication data missing." });
      }

      const newProfileData = {
        ...req.body, // Data from frontend (should NOT contain userId)
        userId: req.user._id, // Assign to current authenticated user from requireAuth
      };
      
      // Prevent client from setting these internal/protected fields explicitly in the payload
      delete newProfileData._id;
      delete newProfileData.createdAt; // Will be set by Mongoose default
      delete newProfileData.updatedAt; // Will be set by Mongoose pre-save or default
      // DO NOT `delete newProfileData.userId;` HERE. It was just correctly set.
      // If req.body contained a 'userId', the spread `...req.body` would include it,
      // but our explicit assignment `userId: req.user._id` overrides it with the correct, authenticated ID.

      const existingProfile = await BotProfile.findOne({ name: newProfileData.name, userId: req.user._id });
      if (existingProfile) {
          logger.warn({ profileName: newProfileData.name, userId: req.user._id }, "Attempt to create bot profile with duplicate name for user.");
          return res.status(409).json({ message: `A bot profile named "${newProfileData.name}" already exists for your account.`});
      }
      
      const profile = new BotProfile(newProfileData);
      await profile.save(); // Mongoose schema validation runs here (including required userId)

      logger.info({ profileName: profile.name, userId: req.user._id, profileId: profile._id }, "Bot profile created successfully.");
      res.status(201).json(profile);
    } catch (err) {
      if (err.name === "ValidationError") {
        logger.warn({ err, profileData: req.body, userId: req.user?._id }, "Bot profile creation validation error."); // Use req.user?._id for safety if req.user might be undefined
        const errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
        return res.status(400).json({ message: "Validation failed.", errors });
      }
      if (err.code === 11000) {
        logger.warn({ err, profileData: req.body, userId: req.user?._id }, "Duplicate bot profile name on create.");
        return res.status(409).json({ message: `A bot profile named "${req.body.name}" already exists for your account.` });
      }
      logger.error({ err, profileData: req.body, userId: req.user?._id }, "Error creating bot profile.");
      next(err);
    }
  },

  updateProfileById: async (req, res, next) => {
    try {
      const { id } = req.params;
      // Ensure req.user and req.user._id are present
      if (!req.user || !req.user._id) {
        logger.error({ path: req.path, method: req.method }, "Critical: req.user._id not found in updateProfileById. Auth middleware issue?");
        return res.status(500).json({ message: "User authentication data missing." });
      }
      
      const updateData = { ...req.body };

      delete updateData.name; 
      delete updateData.userId; 
      delete updateData._id;    
      delete updateData.createdAt; 
      delete updateData.totalPromptTokensUsed;
      delete updateData.totalCompletionTokensUsed;
      delete updateData.totalTokensUsed;
      delete updateData.lastUsedAt;

      const updatedProfile = await BotProfile.findOneAndUpdate(
        { _id: id, userId: req.user._id }, 
        { $set: updateData }, 
        { new: true, runValidators: true, context: 'query' }
      );

      if (!updatedProfile) {
        logger.warn({ profileId: id, userId: req.user._id }, "Bot profile not found for update or user mismatch.");
        return res.status(404).json({ message: "Bot profile not found or you do not have permission to update it." });
      }

      logger.info({ profileId: updatedProfile._id, userId: req.user._id }, "Bot profile updated successfully.");
      res.json(updatedProfile);
    } catch (err) {
      if (err.name === "ValidationError") {
        logger.warn({ err, profileId: req.params.id, updateData: req.body, userId: req.user?._id }, "Bot profile update validation error.");
        const errors = Object.values(err.errors).map(e => ({ field: e.path, message: e.message }));
        return res.status(400).json({ message: "Validation failed.", errors });
      }
      logger.error({ err, profileId: req.params.id, updateData: req.body, userId: req.user?._id }, "Error updating bot profile.");
      next(err);
    }
  },

  deleteProfileById: async (req, res, next) => {
    try {
      const { id } = req.params;
      // Ensure req.user and req.user._id are present
      if (!req.user || !req.user._id) {
        logger.error({ path: req.path, method: req.method }, "Critical: req.user._id not found in deleteProfileById. Auth middleware issue?");
        return res.status(500).json({ message: "User authentication data missing." });
      }

      const result = await BotProfile.deleteOne({ 
        _id: id, 
        userId: req.user._id 
      });

      if (result.deletedCount === 0) {
        logger.warn({ profileId: id, userId: req.user._id }, "Bot profile not found for deletion or user mismatch.");
        return res.status(404).json({ message: "Bot profile not found or you do not have permission to delete it." });
      }

      logger.info({ profileId: id, userId: req.user._id }, "Bot profile deleted successfully.");
      res.json({ message: "Bot profile deleted successfully." });
    } catch (error) {
      logger.error({ err: error, profileId: req.params.id, userId: req.user?._id }, "Error deleting bot profile.");
      next(error);
    }
  },
};

export default botProfileController;