// src\routes\botProfileRoute.js
import express from "express";
import { body, param, validationResult } from "express-validator";
import botProfileController from "../controllers/botProfileController.js";
import logger from "../utils/logger.js";

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Log the body as well for validation errors to understand what was sent
    logger.warn(
      {
        errors: errors.array(),
        path: req.path,
        userId: req.user?._id,
        body: req.body,
      },
      "Validation failed for bot profile route."
    );
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// --- Validation Chains (Following BotProfileSchema) ---
const nameValidation = () =>
  body("name")
    .trim()
    .isString()
    .withMessage("Name must be a string.")
    .isLength({ min: 3, max: 100 })
    .withMessage("Name must be between 3 and 100 characters.");

const descriptionValidation = () =>
  body("description")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .withMessage("Description must be a string.")
    .isLength({ max: 500 })
    .withMessage("Description cannot exceed 500 characters.");

const identityValidation = () =>
  body("identity")
    .trim()
    .isString()
    .withMessage("Identity must be a string.")
    .notEmpty()
    .withMessage("Identity is required.");

const communicationStyleValidation = () =>
  body("communicationStyle")
    .optional()
    .trim()
    .isIn(["Formal", "Friendly", "Humorous", "Professional", "Custom"])
    .withMessage("Invalid communication style.");

const stringArrayValidation = (fieldName, itemMaxLength = 500) =>
  body(fieldName)
    .optional()
    .isArray()
    .withMessage(`${fieldName} must be an array.`)
    .custom((arr) =>
      arr.every(
        (item) =>
          typeof item === "string" &&
          item.trim().length > 0 &&
          item.length <= itemMaxLength
      )
    )
    .withMessage(
      `All items in ${fieldName} must be non-empty strings (max ${itemMaxLength} chars).`
    );

const knowledgeBaseItemsValidation = () =>
  body("knowledgeBaseItems")
    .optional()
    .isArray()
    .withMessage("Knowledge base items must be an array.")
    .custom((items) => {
      if (!items) return true;
      return items.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof item.topic === "string" &&
          item.topic.trim() !== "" &&
          item.topic.length <= 200 &&
          typeof item.content === "string" &&
          item.content.trim() !== "" &&
          item.content.length <= 2000
      );
    })
    .withMessage(
      "Each knowledge item must have non-empty 'topic' (max 200 chars) and 'content' (max 2000 chars)."
    );

const exampleResponsesValidation = () =>
  body("exampleResponses")
    .optional()
    .isArray()
    .withMessage("Example responses must be an array.")
    .custom(
      (items) =>
        !items ||
        items.every(
          (item) =>
            item &&
            typeof item === "object" &&
            (item.scenario === undefined ||
              (typeof item.scenario === "string" &&
                item.scenario.length <= 1000)) && // Allow undefined if not required by schema
            (item.response === undefined ||
              (typeof item.response === "string" &&
                item.response.length <= 2000))
        )
    )
    .withMessage(
      "Each example response, if provided, must have 'scenario' (max 1000 chars) and 'response' (max 2000 chars)."
    );

const edgeCasesValidation = () =>
  body("edgeCases")
    .optional()
    .isArray()
    .withMessage("Edge cases must be an array.")
    .custom(
      (items) =>
        !items ||
        items.every(
          (item) =>
            item &&
            typeof item === "object" &&
            (item.case === undefined ||
              (typeof item.case === "string" && item.case.length <= 1000)) &&
            (item.action === undefined ||
              (typeof item.action === "string" && item.action.length <= 1000))
        )
    )
    .withMessage(
      "Each edge case, if provided, must have 'case' (max 1000 chars) and 'action' (max 1000 chars)."
    );

const mcpServersValidation = () =>
  body("mcpServers")
    .optional()
    .isArray()
    .withMessage("MCP Servers must be an array.")
    .custom(
      (items) =>
        !items ||
        items.every(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof item.name === "string" &&
            item.name.trim() !== "" &&
            typeof item.command === "string" &&
            item.command.trim() !== "" &&
            (item.args === undefined ||
              (Array.isArray(item.args) &&
                item.args.every((arg) => typeof arg === "string"))) &&
            (item.enabled === undefined || typeof item.enabled === "boolean") // allow undefined to use schema default
        )
    )
    .withMessage(
      "Each MCP Server must have valid 'name', 'command'. 'args' (array of strings), and 'enabled' (boolean) are optional."
    );

const createProfileValidations = [
  nameValidation(),
  descriptionValidation(),
  identityValidation(),
  communicationStyleValidation(),
  body("primaryLanguage")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ min: 2, max: 10 }),
  body("secondaryLanguage")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ min: 2, max: 10 }),
  stringArrayValidation("languageRules", 1000), // Example item max length
  knowledgeBaseItemsValidation(),
  stringArrayValidation("tags", 100),
  stringArrayValidation("initialInteraction", 1000),
  stringArrayValidation("interactionGuidelines", 2000),
  exampleResponsesValidation(),
  edgeCasesValidation(),
  body("tools.name")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 100 }),
  body("tools.description")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 500 }),
  stringArrayValidation("tools.purposes", 200),
  body("privacyAndComplianceGuidelines")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 5000 }),
  mcpServersValidation(),
  body("isEnabled").optional().isBoolean().toBoolean(),
];

const updateProfileValidations = [
  descriptionValidation(),
  identityValidation().optional(),
  communicationStyleValidation(),
  body("primaryLanguage")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ min: 2, max: 10 }),
  body("secondaryLanguage")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ min: 2, max: 10 }),
  stringArrayValidation("languageRules", 1000),
  knowledgeBaseItemsValidation(),
  stringArrayValidation("tags", 100),
  stringArrayValidation("initialInteraction", 1000),
  stringArrayValidation("interactionGuidelines", 2000),
  exampleResponsesValidation(),
  edgeCasesValidation(),
  body("tools.name")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 100 }),
  body("tools.description")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 500 }),
  stringArrayValidation("tools.purposes", 200),
  body("privacyAndComplianceGuidelines")
    .optional({ checkFalsy: true })
    .trim()
    .isString()
    .isLength({ max: 5000 }),
  mcpServersValidation(),
  body("isEnabled").optional().isBoolean().toBoolean(),
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

// Routes
router.get("/", botProfileController.getAllProfilesForUser);

router.get(
  "/byName/:name",
  param("name")
    .trim()
    .notEmpty()
    .withMessage("Profile name parameter cannot be empty."),
  validate,
  botProfileController.getProfileByName
);

router.get(
  "/:id",
  param("id").isMongoId().withMessage("Invalid Profile ID format in URL."),
  validate,
  botProfileController.getProfileById
);

router.post(
  "/",
  createProfileValidations,
  validate,
  botProfileController.createProfile
);

router.put(
  "/:id",
  param("id").isMongoId().withMessage("Invalid Profile ID format in URL."),
  updateProfileValidations,
  validate,
  botProfileController.updateProfileById
);

router.delete(
  "/:id",
  param("id").isMongoId().withMessage("Invalid Profile ID format in URL."),
  validate,
  botProfileController.deleteProfileById
);

export default router;
