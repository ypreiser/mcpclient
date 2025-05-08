export function fieldToText(key, value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
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
  };

  // Handle arrays of objects (like exampleResponses, edgeCases)
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    typeof value[0] === "object"
  ) {
    let text = `${fieldNames[key] || key}:\n`;
    value.forEach((item, idx) => {
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
  if (typeof value === "object") {
    let text = `${fieldNames[key] || key}:\n`;
    for (const [k, v] of Object.entries(value)) {
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

export function systemPromptToNaturalLanguage(prompt) {
  let text = "";
  for (const [key, value] of Object.entries(prompt)) {
    if (key === "name" || key === "_id" || key === "__v") continue;
    text += fieldToText(key, value);
  }
  return text.trim();
}
