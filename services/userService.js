// mcpclient/services/userService.js
import User from "../models/userModel.js";

/**
 * Create a new user
 * @param {Object} userData
 * @returns {Promise<User>}
 */
export async function createUser(userData) {
  const user = new User(userData);
  return user.save();
}

/**
 * Find user by email
 * @param {string} email
 * @returns {Promise<User|null>}
 */
export async function findUserByEmail(email) {
  return User.findOne({ email: email.toLowerCase() });
}

/**
 * Find user by ID
 * @param {string} userId
 * @returns {Promise<User|null>}
 */
export async function findUserById(userId) {
  return User.findById(userId);
}

/**
 * Update user by ID
 * @param {string} userId
 * @param {Object} update
 * @returns {Promise<User|null>}
 */
export async function updateUserById(userId, update) {
  return User.findByIdAndUpdate(userId, update, { new: true });
}

/**
 * List all users (with optional filter)
 * @param {Object} filter
 * @returns {Promise<User[]>}
 */
export async function listUsers(filter = {}) {
  return User.find(filter);
}
