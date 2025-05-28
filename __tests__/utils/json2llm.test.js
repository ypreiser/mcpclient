// __tests__/utils/json2llm.test.js
import { describe, it, expect } from "vitest";
import { botProfileToNaturalLanguage } from "../../src/utils/json2llm.js"; // Adjust path if needed

describe("botProfileToNaturalLanguage", () => {
  const baseProfile = {
    _id: "60d5f1f772c5f0001f000000",
    name: "TestBot", // This should be excluded by the function
    userId: "user123", // Excluded
    identity: "I am a helpful test assistant.",
    description: "A bot for testing purposes.",
    communicationStyle: "Friendly",
    primaryLanguage: "en",
    secondaryLanguage: "es",
    languageRules: ["Be concise.", "Use emojis sparingly."],
    knowledgeBaseItems: [
      { topic: "Greetings", content: "Hello, Hola!" },
      { topic: "Farewells", content: "Goodbye, Adios!" },
    ],
    tags: ["test", "ai", "chatbot"],
    initialInteraction: ["How can I help you today?", "What's on your mind?"],
    interactionGuidelines: [
      "Always be polite.",
      "If unsure, ask for clarification.",
    ],
    exampleResponses: [
      {
        scenario: "User asks for help",
        response: "Sure, I can help with that!",
      },
      {
        scenario: "User is angry",
        response: "I understand you're frustrated.",
      },
    ],
    edgeCases: [
      { case: "User asks about my creator", action: "Say I am an AI." },
      {
        case: "User uses profanity",
        action: "Politely state I cannot process.",
      },
    ],
    tools: {
      name: "Calculator",
      description: "A simple calculator tool.",
      purposes: ["perform arithmetic", "solve equations"],
    },
    privacyAndComplianceGuidelines: "Handle all data with care.",
    mcpServers: [{ name: "server1", command: "run.sh", enabled: true }], // Excluded
    isEnabled: true, // Excluded
    createdAt: new Date(), // Excluded
    updatedAt: new Date(), // Excluded
    totalPromptTokensUsed: 100, // Excluded
  };

  it("should convert a full BotProfile document to natural language text", () => {
    const text = botProfileToNaturalLanguage(baseProfile);

    expect(text).toContain(
      "Bot Identity/Persona: I am a helpful test assistant."
    );
    expect(text).toContain("Bot Description: A bot for testing purposes.");
    expect(text).toContain("Communication Style: Friendly");
    expect(text).toContain("Primary Language: en");
    expect(text).toContain("Secondary Language: es");
    expect(text).toContain(
      "Specific Language Rules: Be concise., Use emojis sparingly."
    );
    expect(text).toContain("Knowledge Base Information:");
    expect(text).toContain("  Knowledge Snippet 1:");
    expect(text).toContain("    Topic: Greetings");
    expect(text).toContain("    Content: Hello, Hola!");
    expect(text).toContain("Relevant Tags/Keywords: test, ai, chatbot");
    expect(text).toContain(
      "Ways to Start a Conversation: How can I help you today?, What's on your mind?"
    );
    expect(text).toContain(
      "General Interaction Guidelines: Always be polite., If unsure, ask for clarification."
    );
    expect(text).toContain("Example Conversations (User asks, Bot responds):");
    expect(text).toContain("  Example 1:");
    expect(text).toContain("    Scenario: User asks for help");
    expect(text).toContain("    Response: Sure, I can help with that!");
    expect(text).toContain(
      "Handling Tricky Situations (If X happens, Bot does Y):"
    );
    expect(text).toContain("  Case 1:");
    expect(text).toContain("    Case: User asks about my creator");
    expect(text).toContain("    Action: Say I am an AI.");
    expect(text).toContain("Available Tool: Name: Calculator");
    expect(text).toContain(
      "Available Tool: Description: A simple calculator tool."
    );
    expect(text).toContain(
      "Available Tool: Purposes: perform arithmetic, solve equations"
    );
    expect(text).toContain(
      "Privacy and Compliance Notes: Handle all data with care."
    );

    // Check for excluded fields
    expect(text).not.toContain("name: TestBot"); // The 'name' field itself, not the tool name
    expect(text).not.toContain("_id:");
    expect(text).not.toContain("userId:");
    expect(text).not.toContain("mcpServers:");
    expect(text).not.toContain("isEnabled:");
  });

  it("should handle missing optional fields gracefully", () => {
    const minimalProfile = {
      identity: "Minimal bot.",
      // toObject: function() { return this; } // If it were a Mongoose doc
    };
    const text = botProfileToNaturalLanguage(minimalProfile);
    expect(text).toBe("Bot Identity/Persona: Minimal bot.");
  });

  it("should return an empty string for a completely empty profile object", () => {
    const emptyProfile = {
      // toObject: function() { return this; }
    };
    const text = botProfileToNaturalLanguage(emptyProfile);
    expect(text).toBe("");
  });

  it("should correctly format knowledgeBaseItems", () => {
    const profile = {
      identity: "KB Bot",
      knowledgeBaseItems: [
        { topic: "Topic A", content: "Content A" },
        { topic: "Topic B", content: "Content B" },
      ],
    };
    const text = botProfileToNaturalLanguage(profile);
    expect(text).toContain("Knowledge Base Information:");
    expect(text).toContain(
      "  Knowledge Snippet 1:\n    Topic: Topic A\n    Content: Content A"
    );
    expect(text).toContain(
      "  Knowledge Snippet 2:\n    Topic: Topic B\n    Content: Content B"
    );
  });

  it("should correctly format exampleResponses", () => {
    const profile = {
      identity: "Example Bot",
      exampleResponses: [{ scenario: "Scen A", response: "Resp A" }],
    };
    const text = botProfileToNaturalLanguage(profile);
    expect(text).toContain("Example Conversations (User asks, Bot responds):");
    expect(text).toContain(
      "  Example 1:\n    Scenario: Scen A\n    Response: Resp A"
    );
  });

  it("should handle empty arrays gracefully", () => {
    const profile = {
      identity: "Array Bot",
      tags: [],
      knowledgeBaseItems: [],
    };
    const text = botProfileToNaturalLanguage(profile);
    expect(text).toContain("Bot Identity/Persona: Array Bot");
    expect(text).not.toContain("Relevant Tags/Keywords:"); // Field is skipped if array is empty
    expect(text).not.toContain("Knowledge Base Information:"); // Field is skipped
  });

  it("should correctly format nested tools object", () => {
    const profile = {
      identity: "Tool Bot",
      tools: {
        name: "MyTool",
        description: "Does things.",
        purposes: ["doing", "stuff"],
      },
    };
    const text = botProfileToNaturalLanguage(profile);
    expect(text).toContain("Bot Identity/Persona: Tool Bot");
    expect(text).toContain("Available Tool: Name: MyTool");
    expect(text).toContain("Available Tool: Description: Does things.");
    expect(text).toContain("Available Tool: Purposes: doing, stuff");
  });

  it("should handle tools object with some fields missing", () => {
    const profile = {
      identity: "Partial Tool Bot",
      tools: {
        name: "MyPartialTool",
        // description is missing
        purposes: ["partial purpose"],
      },
    };
    const text = botProfileToNaturalLanguage(profile);
    expect(text).toContain("Bot Identity/Persona: Partial Tool Bot");
    expect(text).toContain("Available Tool: Name: MyPartialTool");
    expect(text).not.toContain("Available Tool: Description:");
    expect(text).toContain("Available Tool: Purposes: partial purpose");
  });

  it("should handle profile that is already a plain object (not a Mongoose doc)", () => {
    const plainProfile = { ...baseProfile }; // Simulate a lean object
    const text = botProfileToNaturalLanguage(plainProfile);
    expect(text).toContain(
      "Bot Identity/Persona: I am a helpful test assistant."
    );
    // Add one more specific check to ensure it processed
    expect(text).toContain("Communication Style: Friendly");
  });

  it("should handle a profile with null or undefined values for some fields", () => {
    const profileWithNulls = {
      identity: "Test with Nulls",
      description: null,
      primaryLanguage: undefined,
      tags: ["tag1", null, "tag2"], // nulls in arrays are tricky, current code filters them
      knowledgeBaseItems: [{ topic: "T1", content: null }], // current code skips null value
    };
    const text = botProfileToNaturalLanguage(profileWithNulls);
    expect(text).toContain("Bot Identity/Persona: Test with Nulls");
    expect(text).not.toContain("Bot Description:");
    expect(text).not.toContain("Primary Language:");
    // Current implementation of array.join(', ') might include "null" string or skip it.
    // The fieldToText for simple arrays might just join. Let's check current behavior.
    // `fieldToText` for simple arrays: `return `${displayName}: ${value.join(", ")}\n`;`
    // If `value` is `['tag1', null, 'tag2']`, `value.join(', ')` becomes `"tag1,,tag2"`.
    // This might be acceptable, or filtering nulls before join might be preferred.
    // For now, testing current behavior.
    expect(text).toContain("Relevant Tags/Keywords: tag1, , tag2"); // Current behavior

    // For knowledgeBaseItems, the inner loop `if (v !== undefined && v !== null && v !== "")`
    // will skip the `content: null`.
    expect(text).toContain("  Knowledge Snippet 1:\n    Topic: T1");
    expect(text).not.toContain("Content: null");
  });
});
