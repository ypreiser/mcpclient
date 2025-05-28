// __tests__/models/whatsAppConnectionModel.test.js
import mongoose from 'mongoose';
import WhatsAppConnection from '../../src/models/whatsAppConnectionModel.js';

let testUserId;
let testBotProfileId;

// Helper to create a valid ObjectId for tests
const createObjectId = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  testUserId = createObjectId();
  testBotProfileId = createObjectId();
});

afterAll(async () => {
});

beforeEach(async () => {
  // Clear the WhatsAppConnection collection before each test
  await WhatsAppConnection.deleteMany({});
});

describe('WhatsAppConnection Model', () => {
  const getValidConnectionData = () => ({
    connectionName: 'TestConnection',
    botProfileId: testBotProfileId,
    userId: testUserId,
  });

  it('should create and save a WhatsAppConnection successfully', async () => {
    const validConnectionData = getValidConnectionData();
    const connection = new WhatsAppConnection(validConnectionData);
    const savedConnection = await connection.save();

    expect(savedConnection._id).toBeDefined();
    expect(savedConnection.connectionName).toBe(validConnectionData.connectionName);
    expect(savedConnection.botProfileId.toString()).toBe(testBotProfileId.toString());
    expect(savedConnection.userId.toString()).toBe(testUserId.toString());
    expect(savedConnection.autoReconnect).toBe(true); // Default
    expect(savedConnection.lastKnownStatus).toBe('unknown'); // Default
    expect(savedConnection.phoneNumber).toBeNull(); // Default
    expect(savedConnection.createdAt).toBeDefined();
    expect(savedConnection.updatedAt).toBeDefined();
  });

  // Test required fields
  ['connectionName', 'botProfileId', 'userId'].forEach((field) => {
    it(`should fail if ${field} is missing`, async () => {
      const data = { ...getValidConnectionData() };
      delete data[field];
      const connection = new WhatsAppConnection(data);
      let err;
      try {
        await connection.save();
      } catch (error) {
        err = error;
      }
      expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
      expect(err.errors[field]).toBeDefined();
    });
  });

  // Test connectionName length validations
  it('should fail if connectionName is too short', async () => {
    const connection = new WhatsAppConnection({ ...getValidConnectionData(), connectionName: 'ab' });
    let err;
    try {
      await connection.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(err.errors.connectionName).toBeDefined();
    expect(err.errors.connectionName.message).toBe('Connection name must be at least 3 characters.');
  });

  it('should fail if connectionName is too long', async () => {
    const connection = new WhatsAppConnection({ ...getValidConnectionData(), connectionName: 'a'.repeat(101) });
    let err;
    try {
      await connection.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(err.errors.connectionName).toBeDefined();
    expect(err.errors.connectionName.message).toBe('Connection name cannot exceed 100 characters.');
  });

  // Test lastKnownStatus enum
  it('should fail if lastKnownStatus is not in enum', async () => {
    const connection = new WhatsAppConnection({ ...getValidConnectionData(), lastKnownStatus: 'invalid_status' });
    let err;
    try {
      await connection.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
    expect(err.errors.lastKnownStatus).toBeDefined();
  });

  it('should trim connectionName and phoneNumber', async () => {
    const connection = new WhatsAppConnection({
      ...getValidConnectionData(),
      connectionName: '  Trimmed Name  ',
      phoneNumber: '  12345  ',
    });
    const savedConnection = await connection.save();
    expect(savedConnection.connectionName).toBe('Trimmed Name');
    expect(savedConnection.phoneNumber).toBe('12345');
  });

  // Test compound unique index (userId, connectionName)
  it('should fail to save a duplicate connectionName for the same userId', async () => {
    const validData = getValidConnectionData();
    const connection1 = new WhatsAppConnection(validData);
    await connection1.save();

    const connection2 = new WhatsAppConnection(validData); // Same data
    let err;
    try {
      await connection2.save();
    } catch (error) {
      err = error;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(11000); // MongoDB duplicate key error code
  });

  it('should allow same connectionName for different userIds', async () => {
    const validData = getValidConnectionData();
    const connection1 = new WhatsAppConnection(validData);
    await connection1.save();

    const differentUserId = createObjectId();
    const connection2Data = {
      ...validData,
      userId: differentUserId,
    };
    const connection2 = new WhatsAppConnection(connection2Data);
    const savedConnection2 = await connection2.save();
    expect(savedConnection2._id).toBeDefined();
    expect(savedConnection2.connectionName).toBe(validData.connectionName);
    expect(savedConnection2.userId.toString()).toBe(differentUserId.toString());
  });

  // Test default values are set
  it('should set default for autoReconnect', async () => {
    const data = getValidConnectionData();
    const connection = new WhatsAppConnection({ ...data, autoReconnect: undefined }); // Explicitly undefined
    const savedConnection = await connection.save();
    expect(savedConnection.autoReconnect).toBe(true);
  });

  it('should set default for lastKnownStatus', async () => {
    const data = getValidConnectionData();
    const connection = new WhatsAppConnection({ ...data, lastKnownStatus: undefined }); // Explicitly undefined
    const savedConnection = await connection.save();
    expect(savedConnection.lastKnownStatus).toBe('unknown');
  });

  it('should set default for phoneNumber', async () => {
    const data = getValidConnectionData();
    const connection = new WhatsAppConnection({ ...data, phoneNumber: undefined }); // Explicitly undefined
    const savedConnection = await connection.save();
    expect(savedConnection.phoneNumber).toBeNull();
  });

  // Test timestamps
  it('should have createdAt and updatedAt timestamps', async () => {
    const connection = new WhatsAppConnection(getValidConnectionData());
    const savedConnection = await connection.save();
    expect(savedConnection.createdAt).toBeInstanceOf(Date);
    expect(savedConnection.updatedAt).toBeInstanceOf(Date);

    const initialUpdatedAt = savedConnection.updatedAt;
    // Ensure a change that would trigger timestamp update
    savedConnection.lastKnownStatus = 'connected';
    // Optional: add a small delay if updates are too fast for clock resolution
    // await new Promise(resolve => setTimeout(resolve, 10)); 
    const updatedConnection = await savedConnection.save();
    expect(updatedConnection.updatedAt.getTime()).toBeGreaterThanOrEqual(initialUpdatedAt.getTime());
    // If a delay is added, this could be .toBeGreaterThan()
  });
});
