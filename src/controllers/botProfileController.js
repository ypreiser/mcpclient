// src\controllers\botProfileController.js
import BotProfile from "../models/botProfileModel.js";
import User from "../models/userModel.js"; // Assuming User model for validation
import logger from "../utils/logger.js";
import mongoose from "mongoose";

/**
 * Controller for Bot Profile operations.
 * @namespace BotProfileController
 */
const botProfileController = {
  /**
   * Get all bot profiles for the authenticated user (names and essential info for lists).
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  getAllProfilesForUser: async (req, res, next) => {
    try {
      // LBA: Only select fields needed for listing/dropdowns to minimize data transfer.
      const profiles = await BotProfile.find({ userId: req.user._id })
        .select(
          "name _id isEnabled createdAt updatedAt communicationStyle tags description"
        )
        .sort({ updatedAt: -1 });

      logger.info(
        { userId: req.user._id, count: profiles.length },
        "Fetched bot profiles for user."
      );
      res.json(profiles);
    } catch (error) {
      logger.error(
        { err: error, userId: req.user._id },
        "Failed to fetch bot profiles for user"
      );
      next(error); // Pass to global error handler
    }
  },

  /**
   * Get a specific bot profile by its name (scoped to the authenticated user).
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  getProfileByName: async (req, res, next) => {
    try {
      const { name } = req.params;
      // SSE: Ensure req.user._id is valid before querying, though requireAuth should handle user presence.
      if (!req.user?._id) {
        logger.warn(
          { profileName: name },
          "Attempt to fetch profile by name without authenticated user."
        );
        return res.status(401).json({ message: "Authentication required." });
      }

      const profile = await BotProfile.findOne({
        name: name,
        userId: req.user._id,
      });

      if (!profile) {
        logger.warn(
          { profileName: name, userId: req.user._id },
          "Bot profile not found by name for user."
        );
        return res.status(404).json({ message: "Bot profile not found." });
      }
      logger.info(
        { profileName: name, userId: req.user._id, profileId: profile._id },
        "Fetched bot profile by name."
      );
      res.json(profile);
    } catch (error) {
      logger.error(
        { err: error, profileName: req.params.name, userId: req.user?._id },
        "Failed to fetch bot profile by name"
      );
      next(error);
    }
  },

  /**
   * Get a specific bot profile by its ID (scoped to the authenticated user).
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  getProfileById: async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        logger.warn(
          { profileId: id, userId: req.user?._id },
          "Invalid profile ID format provided."
        );
        return res
          .status(400)
          .json({ message: "Invalid bot profile ID format." });
      }

      const profile = await BotProfile.findOne({
        _id: id,
        userId: req.user._id,
      });

      if (!profile) {
        logger.warn(
          { profileId: id, userId: req.user?._id },
          "Bot profile not found by ID for user."
        );
        return res.status(404).json({ message: "Bot profile not found." });
      }
      logger.info(
        { profileId: id, userId: req.user?._id },
        "Fetched bot profile by ID."
      );
      res.json(profile);
    } catch (error) {
      logger.error(
        { err: error, profileId: req.params.id, userId: req.user?._id },
        "Failed to fetch bot profile by ID"
      );
      next(error);
    }
  },

  /**
   * Create a new bot profile.
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  createProfile: async (req, res, next) => {
    try {
      // AD: Validation is handled by express-validator middleware in the route.
      // Here, we focus on the business logic.
      const newProfileData = {
        ...req.body, // Spread validated and sanitized data
        userId: req.user._id, // Assign to current authenticated user
        // createdAt and updatedAt are handled by Mongoose schema
      };

      // SSE/DS: Double-check for existing profile with the same name for this user,
      // though the unique index (userId, name) should prevent duplicates at DB level.
      // This provides a friendlier error message before hitting DB constraint.
      const existingProfile = await BotProfile.findOne({
        name: newProfileData.name,
        userId: req.user._id,
      });
      if (existingProfile) {
        logger.warn(
          { profileName: newProfileData.name, userId: req.user._id },
          "Attempt to create bot profile with duplicate name for user."
        );
        return res.status(409).json({
          message: `A bot profile named "${newProfileData.name}" already exists for your account.`,
        });
      }

      const profile = new BotProfile(newProfileData);
      await profile.save(); // Mongoose schema validation runs here

      logger.info(
        {
          profileName: profile.name,
          userId: req.user._id,
          profileId: profile._id,
        },
        "Bot profile created successfully."
      );
      res.status(201).json(profile); // 201 Created
    } catch (err) {
      // DS: Handle Mongoose validation errors specifically if needed, or rely on unique index error.
      if (err.name === "ValidationError") {
        logger.warn(
          { err, profileData: req.body, userId: req.user._id },
          "Bot profile creation validation error."
        );
        // Construct a more user-friendly error object from Mongoose validation errors
        const errors = Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({ message: "Validation failed.", errors });
      }
      // Unique index violation (name per user) might still occur if check above misses a race condition
      if (err.code === 11000) {
        logger.warn(
          { err, profileData: req.body, userId: req.user._id },
          "Duplicate bot profile name on create (race condition or direct DB)."
        );
        return res.status(409).json({
          message: `A bot profile named "${req.body.name}" already exists for your account.`,
        });
      }
      logger.error(
        { err, profileData: req.body, userId: req.user._id },
        "Error creating bot profile."
      );
      next(err);
    }
  },

  /**
   * Update an existing bot profile by its ID.
   * Name cannot be changed after creation.
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  updateProfileById: async (req, res, next) => {
    try {
      const { id } = req.params;
      // SSE: Name change is disallowed as per frontend note, enforce here.
      if (req.body.name) {
        // Or, if name is part of the payload but matches existing, allow it.
        // For now, strictly disallow sending 'name' in update payload if it implies change.
        // This check might be too strict if frontend sends full object.
        // Better: fetch existing, compare name, reject if different.
        // However, the frontend form disables name field in update mode.
        // So, if 'name' is in req.body for an update, it's unexpected.
        logger.warn(
          { profileId: id, userId: req.user._id, newName: req.body.name },
          "Attempt to update bot profile name, which is disallowed."
        );
        // return res.status(400).json({ message: "Bot profile name cannot be changed after creation." });
        // Let's assume frontend won't send 'name' for update if it's not changed.
        // We will simply not update it.
        delete req.body.name;
      }
      if (req.body.userId || req.body._id) {
        // Prevent changing owner or _id
        delete req.body.userId;
        delete req.body._id;
      }

      const updatedProfile = await BotProfile.findOneAndUpdate(
        { _id: id, userId: req.user._id }, // Ensure user owns the profile
        { $set: req.body, updatedAt: new Date() }, // $set updates only provided fields
        { new: true, runValidators: true, context: "query" } // Return updated doc, run schema validators
      );

      if (!updatedProfile) {
        logger.warn(
          { profileId: id, userId: req.user._id },
          "Bot profile not found for update or user mismatch."
        );
        return res.status(404).json({
          message:
            "Bot profile not found or you do not have permission to update it.",
        });
      }

      logger.info(
        { profileId: updatedProfile._id, userId: req.user._id },
        "Bot profile updated successfully."
      );
      res.json(updatedProfile);
    } catch (err) {
      if (err.name === "ValidationError") {
        logger.warn(
          {
            err,
            profileId: req.params.id,
            updateData: req.body,
            userId: req.user._id,
          },
          "Bot profile update validation error."
        );
        const errors = Object.values(err.errors).map((e) => ({
          field: e.path,
          message: e.message,
        }));
        return res.status(400).json({ message: "Validation failed.", errors });
      }
      logger.error(
        {
          err,
          profileId: req.params.id,
          updateData: req.body,
          userId: req.user?._id,
        },
        "Error updating bot profile."
      );
      next(err);
    }
  },

  /**
   * Delete a bot profile by its ID.
   * @async
   * @param {import('express').Request} req - Express request object.
   * @param {import('express').Response} res - Express response object.
   * @param {import('express').NextFunction} next - Express next middleware function.
   */
  deleteProfileById: async (req, res, next) => {
    try {
      const { id } = req.params;
      const result = await BotProfile.deleteOne({
        _id: id,
        userId: req.user._id, // Ensure user owns the profile
      });

      if (result.deletedCount === 0) {
        logger.warn(
          { profileId: id, userId: req.user._id },
          "Bot profile not found for deletion or user mismatch."
        );
        return res.status(404).json({
          message:
            "Bot profile not found or you do not have permission to delete it.",
        });
      }

      logger.info(
        { profileId: id, userId: req.user._id },
        "Bot profile deleted successfully."
      );
      res.json({ message: "Bot profile deleted successfully." });
    } catch (error) {
      logger.error(
        { err: error, profileId: req.params.id, userId: req.user?._id },
        "Error deleting bot profile."
      );
      next(error);
    }
  },
};

export default botProfileController;
