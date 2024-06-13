import { Redis as IORedisClient, Cluster as IORedisCluster, Result } from 'ioredis';
type Client = IORedisClient | IORedisCluster;

// Define script constants.
const DB_SELECT_SCRIPT = `
  -- Protected call to execute SELECT command if supported
  redis.pcall("SELECT", tonumber(ARGV[1]))
`;

const ACQUIRE_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  -- Return 0 if an entry already exists.
  for i, key in ipairs(KEYS) do
    if redis.call("exists", key) == 1 then
      return 0
    end
  end

  -- Create an entry for each provided key.
  for i, key in ipairs(KEYS) do
    redis.call("set", key, ARGV[2], "PX", ARGV[3])
  end

  -- Return the number of entries added.
  return #KEYS
`;

const EXTEND_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  -- Return 0 if an entry exists with a *different* lock value.
  for i, key in ipairs(KEYS) do
    if redis.call("get", key) ~= ARGV[2] then
      return 0
    end
  end

  -- Update the entry for each provided key.
  for i, key in ipairs(KEYS) do
    redis.call("set", key, ARGV[2], "PX", ARGV[3])
  end

  -- Return the number of entries updated.
  return #KEYS
`;

const RELEASE_SCRIPT = `
  ${DB_SELECT_SCRIPT}

  local count = 0
  for i, key in ipairs(KEYS) do
    -- Only remove entries for *this* lock value.
    if redis.call("get", key) == ARGV[2] then
      redis.pcall("del", key)
      count = count + 1
    end
  end

  -- Return the number of entries removed.
  return count
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    acquireLock(keys: number, ...args: (string | number)[]): Result<string, Context>;
    extendLock(keys: number, ...args: (string | number)[]): Result<string, Context>;
    releaseLock(keys: number, ...args: (string | number)[]): Result<string, Context>;
  }
}

export function ensureCommands(client: Client) {
  if (typeof client.acquireLock === 'function') {
    return;
  }
  client.defineCommand('acquireLock', {
    lua: ACQUIRE_SCRIPT,
  });
  client.defineCommand('extendLock', {
    lua: EXTEND_SCRIPT,
  });
  client.defineCommand('releaseLock', {
    lua: RELEASE_SCRIPT,
  });
}