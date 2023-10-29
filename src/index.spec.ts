import Redis, { Cluster } from 'ioredis';
import { beforeEach, describe, expect, test } from 'vitest';

import { ExecutionError, Redlock, ResourceLockedError } from './index';

async function waitForCluster(redis: Cluster): Promise<void> {
  async function checkIsReady(): Promise<boolean> {
    return (await redis.info()).match(/^cluster_state:(.+)$/m)?.[1] === 'ok';
  }

  let isReady = await checkIsReady();
  while (!isReady) {
    console.log('Waiting for cluster to be ready...');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isReady = await checkIsReady();
  }

  async function checkIsWritable(): Promise<boolean> {
    try {
      return ((await redis.set('isWritable', 'true')) as string) === 'OK';
    } catch (error) {
      console.error(`Cluster unable to receive writes: ${error}`);
      return false;
    }
  }

  let isWritable = await checkIsWritable();
  while (!isWritable) {
    console.log('Waiting for cluster to be writable...');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    isWritable = await checkIsWritable();
  }
}

function is<T>(actual: T, expected: T, message?: string): void {
  expect(actual, message).toBe(expected);
}

describe.each([
  { type: 'instance' },
  // TODO fix cluster testing
  // { type: 'cluster' },
])('$type', ({ type }) => {
  const redis =
    type === 'instance'
      ? new Redis({ host: 'redis-single-instance' })
      : new Cluster([{ host: 'redis-single-cluster-1' }]);

  beforeEach(async () => {
    await (redis instanceof Cluster && redis.isCluster ? waitForCluster(redis) : null);
    await redis.keys('*').then((keys) => (keys?.length ? redis.del(keys) : null));
  });

  test(`${type} - refuses to use a non-integer duration`, async () => {
    try {
      const redlock = new Redlock([redis]);
      const duration = Number.MAX_SAFE_INTEGER / 10;

      // Acquire a lock.
      await redlock.acquire(['{redlock}float'], duration);

      expect.fail('Expected the function to throw.');
    } catch (error) {
      expect((error as Error).message).toBe('Duration must be an integer value in milliseconds.');
    }
  });

  test(`${type} - acquires, extends, and releases a single lock`, async () => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    let lock = await redlock.acquire(['{redlock}a'], duration);
    expect(await redis.get('{redlock}a'), 'The lock value was incorrect.').toBe(lock.value);
    expect(
      Math.floor((await redis.pttl('{redlock}a')) / 200),
      'The lock expiration was off by more than 200ms',
    ).toBe(Math.floor(duration / 200));

    // Extend the lock.
    lock = await lock.extend(3 * duration);
    expect(await redis.get('{redlock}a'), 'The lock value was incorrect.').toBe(lock.value);
    expect(
      Math.floor((await redis.pttl('{redlock}a')) / 200),
      'The lock expiration was off by more than 200ms',
    ).toBe(Math.floor((3 * duration) / 200));

    // Release the lock.
    await lock.release();
    expect(await redis.get('{redlock}a')).toBeNull();
  });

  test(`${type} - acquires, extends, and releases a multi-resource lock`, async () => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    let lock = await redlock.acquire(['{redlock}a1', '{redlock}a2'], duration);
    is(await redis.get('{redlock}a1'), lock.value, 'The lock value was incorrect.');
    is(await redis.get('{redlock}a2'), lock.value, 'The lock value was incorrect.');
    is(
      Math.floor((await redis.pttl('{redlock}a1')) / 200),
      Math.floor(duration / 200),
      'The lock expiration was off by more than 200ms',
    );
    is(
      Math.floor((await redis.pttl('{redlock}a2')) / 200),
      Math.floor(duration / 200),
      'The lock expiration was off by more than 200ms',
    );

    // Extend the lock.
    lock = await lock.extend(3 * duration);
    is(await redis.get('{redlock}a1'), lock.value, 'The lock value was incorrect.');
    is(await redis.get('{redlock}a2'), lock.value, 'The lock value was incorrect.');
    is(
      Math.floor((await redis.pttl('{redlock}a1')) / 200),
      Math.floor((3 * duration) / 200),
      'The lock expiration was off by more than 200ms',
    );
    is(
      Math.floor((await redis.pttl('{redlock}a2')) / 200),
      Math.floor((3 * duration) / 200),
      'The lock expiration was off by more than 200ms',
    );

    // Release the lock.
    await lock.release();
    is(await redis.get('{redlock}a1'), null);
    is(await redis.get('{redlock}a2'), null);
  });

  test(`${type} - locks fail when redis is unreachable`, async () => {
    const redis = new Redis({
      host: '127.0.0.1',
      port: 6380,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      retryStrategy: () => null,
      reconnectOnError: () => false,
    });

    redis.on('error', () => {
      // ignore redis-generated errors
    });

    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);
    try {
      await redlock.acquire(['{redlock}b'], duration);
      throw new Error('This lock should not be acquired.');
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      is(
        error.attempts.length,
        11,
        'A failed acquisition must have the configured number of retries.',
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        is(e.status, 'fulfilled');
        if (e.status === 'fulfilled') {
          for (const v of e.value?.votesAgainst?.values() || []) {
            is(v.message, 'Connection is closed.');
          }
        }
      }
    }
  });

  test(`${type} - locks automatically expire`, async () => {
    const redlock = new Redlock([redis]);

    const duration = 200;

    // Acquire a lock.
    const lock = await redlock.acquire(['{redlock}d'], duration);
    is(await redis.get('{redlock}d'), lock.value, 'The lock value was incorrect.');

    // Wait until the lock expires.
    await new Promise((resolve) => setTimeout(resolve, 300, undefined));

    // Attempt to acquire another lock on the same resource.
    const lock2 = await redlock.acquire(['{redlock}d'], duration);
    is(await redis.get('{redlock}d'), lock2.value, 'The lock value was incorrect.');

    // Release the lock.
    await lock2.release();
    is(await redis.get('{redlock}d'), null);
  });

  test(`${type} - individual locks are exclusive`, async () => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    const lock = await redlock.acquire(['{redlock}c'], duration);
    is(await redis.get('{redlock}c'), lock.value, 'The lock value was incorrect.');
    is(
      Math.floor((await redis.pttl('{redlock}c')) / 200),
      Math.floor(duration / 200),
      'The lock expiration was off by more than 200ms',
    );

    // Attempt to acquire another lock on the same resource.
    try {
      await redlock.acquire(['{redlock}c'], duration);
      throw new Error('This lock should not be acquired.');
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      is(
        error.attempts.length,
        11,
        'A failed acquisition must have the configured number of retries.',
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        is(e.status, 'fulfilled');
        if (e.status === 'fulfilled') {
          for (const v of e.value?.votesAgainst?.values() || []) {
            expect(v, 'The error must be a ResourceLockedError.').toBeInstanceOf(
              ResourceLockedError,
            );
          }
        }
      }
    }

    // Release the lock.
    await lock.release();
    is(await redis.get('{redlock}c'), null);
  });

  test(`${type} - overlapping multi-locks are exclusive`, async () => {
    const redlock = new Redlock([redis]);

    const duration = Math.floor(Number.MAX_SAFE_INTEGER / 10);

    // Acquire a lock.
    const lock = await redlock.acquire(['{redlock}c1', '{redlock}c2'], duration);
    is(await redis.get('{redlock}c1'), lock.value, 'The lock value was incorrect.');
    is(await redis.get('{redlock}c2'), lock.value, 'The lock value was incorrect.');
    is(
      Math.floor((await redis.pttl('{redlock}c1')) / 200),
      Math.floor(duration / 200),
      'The lock expiration was off by more than 200ms',
    );
    is(
      Math.floor((await redis.pttl('{redlock}c2')) / 200),
      Math.floor(duration / 200),
      'The lock expiration was off by more than 200ms',
    );

    // Attempt to acquire another lock with overlapping resources
    try {
      await redlock.acquire(['{redlock}c2', '{redlock}c3'], duration);
      throw new Error('This lock should not be acquired.');
    } catch (error) {
      if (!(error instanceof ExecutionError)) {
        throw error;
      }

      is(
        await redis.get('{redlock}c1'),
        lock.value,
        'The original lock value must not be changed.',
      );
      is(
        await redis.get('{redlock}c2'),
        lock.value,
        'The original lock value must not be changed.',
      );
      is(await redis.get('{redlock}c3'), null, 'The new resource must remain unlocked.');

      is(
        error.attempts.length,
        11,
        'A failed acquisition must have the configured number of retries.',
      );

      for (const e of await Promise.allSettled(error.attempts)) {
        is(e.status, 'fulfilled');
        if (e.status === 'fulfilled') {
          for (const v of e.value?.votesAgainst?.values() || []) {
            expect(v, 'The error must be a ResourceLockedError.').toBeInstanceOf(
              ResourceLockedError,
            );
          }
        }
      }
    }

    // Release the lock.
    await lock.release();
    is(await redis.get('{redlock}c1'), null);
    is(await redis.get('{redlock}c2'), null);
    is(await redis.get('{redlock}c3'), null);
  });

  test(`${type} - the \`using\` helper acquires, extends, and releases locks`, async () => {
    const redlock = new Redlock([redis]);

    const duration = 500;

    const valueP: Promise<string | null> = redlock.using(
      ['{redlock}x'],
      duration,
      {
        automaticExtensionThreshold: 200,
      },
      async (signal) => {
        const lockValue = await redis.get('{redlock}x');
        expect(typeof lockValue, 'The lock value was not correctly acquired.').toBe('string');

        // Wait to ensure that the lock is extended
        await new Promise((resolve) => setTimeout(resolve, 700, undefined));

        is(signal.aborted, false, 'The signal must not be aborted.');
        is(signal.error, undefined, 'The signal must not have an error.');

        is(await redis.get('{redlock}x'), lockValue, 'The lock value should not have changed.');

        return lockValue;
      },
    );

    await valueP;

    is(await redis.get('{redlock}x'), null, 'The lock was not released.');
  });

  test(`${type} - the \`using\` helper is exclusive`, async () => {
    const redlock = new Redlock([redis]);

    const duration = 500;

    let locked = false;
    const [lock1, lock2] = await Promise.all([
      await redlock.using(
        ['{redlock}y'],
        duration,
        {
          automaticExtensionThreshold: 200,
        },
        async (signal) => {
          is(locked, false, 'The resource must not already be locked.');
          locked = true;

          const lockValue = await redis.get('{redlock}y');
          expect(typeof lockValue === 'string', 'The lock value was not correctly acquired.');

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 700, undefined));

          is(signal.error, undefined, 'The signal must not have an error.');
          is(signal.aborted, false, 'The signal must not be aborted.');

          is(await redis.get('{redlock}y'), lockValue, 'The lock value should not have changed.');

          locked = false;
          return lockValue;
        },
      ),
      await redlock.using(
        ['{redlock}y'],
        duration,
        {
          automaticExtensionThreshold: 200,
        },
        async (signal) => {
          is(locked, false, 'The resource must not already be locked.');
          locked = true;

          const lockValue = await redis.get('{redlock}y');
          expect(typeof lockValue === 'string', 'The lock value was not correctly acquired.');

          // Wait to ensure that the lock is extended
          await new Promise((resolve) => setTimeout(resolve, 700, undefined));

          is(signal.error, undefined, 'The signal must not have an error.');
          is(signal.aborted, false, 'The signal must not be aborted.');

          is(await redis.get('{redlock}y'), lockValue, 'The lock value should not have changed.');

          locked = false;
          return lockValue;
        },
      ),
    ]);

    expect(lock1, 'The locks must be different.').not.toBe(lock2);

    is(await redis.get('{redlock}y'), null, 'The lock was not released.');
  });
});
