//mcpclient/utils/json2llm.js
export function fieldToText(key, value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  ) {
    return "";
  }

  // Human-friendly field names
  const fieldNames = {
    identity: "Identity",
    primaryLanguage: "Primary language",
    secondaryLanguage: "Secondary language",
    languageRules: "Language rules",
    storeName: "Store name",
    storeAddress: "Store address",
    storePhone: "Store phone",
    storeEmail: "Store email",
    openingHours: "Opening hours",
    availableCategories: "Available categories",
    returnPolicy: "Return policy",
    warrantyPolicy: "Warranty policy",
    initialInteraction: "Initial interaction phrases",
    customerServiceGuidelines: "Customer service guidelines",
    exampleResponses: "Example responses",
    edgeCases: "Edge cases",
    tools: "Tools",
    privacyAndComplianceGuidelines: "Privacy and compliance guidelines",
    mcpServers: "MCP Servers Configuration (for internal use, not for AI)", // MCP servers are not usually for the AI prompt
  };

  // Handle arrays of objects (like exampleResponses, edgeCases)
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === "object" &&
    value[0] !== null
  ) {
    let text = `${fieldNames[key] || key}:\n`;
    value.forEach((item, idx) => {
      if (item === null) return; // Skip null items in array
      text += `  ${idx + 1}. `;
      text += Object.entries(item)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      text += "\n";
    });
    return text;
  }

  // Handle arrays of strings
  if (Array.isArray(value)) {
    return `${fieldNames[key] || key}: ${value.join(", ")}\n`;
  }

  // Handle nested objects (like openingHours, tools)
  if (typeof value === "object" && value !== null) {
    let text = `${fieldNames[key] || key}:\n`;
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue; // Skip undefined/null properties
      if (Array.isArray(v)) {
        text += `  ${k}: ${v.join(", ")}\n`;
      } else {
        text += `  ${k}: ${v}\n`;
      }
    }
    return text;
  }

  // Handle simple values
  return `${fieldNames[key] || key}: ${value}\n`;
}

export function systemPromptToNaturalLanguage(promptDoc) {
  let text = "";
  // Ensure promptDoc is a plain object if it's a Mongoose document
  const prompt = promptDoc.toObject ? promptDoc.toObject() : promptDoc;

  for (const [key, value] of Object.entries(prompt)) {
    // Exclude internal fields and mcpServers from the AI-facing prompt text
    if (
      key === "name" ||
      key === "_id" ||
      key === "__v" ||
      key === "updatedAt" ||
      key === "mcpServers"
    )
      continue;
    text += fieldToText(key, value);
  }
  return text.trim();
}
