import { randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';

import type { Redis as IORedisClient, Cluster as IORedisCluster } from 'ioredis';

import { ensureCommands } from './scripts';

type Client = IORedisClient | IORedisCluster;

export type ClientExecutionResult =
  | {
      client: Client;
      vote: 'for';
      value: number;
    }
  | {
      client: Client;
      vote: 'against';
      error: Error;
    };

/*
 * This object contains a summary of results.
 */
export type ExecutionStats = {
  readonly membershipSize: number;
  readonly quorumSize: number;
  readonly votesFor: Set<Client>;
  readonly votesAgainst: Map<Client, Error>;
};

/*
 * This object contains a summary of results. Because the result of an attempt
 * can sometimes be determined before all requests are finished, each attempt
 * contains a Promise that will resolve ExecutionStats once all requests are
 * finished. A rejection of these promises should be considered undefined
 * behavior and should cause a crash.
 */
export type ExecutionResult = {
  attempts: ReadonlyArray<Promise<ExecutionStats>>;
  start: number;
};

/**
 *
 */
export interface Settings {
  readonly driftFactor?: number;
  readonly retryCount?: number;
  readonly retryDelay?: number;
  readonly retryJitter?: number;
  readonly automaticExtensionThreshold?: number;
  readonly db?: number;
}

// Define default settings.
const defaultSettings: Readonly<Required<Settings>> = {
  driftFactor: 0.01,
  retryCount: 10,
  retryDelay: 200,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
  db: 0
};

// Modifyng this object is forbidden.
Object.freeze(defaultSettings);

/*
 * This error indicates a failure due to the existence of another lock for one
 * or more of the requested resources.
 */
export class ResourceLockedError extends Error {
  constructor(public readonly message: string) {
    super();
    this.name = 'ResourceLockedError';
  }
}

/*
 * This error indicates a failure of an operation to pass with a quorum.
 */
export class ExecutionError extends Error {
  constructor(
    public readonly message: string,
    public readonly attempts: ReadonlyArray<Promise<ExecutionStats>>,
  ) {
    super();
    this.name = 'ExecutionError';
  }
}

/*
 * An object of this type is returned when a resource is successfully locked. It
 * contains convenience methods `release` and `extend` which perform the
 * associated Redlock method on itself.
 */
export class Lock {
  constructor(
    public readonly redlock: Redlock,
    public readonly resources: string[],
    public readonly value: string,
    public readonly attempts: ReadonlyArray<Promise<ExecutionStats>>,
    public expiration: number,
    public readonly settings?: Partial<Settings>,
  ) {}

  async release(): Promise<ExecutionResult> {
    return this.redlock.release(this);
  }

  async extend(duration: number): Promise<Lock> {
    return this.redlock.extend(this, duration, this.settings);
  }
}

export type RedlockAbortSignal = AbortSignal & { error?: Error };

export interface RedlockUsingContext {
  lock: Lock;
  extensions: number;
}

/**
 * A redlock object is instantiated with an array of at least one redis client
 * and an optional `options` object. Properties of the Redlock object should NOT
 * be changed after it is first used, as doing so could have unintended
 * consequences for live locks.
 */
export class Redlock extends EventEmitter {
  public readonly clients: Set<Client>;
  public readonly settings: Required<Settings>;

  public constructor(clients: Iterable<Client>, settings: Settings = {}) {
    super();

    // Prevent crashes on error events.
    this.on('error', () => {
      // Because redlock is designed for high availability, it does not care if
      // a minority of redis instances/clusters fail at an operation.
      //
      // However, it can be helpful to monitor and log such cases. Redlock emits
      // an "error" event whenever it encounters an error, even if the error is
      // ignored in its normal operation.
      //
      // This function serves to prevent node's default behavior of crashing
      // when an "error" event is emitted in the absence of listeners.
    });

    // Create a new array of client, to ensure no accidental mutation.
    this.clients = new Set(clients);
    if (this.clients.size === 0) {
      throw new Error('Redlock must be instantiated with at least one redis client.');
    }

    // Customize the settings for this instance.
    this.settings = {
      driftFactor:
        typeof settings.driftFactor === 'number'
          ? settings.driftFactor
          : defaultSettings.driftFactor,
      retryCount:
        typeof settings.retryCount === 'number' ? settings.retryCount : defaultSettings.retryCount,
      retryDelay:
        typeof settings.retryDelay === 'number' ? settings.retryDelay : defaultSettings.retryDelay,
      retryJitter:
        typeof settings.retryJitter === 'number'
          ? settings.retryJitter
          : defaultSettings.retryJitter,
      automaticExtensionThreshold:
        typeof settings.automaticExtensionThreshold === 'number'
          ? settings.automaticExtensionThreshold
          : defaultSettings.automaticExtensionThreshold,
      db:
        (typeof settings.db === 'number' && Number.isInteger(settings.db) && settings.db >= 0 && settings.db <= 15)
        // settings.db value must be a number and between 0 and 15, inclusive.
          ? settings.db
          : defaultSettings.db,
    };
  }

  /**
   * Generate a sha1 hash compatible with redis evalsha.
   */
  private _hash(value: string): string {
    return createHash('sha1').update(value).digest('hex');
  }

  /**
   * Generate a cryptographically random string.
   */
  private _random(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * This method runs `.quit()` on all client connections.
   */
  public async quit(): Promise<void> {
    const results = [];
    for (const client of this.clients) {
      results.push(client.quit());
    }

    await Promise.all(results);
  }

  /**
   * This method acquires a locks on the resources for the duration specified by
   * the `duration`.
   */
  public async acquire(
    resources: string[],
    duration: number,
    settings?: Partial<Settings>,
  ): Promise<Lock> {
    if (Math.floor(duration) !== duration) {
      throw new Error('Duration must be an integer value in milliseconds.');
    }

    const value = this._random();

    try {
      const { attempts, start } = await this._execute(
        'acquireLock',
        resources,
        [this.settings.db, value, duration],
        settings,
      );

      // Add 2 milliseconds to the drift to account for Redis expires precision,
      // which is 1 ms, plus the configured allowable drift factor.
      const drift = Math.round((settings?.driftFactor ?? this.settings.driftFactor) * duration) + 2;

      return new Lock(this, resources, value, attempts, start + duration - drift, settings);
    } catch (error) {
      // If there was an error acquiring the lock, release any partial lock
      // state that may exist on a minority of clients.
      await this._execute('releaseLock', resources, [this.settings.db, value], {
        retryCount: 0,
      }).catch(() => {
        // Any error here will be ignored.
      });

      throw error;
    }
  }

  /**
   * This method unlocks the provided lock from all servers still persisting it.
   * It will fail with an error if it is unable to release the lock on a quorum
   * of nodes, but will make no attempt to restore the lock in the case of a
   * failure to release. It is safe to re-attempt a release or to ignore the
   * error, as the lock will automatically expire after its timeout.
   */
  public async release(lock: Lock, settings?: Partial<Settings>): Promise<ExecutionResult> {
    // Immediately invalidate the lock.
    lock.expiration = 0;

    // Attempt to release the lock.
    return this._execute('releaseLock', lock.resources, [this.settings.db, lock.value], settings);
  }

  /**
   * This method extends a valid lock by the provided `duration`.
   */
  public async extend(
    existing: Lock,
    duration: number,
    settings?: Partial<Settings>,
  ): Promise<Lock> {
    if (Math.floor(duration) !== duration) {
      throw new Error('Duration must be an integer value in milliseconds.');
    }

    // The lock has already expired.
    if (existing.expiration < Date.now()) {
      throw new ExecutionError('Cannot extend an already-expired lock.', []);
    }

    const { attempts, start } = await this._execute(
      'extendLock',
      existing.resources,
      [this.settings.db, existing.value, duration],
      settings,
    );

    // Invalidate the existing lock.
    existing.expiration = 0;

    // Add 2 milliseconds to the drift to account for Redis expires precision,
    // which is 1 ms, plus the configured allowable drift factor.
    const drift = Math.round((settings?.driftFactor ?? this.settings.driftFactor) * duration) + 2;

    return new Lock(this, existing.resources, existing.value, attempts, start + duration - drift, settings);
  }

  /**
   * Execute a script on all clients. The resulting promise is resolved or
   * rejected as soon as this quorum is reached; the resolution or rejection
   * will contains a `stats` property that is resolved once all votes are in.
   */
  private async _execute(
    command: 'acquireLock' | 'extendLock' | 'releaseLock',
    keys: string[],
    args: (string | number)[],
    _settings?: Partial<Settings>,
  ): Promise<ExecutionResult> {
    const settings = _settings
      ? {
          ...this.settings,
          ..._settings,
        }
      : this.settings;

    // For the purpose of easy config serialization, we treat a retryCount of
    // -1 a equivalent to Infinity.
    const maxAttempts = settings.retryCount === -1 ? Infinity : settings.retryCount + 1;

    const attempts: Promise<ExecutionStats>[] = [];

    while (attempts.length < maxAttempts) {
      const { vote, stats, start } = await this._attemptOperation(command, keys, args);

      attempts.push(stats);

      // The operation achieved a quorum in favor.
      if (vote === 'for') {
        return { attempts, start };
      }

      // Wait before reattempting.
      if (attempts.length < maxAttempts) {
        await new Promise((resolve) => {
          setTimeout(
            resolve,
            Math.max(
              0,
              settings.retryDelay + Math.floor((Math.random() * 2 - 1) * settings.retryJitter),
            ),
            undefined,
          );
        });
      }
    }

    throw new ExecutionError(
      'The operation was unable to achieve a quorum during its retry window.',
      attempts,
    );
  }

  private async _attemptOperation(
    script: 'acquireLock' | 'extendLock' | 'releaseLock',
    keys: string[],
    args: (string | number)[],
  ): Promise<
    | { vote: 'for'; stats: Promise<ExecutionStats>; start: number }
    | { vote: 'against'; stats: Promise<ExecutionStats>; start: number }
  > {
    const start = Date.now();

    return await new Promise((resolve) => {
      const clientResults = [];
      for (const client of this.clients) {
        clientResults.push(this._attemptOperationOnClient(client, script, keys, args));
      }

      const stats: ExecutionStats = {
        membershipSize: clientResults.length,
        quorumSize: Math.floor(clientResults.length / 2) + 1,
        votesFor: new Set<Client>(),
        votesAgainst: new Map<Client, Error>(),
      };

      let done: () => void;
      const statsPromise = new Promise<typeof stats>((resolve) => {
        done = () => resolve(stats);
      });

      // This is the expected flow for all successful and unsuccessful requests.
      const onResultResolve = (clientResult: ClientExecutionResult): void => {
        switch (clientResult.vote) {
          case 'for':
            stats.votesFor.add(clientResult.client);
            break;
          case 'against':
            stats.votesAgainst.set(clientResult.client, clientResult.error);
            break;
        }

        // A quorum has determined a success.
        if (stats.votesFor.size === stats.quorumSize) {
          resolve({
            vote: 'for',
            stats: statsPromise,
            start,
          });
        }

        // A quorum has determined a failure.
        if (stats.votesAgainst.size === stats.quorumSize) {
          resolve({
            vote: 'against',
            stats: statsPromise,
            start,
          });
        }

        // All votes are in.
        if (stats.votesFor.size + stats.votesAgainst.size === stats.membershipSize) {
          done();
        }
      };

      // This is unexpected and should crash to prevent undefined behavior.
      const onResultReject = (error: Error): void => {
        throw error;
      };

      for (const result of clientResults) {
        result.then(onResultResolve, onResultReject);
      }
    });
  }

  private async _attemptOperationOnClient(
    client: Client,
    script: 'acquireLock' | 'extendLock' | 'releaseLock',
    keys: string[],
    args: (string | number)[],
  ): Promise<ClientExecutionResult> {
    try {
      ensureCommands(client);
      const shaResult = await client[script](keys.length, ...keys, ...args);
      // Attempt to evaluate the script by its hash.

      if (typeof shaResult !== 'number') {
        throw new Error(`Unexpected result of type ${typeof shaResult} returned from redis.`);
      }

      const result = shaResult;

      // One or more of the resources was already locked.
      if (result !== keys.length) {
        throw new ResourceLockedError(
          `The operation was applied to: ${result} of the ${keys.length} requested resources.`,
        );
      }

      return {
        vote: 'for',
        client,
        value: result,
      };
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error(`Unexpected type ${typeof error} thrown with value: ${error}`);
      }

      // Emit the error on the redlock instance for observability.
      this.emit('error', error);

      return {
        vote: 'against',
        client,
        error,
      };
    }
  }

  /**
   * Wrap and execute a routine in the context of an auto-extending lock,
   * returning a promise of the routine's value. In the case that auto-extension
   * fails, an AbortSignal will be updated to indicate that abortion of the
   * routine is in order, and to pass along the encountered error.
   *
   * @example
   * ```ts
   * await redlock.using([senderId, recipientId], 5000, { retryCount: 5 }, async (signal) => {
   *   const senderBalance = await getBalance(senderId);
   *   const recipientBalance = await getBalance(recipientId);
   *
   *   if (senderBalance < amountToSend) {
   *     throw new Error("Insufficient balance.");
   *   }
   *
   *   // The abort signal will be true if:
   *   // 1. the above took long enough that the lock needed to be extended
   *   // 2. redlock was unable to extend the lock
   *   //
   *   // In such a case, exclusivity can no longer be guaranteed for further
   *   // operations, and should be handled as an exceptional case.
   *   if (signal.aborted) {
   *     throw signal.error;
   *   }
   *
   *   await setBalances([
   *     {id: senderId, balance: senderBalance - amountToSend},
   *     {id: recipientId, balance: recipientBalance + amountToSend},
   *   ]);
   * });
   * ```
   */

  public async using<T>(
    resources: string[],
    duration: number,
    settings: Partial<Settings>,
    routine?: (signal: RedlockAbortSignal, context: RedlockUsingContext) => Promise<T>,
  ): Promise<T>;

  public async using<T>(
    resources: string[],
    duration: number,
    routine: (signal: RedlockAbortSignal, context: RedlockUsingContext) => Promise<T>,
  ): Promise<T>;

  public async using<T>(
    resources: string[],
    duration: number,
    settingsOrRoutine:
      | undefined
      | Partial<Settings>
      | ((signal: RedlockAbortSignal, context: RedlockUsingContext) => Promise<T>),
    optionalRoutine?: (signal: RedlockAbortSignal, context: RedlockUsingContext) => Promise<T>,
  ): Promise<T> {
    if (Math.floor(duration) !== duration) {
      throw new Error('Duration must be an integer value in milliseconds.');
    }

    const settings =
      settingsOrRoutine && typeof settingsOrRoutine !== 'function'
        ? {
            ...this.settings,
            ...settingsOrRoutine,
          }
        : this.settings;

    const routine = optionalRoutine ?? settingsOrRoutine;
    if (typeof routine !== 'function') {
      throw new Error('INVARIANT: routine is not a function.');
    }

    if (settings.automaticExtensionThreshold > duration - 100) {
      throw new Error(
        'A lock `duration` must be at least 100ms greater than the `automaticExtensionThreshold` setting.',
      );
    }

    // The AbortController/AbortSignal pattern allows the routine to be notified
    // of a failure to extend the lock, and subsequent expiration. In the event
    // of an abort, the error object will be made available at `signal.error`.
    const controller = new AbortController();

    const signal = controller.signal as RedlockAbortSignal;

    function queue(): void {
      timeout = setTimeout(
        () => (extension = extend()),
        context.lock.expiration - Date.now() - settings.automaticExtensionThreshold,
      );
    }

    async function extend(): Promise<void> {
      timeout = undefined;

      try {
        context.lock = await context.lock.extend(duration);
        context.extensions += 1;
        queue();
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new Error(`Unexpected thrown ${typeof error}: ${error}.`);
        }

        if (context.lock.expiration > Date.now()) {
          return (extension = extend());
        }

        signal.error = error instanceof Error ? error : new Error(`${error}`);
        controller.abort();
      }
    }

    let timeout: undefined | NodeJS.Timeout;
    let extension: undefined | Promise<void>;
    const context: RedlockUsingContext = {
      lock: await this.acquire(resources, duration, settings),
      extensions: 0,
    };
    queue();

    try {
      return await routine(signal, context);
    } finally {
      // Clean up the timer.
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      // Wait for an in-flight extension to finish.
      if (extension) {
        await extension.catch(() => {
          // An error here doesn't matter at all, because the routine has
          // already completed, and a release will be attempted regardless. The
          // only reason for waiting here is to prevent possible contention
          // between the extension and release.
        });
      }

      await context.lock.release();
    }
  }
}
