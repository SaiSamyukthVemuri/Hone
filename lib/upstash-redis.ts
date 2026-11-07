import "server-only";
import { Redis } from "@upstash/redis";

// The one place the Upstash REST credentials are read. Null when unconfigured;
// each caller decides whether that fails open (heartbeats) or closed (locks).
// Env is read on every call and nothing is cached, as every caller did before.
export function getUpstashRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

// Delete KEYS[1] only if it still holds ARGV[1] (the caller's lock token), so a
// holder whose lease already expired can never delete a different holder's lock.
export const RELEASE_IF_OWNER_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
