import e from "express";
import mongoose from "mongoose";

const MonthlyUsageSchema = new mongoose.Schema(
  {
    promptTokens: { type: Number, default: 0, required: true },
    completionTokens: { type: Number, default: 0, required: true },
    totalTokens: { type: Number, default: 0, required: true },
    // lastUpdated: { type: Date, default: Date.now } // Optional: if you want to track last update to this specific month's record
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: { type: String, required: true }, // Hashed password
  privlegeLevel: { type: String, enum: ["user", "admin"], default: "user" }, // User roles
  name: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },

  // Lifetime token usage
  totalLifetimePromptTokens: { type: Number, default: 0, required: true },
  totalLifetimeCompletionTokens: { type: Number, default: 0, required: true },
  totalLifetimeTokens: { type: Number, default: 0, required: true },

  // Monthly token usage history
  // Key: "YYYY-MM", Value: { promptTokens, completionTokens, totalTokens }
  monthlyTokenUsageHistory: {
    type: Map,
    of: MonthlyUsageSchema,
    default: {},
  },

  // Current quota management (optional, adapt to your needs)
  quotaTokensAllowedPerMonth: { type: Number, default: Infinity },
  quotaMonthStartDate: {
    type: Date,
    default: () => new Date(new Date().setDate(1)),
  }, // Defaults to start of current month

  lastTokenUsageUpdate: { type: Date }, // Timestamp of the last token usage event
});

// Pre-save hook to update `updatedAt`
UserSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// Static method to update token usage - consolidates logic
// This is one way; direct updates in services are also fine.
// Using this static method ensures consistency if logic becomes more complex.
UserSchema.statics.logTokenUsage = async function ({
  userId,
  promptTokens,
  completionTokens,
}) {
  if (
    !userId ||
    typeof promptTokens !== "number" ||
    promptTokens < 0 ||
    typeof completionTokens !== "number" ||
    completionTokens < 0
  ) {
    // Consider logging this error, e.g., using the logger utility
    // For now, returning null or throwing an error
    // logger.warn({ userId, promptTokens, completionTokens }, "Invalid token counts provided to User.logTokenUsage");
    throw new Error("Invalid input for logging token usage to User model.");
  }

  const totalTokens = promptTokens + completionTokens;
  const currentYearMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  // Using $inc will create the path and increment.
  // If monthlyTokenUsageHistory.YYYY-MM doesn't exist, $inc will create it and its subfields.
  const updateOperation = {
    $inc: {
      totalLifetimePromptTokens: promptTokens,
      totalLifetimeCompletionTokens: completionTokens,
      totalLifetimeTokens: totalTokens,
      [`monthlyTokenUsageHistory.${currentYearMonth}.promptTokens`]:
        promptTokens,
      [`monthlyTokenUsageHistory.${currentYearMonth}.completionTokens`]:
        completionTokens,
      [`monthlyTokenUsageHistory.${currentYearMonth}.totalTokens`]: totalTokens,
    },
    $set: {
      lastTokenUsageUpdate: new Date(),
      // If the month entry MIGHT not exist and you need to ensure its creation
      // with default values if not using $inc for all fields, this can be tricky.
      // However, since MonthlyUsageSchema has defaults, $inc should work fine to create them.
      // If you added non-numeric fields to MonthlyUsageSchema that $inc doesn't handle,
      // you might need a $setOnInsert for the monthly map key itself,
      // or a more complex update with read-modify-write (less ideal for concurrency).
      // For pure counters with defaults, $inc is robust.
    },
  };

  return this.findByIdAndUpdate(userId, updateOperation, {
    new: true,
    upsert: false, // Should not create a user if not found, user must exist
  });
};

export default mongoose.model("User", UserSchema);
