// mcpclient/routes/botProfileRoute.js
import express from "express";
import { body, param, query, validationResult } from "express-validator";
import botProfileController from "../controllers/botProfileController.js";
import logger from "../utils/logger.js"; // Assuming logger path

const router = express.Router();

// Middleware to handle validation results
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn(
      { errors: errors.array(), path: req.path, userId: req.user?._id },
      "Validation failed for bot profile route."
    );
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// --- Define Validation Chains ---
// LBA/SSE: Using express-validator for robust input validation and sanitization.

const nameValidation = body("name")
  .trim()
  .isString()
  .withMessage("Name must be a string.")
  .isLength({ min: 3, max: 100 })
  .withMessage("Name must be between 3 and 100 characters.");
// .escape() // Escape to prevent XSS if name is directly rendered in HTML without proper templating. Be cautious if names need special chars.

const descriptionValidation = body("description")
  .optional()
  .trim()
  .isString()
  .withMessage("Description must be a string.")
  .isLength({ max: 500 })
  .withMessage("Description cannot exceed 500 characters.");
// .escape();

const identityValidation = body("identity")
  .trim()
  .isString()
  .withMessage("Identity must be a string.")
  .isLength({ min: 1 }) // Must not be empty
  .withMessage("Identity is required.");
// .escape();

const communicationStyleValidation = body("communicationStyle")
  .optional()
  .trim()
  .isIn(["Formal", "Friendly", "Humorous", "Professional", "Custom"])
  .withMessage("Invalid communication style.");

// Basic validation for array of strings
const arrayOfStringValidation = (fieldName) =>
  body(fieldName)
    .optional()
    .isArray()
    .withMessage(`${fieldName} must be an array.`)
    .custom((arr) =>
      arr.every((item) => typeof item === "string" && item.trim().length > 0)
    )
    .withMessage(`All items in ${fieldName} must be non-empty strings.`);

// More detailed validation for complex arrays if needed (example for knowledgeBaseItems)
const knowledgeBaseItemsValidation = body("knowledgeBaseItems")
  .optional()
  .isArray()
  .withMessage("Knowledge base items must be an array.")
  .custom((items) => {
    if (!items) return true; // Optional array
    return items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof item.topic === "string" &&
        item.topic.trim() !== "" &&
        typeof item.content === "string" &&
        item.content.trim() !== ""
    );
  })
  .withMessage(
    "Each knowledge base item must have a non-empty 'topic' and 'content'."
  );

// Similar detailed validations can be created for mcpServers, exampleResponses, etc.
// For brevity, we'll use simpler ones or rely on Mongoose schema validation for deep array contents.

const createProfileValidations = [
  nameValidation,
  descriptionValidation,
  identityValidation,
  communicationStyleValidation,
  body("primaryLanguage").optional().trim().isString(),
  body("secondaryLanguage").optional().trim().isString(),
  arrayOfStringValidation("languageRules"),
  knowledgeBaseItemsValidation, // Example of more detailed array validation
  arrayOfStringValidation("tags"),
  arrayOfStringValidation("initialInteraction"),
  arrayOfStringValidation("interactionGuidelines"),
  // Add more for exampleResponses, edgeCases, tools, privacyAndComplianceGuidelines, mcpServers
  body("isEnabled").optional().isBoolean().toBoolean(),
  body("isPubliclyListed").optional().isBoolean().toBoolean(),
];

// For updates, most fields are optional. Name is disallowed from changing via controller logic.
const updateProfileValidations = [
  // param("id").isMongoId().withMessage("Invalid Profile ID format."), // If updating by ID in URL
  param("name")
    .if(
      (value, { req }) =>
        req.method === "PUT" && req.originalUrl.includes("/byName/")
    ) // If updating by name in URL
    .trim()
    .notEmpty()
    .withMessage("Profile name in URL cannot be empty."),
  descriptionValidation,
  identityValidation.optional(), // Make identity optional for PUT if not all fields required
  communicationStyleValidation,
  body("primaryLanguage").optional().trim().isString(),
  body("secondaryLanguage").optional().trim().isString(),
  arrayOfStringValidation("languageRules"),
  knowledgeBaseItemsValidation,
  arrayOfStringValidation("tags"),
  arrayOfStringValidation("initialInteraction"),
  arrayOfStringValidation("interactionGuidelines"),
  body("isEnabled").optional().isBoolean().toBoolean(),
  body("isPubliclyListed").optional().isBoolean().toBoolean(),
  // Ensure no 'name', 'userId', '_id' fields are in the body for update in a way that bypasses controller logic.
  body("name")
    .not()
    .exists()
    .withMessage("Bot profile name cannot be changed via update payload."),
  body("userId").not().exists().withMessage("User ID cannot be changed."),
  body("_id")
    .not()
    .exists()
    .withMessage("Profile ID cannot be changed via payload."),
];

// For updates by ID, do not include param('name') validator
const updateProfileValidationsById = updateProfileValidations.filter(
  (v) =>
    !(
      v &&
      v.builder &&
      v.builder.fields &&
      v.builder.fields[0] === "name" &&
      v.builder.locations &&
      v.builder.locations.includes("params")
    )
);

// --- Routes ---

/**
 * @openapi
 * /api/botprofile/user/{userId}:
 *   get:
 *     summary: Get all bot profiles for a specific user (typically the authenticated user).
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID (note middleware scopes this to authenticated user).
 *     responses:
 *       200:
 *         description: A list of bot profiles.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/BotProfile' # Simplified version for list
 *       401:
 *         description: Unauthorized.
 *       500:
 *         description: Server error.
 */
// Note: The :userId param here is a bit redundant if `requireAuth` always scopes to `req.user._id`.
// The controller `getAllProfilesForUser` already uses `req.user._id`.
// We can simplify the route to just `/api/botprofile/mine` or `/api/botprofile/`
router.get("/", botProfileController.getAllProfilesForUser); // Changed from /user/:userId

/**
 * @openapi
 * /api/botprofile/byName/{name}:
 *   get:
 *     summary: Get a bot profile by its name (scoped to authenticated user).
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: The name of the bot profile.
 *     responses:
 *       200:
 *         description: The requested bot profile.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BotProfile'
 *       401:
 *         description: Unauthorized.
 *       404:
 *         description: Bot profile not found.
 *       500:
 *         description: Server error.
 */
router.get(
  "/byName/:name",
  param("name").trim().notEmpty().withMessage("Profile name cannot be empty."),
  validate,
  botProfileController.getProfileByName
);

/**
 * @openapi
 * /api/botprofile/{id}:
 *   get:
 *     summary: Get a bot profile by its ID (scoped to authenticated user).
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: ObjectId
 *         description: The ID of the bot profile.
 *     responses:
 *       // ... similar to byName
 */
router.get(
  "/:id",
  param("id").isMongoId().withMessage("Invalid Profile ID format."),
  validate,
  botProfileController.getProfileById
);

/**
 * @openapi
 * /api/botprofile:
 *   post:
 *     summary: Create a new bot profile.
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BotProfile' # Input schema might be slightly different (e.g., no _id)
 *     responses:
 *       201:
 *         description: Bot profile created successfully.
 *       400:
 *         description: Validation error.
 *       401:
 *         description: Unauthorized.
 *       409:
 *         description: Conflict (e.g., name already exists for user).
 *       500:
 *         description: Server error.
 */
router.post(
  "/",
  createProfileValidations,
  validate,
  botProfileController.createProfile
);

/**
 * @openapi
 * /api/botprofile/{id}:
 *   put:
 *     summary: Update an existing bot profile by ID.
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: ObjectId
 *     requestBody:
 *       // ... schema for updatable fields
 *     responses:
 *       // ...
 */
// LBA: Standardizing on ID for updates and deletes is generally more robust than name.
// router.put(
//   "/:id",
//   param("id").isMongoId().withMessage("Invalid Profile ID format."),
//   ...updateProfileValidationsById,
//   validate,
//   botProfileController.updateProfileById
// );

/**
 * @openapi
 * /api/botprofile/{id}:
 *   delete:
 *     summary: Delete a bot profile by ID.
 *     tags: [BotProfile]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: ObjectId
 *     responses:
 *       // ...
 */
router.delete(
  "/:id",
  param("id").isMongoId().withMessage("Invalid Profile ID format."),
  validate,
  botProfileController.deleteProfileById
);

export default router;
