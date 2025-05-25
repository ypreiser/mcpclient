// mcpclient/controllers/userController.js
import * as userService from "../services/userService.js";

/**
 * Register a new user
 */
export async function registerUser(req, res, next) {
  try {
    const user = await userService.createUser(req.body);
    res.status(201).json({
      message: "User registered successfully.",
      userId: user._id,
      email: user.email,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get user by ID
 */
export async function getUserById(req, res, next) {
  try {
    const user = await userService.findUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/**
 * List all users
 */
export async function listUsers(req, res, next) {
  try {
    const users = await userService.listUsers();
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

/**
 * Update user by ID
 */
export async function updateUserById(req, res, next) {
  try {
    const user = await userService.updateUserById(req.params.userId, req.body);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}
