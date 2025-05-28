// mcpclient/utils/json2llm.js

// Human-friendly field names mapping for BotProfileSchema
const botProfileFieldNames = {
  identity: "Bot Identity/Persona",
  description: "Bot Description",
  communicationStyle: "Communication Style",
  primaryLanguage: "Primary Language",
  secondaryLanguage: "Secondary Language",
  languageRules: "Specific Language Rules",
  knowledgeBaseItems: "Knowledge Base Information", // Title for the whole section
  // Individual knowledge items will be formatted within their array
  tags: "Relevant Tags/Keywords",
  initialInteraction: "Ways to Start a Conversation",
  interactionGuidelines: "General Interaction Guidelines",
  exampleResponses: "Example Conversations (User asks, Bot responds)", // Title for section
  edgeCases: "Handling Tricky Situations (If X happens, Bot does Y)", // Title for section
  "tools.name": "Available Tool: Name", // Special handling for nested 'tools' object
  "tools.description": "Available Tool: Description",
  "tools.purposes": "Available Tool: Purposes",
  privacyAndComplianceGuidelines: "Privacy and Compliance Notes",
  // Fields to generally exclude from the AI text prompt:
  // name (bot's name, AI should infer or use identity)
  // _id, __v, userId, createdAt, updatedAt, isEnabled, isPubliclyListed
  // mcpServers (internal config)
  // token usage fields
};

function formatArrayOfObjects(items, itemTitle) {
  let text = "";
  items.forEach((item, idx) => {
    if (item === null || typeof item !== "object") return;
    text += `  ${itemTitle} ${idx + 1}:\n`;
    for (const [k, v] of Object.entries(item)) {
      if (v !== undefined && v !== null && v !== "") {
        // Simple key-value for sub-objects like scenario/response
        text += `    ${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}\n`;
      }
    }
  });
  return text;
}

function fieldToText(key, value, pathPrefix = "") {
  const fullPathKey = pathPrefix ? `${pathPrefix}.${key}` : key;

  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0 &&
      !(value instanceof Date))
  ) {
    return ""; // Skip empty or irrelevant fields
  }

  const displayName =
    botProfileFieldNames[fullPathKey] ||
    botProfileFieldNames[key] ||
    key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, " $1");

  // Handle specific complex array structures
  if (key === "knowledgeBaseItems" && Array.isArray(value)) {
    let text = `${displayName}:\n`;
    text += formatArrayOfObjects(value, "Knowledge Snippet");
    return text;
  }
  if (key === "exampleResponses" && Array.isArray(value)) {
    let text = `${displayName}:\n`;
    text += formatArrayOfObjects(value, "Example");
    return text;
  }
  if (key === "edgeCases" && Array.isArray(value)) {
    let text = `${displayName}:\n`;
    text += formatArrayOfObjects(value, "Case");
    return text;
  }

  // Handle simple arrays of strings
  if (Array.isArray(value)) {
    return `${displayName}: ${value.join(", ")}\n`;
  }

  // Handle nested 'tools' object specifically
  if (key === "tools" && typeof value === "object" && value !== null) {
    let toolText = "";
    if (value.name) toolText += fieldToText("name", value.name, "tools");
    if (value.description)
      toolText += fieldToText("description", value.description, "tools");
    if (
      value.purposes &&
      Array.isArray(value.purposes) &&
      value.purposes.length > 0
    ) {
      toolText += fieldToText("purposes", value.purposes, "tools");
    }
    return toolText; // Return concatenated tool info
  }

  // Handle simple values (strings, numbers, booleans)
  // Dates are usually not relevant for the AI prompt text unless specifically formatted.
  if (typeof value !== "object" || value instanceof Date) {
    return `${displayName}: ${value}\n`;
  }

  // Generic handling for other simple objects (if any, though BotProfile is mostly flat or specific structures)
  if (typeof value === "object" && value !== null) {
    let text = `${displayName}:\n`;
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined && v !== null && v !== "") {
        text += `  ${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}\n`;
      }
    }
    return text;
  }

  return ""; // Fallback for unhandled types
}

export function botProfileToNaturalLanguage(profileDoc) {
  let text = "";
  const profile = profileDoc.toObject ? profileDoc.toObject() : profileDoc;

  const fieldOrder = [
    // Define an order for a more structured prompt
    "identity",
    "description",
    "communicationStyle",
    "primaryLanguage",
    "secondaryLanguage",
    "languageRules",
    "initialInteraction",
    "interactionGuidelines",
    "knowledgeBaseItems",
    "exampleResponses",
    "edgeCases",
    "tags",
    "tools",
    "privacyAndComplianceGuidelines",
  ];

  const excludedFields = [
    "name",
    "_id",
    "__v",
    "userId",
    "createdAt",
    "updatedAt",
    "isEnabled",
    "isPubliclyListed",
    "mcpServers",
    "totalPromptTokensUsed",
    "totalCompletionTokensUsed",
    "totalTokensUsed",
    "lastUsedAt",
  ];

  for (const key of fieldOrder) {
    if (profile.hasOwnProperty(key) && !excludedFields.includes(key)) {
      text += fieldToText(key, profile[key]);
    }
  }

  // Add any fields not in fieldOrder but not excluded (e.g. custom fields if schema were dynamic)
  for (const [key, value] of Object.entries(profile)) {
    if (!fieldOrder.includes(key) && !excludedFields.includes(key)) {
      text += fieldToText(key, value);
    }
  }

  return text.trim();
}
