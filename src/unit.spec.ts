import { Redis } from 'ioredis';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { Redlock, Lock, ExecutionError, Settings } from './index';

// Mock all resources from ioredis
vi.mock('ioredis');

describe('Redlock Settings', () => {
  test('Default settings are applied if none are provided', () => {
    const client = new Redis();
    const redlock = new Redlock([client]);
    const defaultSettings: Readonly<Settings> = {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 100,
      automaticExtensionThreshold: 500,
      db: 0,
    };
    expect(redlock.settings.driftFactor).toBe(defaultSettings.driftFactor);
    expect(redlock.settings.retryCount).toBe(defaultSettings.retryCount);
    expect(redlock.settings.retryDelay).toBe(defaultSettings.retryDelay);
    expect(redlock.settings.retryJitter).toBe(defaultSettings.retryJitter);
    expect(redlock.settings.automaticExtensionThreshold).toBe(
      defaultSettings.automaticExtensionThreshold,
    );
    expect(redlock.settings.db).toBe(defaultSettings.db);
  });

  test.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])(
    'Valid Redis DB setting (%i) is accepted',
    (db: number) => {
      const client = new Redis();
      const redlock = new Redlock([client], { db });
      expect(redlock.settings.db).toBe(db);
    },
  );

  test('Redis DB setting defaults to 0 when not provided', () => {
    const client = new Redis();
    const redlock = new Redlock([client]);
    expect(redlock.settings.db).toBe(0);
  });

  test.each([-1, 16, 0.5, 3.1514])(
    'Redis DB defaults to 0 when value (%s) is outside of acceptable range (0-15)',
    (db: number) => {
      const client = new Redis();
      const redlock = new Redlock([client], { db });
      expect(redlock.settings.db).toBe(0);
    },
  );
});

describe('Redlock', () => {
  let redisClient: Redis;
  let redlock: Redlock;
  const defaultSettings: Partial<Settings> = {
    driftFactor: 0.01,
    retryCount: 3,
    retryDelay: 200,
    retryJitter: 100,
    automaticExtensionThreshold: 500,
  };

  beforeAll(() => {
    redisClient = new Redis();
    redlock = new Redlock([redisClient], defaultSettings);
  });

  describe('acquire()', () => {
    test('Acquire a lock successfully', async () => {
      redisClient.acquireLock = vi.fn().mockResolvedValue(1);

      const lock = await redlock.acquire(['resource1'], 1000);
      expect(lock).toBeInstanceOf(Lock);
      expect(lock.resources).toEqual(['resource1']);
      expect(lock.value).toBeTruthy();
    });

    test('Fail to acquire a lock if resource is already locked', async () => {
      redisClient.acquireLock = vi.fn().mockResolvedValue(0);

      await expect(redlock.acquire(['resource1'], 1000)).rejects.toThrow(
        'The operation was unable to achieve a quorum during its retry window.',
      );
    });

    test('Fail to acquire a lock on error', async () => {
      redisClient.acquireLock = vi.fn().mockRejectedValue(new Error());

      await expect(redlock.acquire(['resource1'], 1000)).rejects.toThrow(
        'The operation was unable to achieve a quorum during its retry window.',
      );
    });
  });

  describe('release()', () => {
    test('Release a lock successfully', async () => {
      redisClient.releaseLock = vi.fn().mockResolvedValue(1);

      const lock = new Lock(redlock, ['resource1'], 'lock_value', [], Date.now() + 1000);
      const result = await redlock.release(lock);
      expect(result.attempts.length).toBeGreaterThan(0);
    });

    test('Handle errors during release', async () => {
      redisClient.releaseLock = vi.fn().mockRejectedValue(new Error());

      const lock = new Lock(redlock, ['resource1'], 'lock_value', [], Date.now() + 1000);
      await expect(redlock.release(lock)).rejects.toThrow(
        'The operation was unable to achieve a quorum during its retry window.',
      );
    });
  });

  describe('extend()', () => {
    test('Extend a lock successfully', async () => {
      redisClient.extendLock = vi.fn().mockResolvedValue(1);

      const lock = new Lock(redlock, ['resource1'], 'lock_value', [], Date.now() + 1000);
      const extendedLock = await redlock.extend(lock, 1000);
      expect(extendedLock).toBeInstanceOf(Lock);
    });

    test('Fail to extend an expired lock', async () => {
      redisClient.extendLock = vi.fn().mockResolvedValue(0);

      const lock = new Lock(redlock, ['resource1'], 'lock_value', [], Date.now() - 1000);
      await expect(redlock.extend(lock, 1000)).rejects.toBeInstanceOf(ExecutionError);
    });
  });
});
