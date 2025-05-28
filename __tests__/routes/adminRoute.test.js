// __tests__/routes/adminRoute.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import adminRoute from '../../src/routes/adminRoute.js'; // Adjust path as necessary

// Mock dependencies
vi.mock('../../src/models/userModel.js', () => ({
  default: {
    find: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

vi.mock('../../src/models/botProfileModel.js', () => ({
  default: {
    find: vi.fn(),
  },
}));

// Mock authRoute middleware
const mockRequireAuth = vi.fn((req, res, next) => next());
const mockUser = {
  _id: 'adminUserId',
  privlegeLevel: 'admin',
  // ... other user properties if needed by requireAuth or the routes
};

vi.mock('../../src/routes/authRoute.js', () => ({
  requireAuth: (req, res, next) => {
    // Simulate attaching a user object by requireAuth
    // This can be controlled per test by modifying mockUserObject
    if (global.mockUserObject) {
      req.user = global.mockUserObject;
    }
    return mockRequireAuth(req, res, next);
  },
}));

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  // Default mock user for tests, can be overridden in specific tests
  // This ensures req.user is available for requireAdmin middleware
  if (!req.user && global.mockUserObject !== null) { // if mockUserObject is null, it means we want to test unauthenticated
    req.user = global.mockUserObject || { _id: 'testUserId', privlegeLevel: 'user' };
  }
  next();
});
app.use('/api/admin', adminRoute);

// Import User model for mocking specific implementations if needed later
import User from '../../src/models/userModel.js';
// Import BotProfile model for mocking
import BotProfile from '../../src/models/botProfileModel.js';

describe('Admin Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to admin user for most tests, can be overridden
    global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' }; 
  });

  afterEach(() => {
    delete global.mockUserObject;
  });

  describe('requireAdmin middleware (tested via route access)', () => {
    it('should allow access if user is admin', async () => {
      global.mockUserObject = { _id: 'adminUser', privlegeLevel: 'admin' };
      User.find.mockResolvedValueOnce([]); // Mock User.find for the /users route
      const response = await request(app).get('/api/admin/users');
      // If requireAdmin passes, it won't return 403. The actual status depends on the route handler.
      expect(response.status).not.toBe(403);
      expect(response.status).toBe(200); // Assuming /users route is successful
    });

    it('should return 403 if user is not admin', async () => {
      global.mockUserObject = { _id: 'normalUser', privlegeLevel: 'user' };
      const response = await request(app).get('/api/admin/users');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });

    it('should return 403 if no user is present on request (e.g., token invalid/expired)', async () => {
      global.mockUserObject = null; // Simulate no user attached by requireAuth
      const response = await request(app).get('/api/admin/users');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });
  });

  describe('GET /api/admin/users', () => {
    it('should return 200 and list of users if admin', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const mockUsers = [
        { email: 'user1@example.com', name: 'User One' },
        { email: 'user2@example.com', name: 'User Two' },
      ];
      User.find.mockResolvedValue(mockUsers);

      const response = await request(app).get('/api/admin/users');

      expect(response.status).toBe(200);
      expect(response.body.users).toEqual(mockUsers);
      expect(User.find).toHaveBeenCalledWith(
        {},
        'email name createdAt totalLifetimePromptTokens totalLifetimeCompletionTokens totalLifetimeTokens monthlyTokenUsageHistory quotaTokensAllowedPerMonth quotaMonthStartDate lastTokenUsageUpdate privlegeLevel'
      );
    });

    it('should return 403 if user is not admin', async () => {
      global.mockUserObject = { _id: 'user123', privlegeLevel: 'user' };
      const response = await request(app).get('/api/admin/users');
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });

    it('should return 500 if database query fails', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      User.find.mockRejectedValue(new Error('DB error'));

      const response = await request(app).get('/api/admin/users');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to fetch users.');
    });
  });

  describe('GET /api/admin/user/:id/profiles', () => {
    const userId = 'testUserId123';

    it('should return 200 and list of profiles for a user if admin', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const mockProfiles = [
        { name: 'Profile 1', botType: 'basic' },
        { name: 'Profile 2', botType: 'advanced' },
      ];
      BotProfile.find.mockResolvedValue(mockProfiles);

      const response = await request(app).get(`/api/admin/user/${userId}/profiles`);

      expect(response.status).toBe(200);
      expect(response.body.profiles).toEqual(mockProfiles);
      expect(BotProfile.find).toHaveBeenCalledWith({ userId });
    });

    it('should return 403 if user is not admin', async () => {
      global.mockUserObject = { _id: 'user123', privlegeLevel: 'user' };
      const response = await request(app).get(`/api/admin/user/${userId}/profiles`);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });

    it('should return 500 if database query fails', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      BotProfile.find.mockRejectedValue(new Error('DB error fetching profiles'));

      const response = await request(app).get(`/api/admin/user/${userId}/profiles`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to fetch profiles.');
    });
  });

  describe('GET /api/admin/user/:id', () => {
    const targetUserId = 'targetUser123';

    it('should return 200 and user details if admin and user exists', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const mockUser = { _id: targetUserId, email: 'target@example.com', name: 'Target User' };
      const mockSelectFnGet = vi.fn().mockResolvedValue(mockUser);
      User.findById.mockReturnValueOnce({ select: mockSelectFnGet });

      const response = await request(app).get(`/api/admin/user/${targetUserId}`);

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual(mockUser);
      expect(User.findById).toHaveBeenCalledWith(targetUserId);
      expect(mockSelectFnGet).toHaveBeenCalledWith(
        'email name createdAt totalLifetimePromptTokens totalLifetimeCompletionTokens totalLifetimeTokens monthlyTokenUsageHistory quotaTokensAllowedPerMonth quotaMonthStartDate lastTokenUsageUpdate privlegeLevel'
      );
    });

    it('should return 404 if user not found', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      User.findById.mockReturnValueOnce({ select: vi.fn().mockResolvedValue(null) });

      const response = await request(app).get(`/api/admin/user/${targetUserId}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('User not found.');
    });

    it('should return 403 if requesting user is not admin', async () => {
      global.mockUserObject = { _id: 'user123', privlegeLevel: 'user' };
      const response = await request(app).get(`/api/admin/user/${targetUserId}`);
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });

    it('should return 500 if database query fails', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      User.findById.mockReturnValueOnce({ select: vi.fn().mockRejectedValue(new Error('DB error')) });

      const response = await request(app).get(`/api/admin/user/${targetUserId}`);

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to fetch user.');
    });
  });

  describe('PATCH /api/admin/user/:id/privilege', () => {
    const targetUserId = 'targetUserToUpdate123';

    it('should return 200 and updated user privilege if admin', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const updatedUser = { _id: targetUserId, email: 'updated@example.com', privlegeLevel: 'admin' };
      const mockSelectFnPatch = vi.fn().mockResolvedValue(updatedUser);
      User.findByIdAndUpdate.mockReturnValueOnce({ select: mockSelectFnPatch });

      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({ privlegeLevel: 'admin' });

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual(updatedUser);
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        targetUserId,
        { privlegeLevel: 'admin' },
        { new: true, runValidators: true }
      );
      expect(mockSelectFnPatch).toHaveBeenCalledWith('email name privlegeLevel');
    });

    it('should return 400 if privilege level is invalid', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({ privlegeLevel: 'superadmin' }); // Invalid level

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid privilege level.');
    });

    it('should return 400 if privilege level is missing', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({}); // Missing privlegeLevel

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid privilege level.');
    });

    it('should return 404 if user to update is not found', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      User.findByIdAndUpdate.mockReturnValueOnce({ select: vi.fn().mockResolvedValue(null) });

      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({ privlegeLevel: 'user' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('User not found.');
    });

    it('should return 403 if requesting user is not admin', async () => {
      global.mockUserObject = { _id: 'user123', privlegeLevel: 'user' };
      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({ privlegeLevel: 'admin' });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Admin access required.');
    });

    it('should return 500 if database update fails', async () => {
      global.mockUserObject = { _id: 'admin123', privlegeLevel: 'admin' };
      User.findByIdAndUpdate.mockReturnValueOnce({ select: vi.fn().mockRejectedValue(new Error('DB update error')) });

      const response = await request(app)
        .patch(`/api/admin/user/${targetUserId}/privilege`)
        .send({ privlegeLevel: 'user' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to update privilege.');
    });
  });

});
