import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createUser,
  findUserByEmail,
  findUserById,
  updateUserById,
  listUsers,
} from "../../src/services/userService.js";
import User from "../../src/models/userModel.js";

// Mock the User model
vi.mock("../../src/models/userModel.js", () => {
  const mockUser = vi.fn();
  mockUser.prototype.save = vi.fn();
  mockUser.findOne = vi.fn();
  mockUser.findById = vi.fn();
  mockUser.findByIdAndUpdate = vi.fn();
  mockUser.find = vi.fn();
  return { default: mockUser };
});

describe("userService", () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  describe("createUser", () => {
    it("should create a new user successfully", async () => {
      const mockSavedUser = {
        id: "mockId",
        email: "test@example.com",
        name: "Test User",
      };

      // Setup the save mock to return our expected data
      User.prototype.save.mockResolvedValueOnce(mockSavedUser);

      const userData = {
        email: "test@example.com",
        password: "hashedPassword123",
        name: "Test User",
      };

      const result = await createUser(userData);

      expect(result).toEqual({
        id: "mockId",
        email: "test@example.com",
        name: "Test User",
      });
      expect(User.prototype.save).toHaveBeenCalledTimes(1);
    });
    it("should throw an error if user creation fails", async () => {
      const error = new Error("Failed to create user");
      User.prototype.save.mockRejectedValueOnce(error);

      const userData = {
        email: "test@example.com",
        password: "hashedPassword123",
      };

      await expect(createUser(userData)).rejects.toThrow(
        "Failed to create user"
      );
    });
  });

  describe("findUserByEmail", () => {
    it("should find a user by email successfully", async () => {
      const mockUser = {
        id: "mockId",
        email: "test@example.com",
        name: "Test User",
      };

      User.findOne.mockResolvedValue(mockUser);

      const result = await findUserByEmail("test@example.com");

      expect(result).toEqual(mockUser);
      expect(User.findOne).toHaveBeenCalledWith({ email: "test@example.com" });
    });

    it("should return null if user not found", async () => {
      User.findOne.mockResolvedValue(null);

      const result = await findUserByEmail("nonexistent@example.com");

      expect(result).toBeNull();
      expect(User.findOne).toHaveBeenCalledWith({
        email: "nonexistent@example.com",
      });
    });

    it("should convert email to lowercase before querying", async () => {
      const mockUser = {
        id: "mockId",
        email: "test@example.com",
        name: "Test User",
      };

      User.findOne.mockResolvedValue(mockUser);

      await findUserByEmail("TEST@EXAMPLE.COM");

      expect(User.findOne).toHaveBeenCalledWith({ email: "test@example.com" });
    });
  });

  describe("findUserById", () => {
    it("should find a user by ID successfully", async () => {
      const mockUser = {
        id: "mockId",
        email: "test@example.com",
        name: "Test User",
      };

      User.findById.mockResolvedValue(mockUser);

      const result = await findUserById("mockId");

      expect(result).toEqual(mockUser);
      expect(User.findById).toHaveBeenCalledWith("mockId");
    });

    it("should return null if user not found", async () => {
      User.findById.mockResolvedValue(null);

      const result = await findUserById("nonexistentId");

      expect(result).toBeNull();
      expect(User.findById).toHaveBeenCalledWith("nonexistentId");
    });
  });

  describe("updateUserById", () => {
    it("should update a user successfully", async () => {
      const mockUpdatedUser = {
        id: "mockId",
        email: "test@example.com",
        name: "Updated Name",
      };

      User.findByIdAndUpdate.mockResolvedValue(mockUpdatedUser);

      const update = { name: "Updated Name" };
      const result = await updateUserById("mockId", update);

      expect(result).toEqual(mockUpdatedUser);
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith("mockId", update, {
        new: true,
      });
    });

    it("should return null if user not found", async () => {
      User.findByIdAndUpdate.mockResolvedValue(null);

      const update = { name: "Updated Name" };
      const result = await updateUserById("nonexistentId", update);

      expect(result).toBeNull();
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        "nonexistentId",
        update,
        { new: true }
      );
    });
  });

  describe("listUsers", () => {
    it("should list all users when no filter is provided", async () => {
      const mockUsers = [
        { id: "1", email: "user1@example.com" },
        { id: "2", email: "user2@example.com" },
      ];

      User.find.mockResolvedValue(mockUsers);

      const result = await listUsers();

      expect(result).toEqual(mockUsers);
      expect(User.find).toHaveBeenCalledWith({});
    });

    it("should list users with applied filter", async () => {
      const mockUsers = [
        { id: "1", email: "user1@example.com", privlegeLevel: "admin" },
      ];

      User.find.mockResolvedValue(mockUsers);

      const filter = { privlegeLevel: "admin" };
      const result = await listUsers(filter);

      expect(result).toEqual(mockUsers);
      expect(User.find).toHaveBeenCalledWith(filter);
    });

    it("should return empty array if no users found", async () => {
      User.find.mockResolvedValue([]);

      const result = await listUsers({ privlegeLevel: "nonexistent" });

      expect(result).toEqual([]);
      expect(User.find).toHaveBeenCalledWith({ privlegeLevel: "nonexistent" });
    });
  });
});
