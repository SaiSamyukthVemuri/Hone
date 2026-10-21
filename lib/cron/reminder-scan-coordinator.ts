import "server-only";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { reminderWindowIso } from "./reminder-schedule";

// Existing Upstash only; server-side credentials never leave this module.
// The checkpoint namespace is separate from the aggregate heartbeat.
// No new service/account/credential or SQL authority is introduced.
export const REMINDER_SCAN_PASSES = ["email24h", "email2h", "sms24h", "sms2h"] as const;
export type ReminderScanPass = (typeof REMINDER_SCAN_PASSES)[number];
export const REMINDER_SCAN_TTL_SECONDS = 3 * 60 * 60;
export const REMINDER_SCAN_LEASE_SECONDS = 120;
export const REMINDER_SCAN_MAX_CANDIDATES = 200;
export const REMINDER_SCAN_MAX_QUERIES = 8;
const PAGE_SIZE = 50;
const ATTEMPTS_PER_PASS = 50;
// Four pass records plus rotation metadata fit the approved 2 KiB ceiling.
const MAX_PASS_BYTES = 448;
const MAX_ROTATION_BYTES = 256;
const PREFIX = "reminder_scan:v1:";
const LOCK = `${PREFIX}lock`;
const ROTATION = `${PREFIX}rotation`;
const checkpointKey = (pass: ReminderScanPass) => `${PREFIX}checkpoint:${pass}`;

export type ReminderScanCursor = { startsAt: string; id: string };
type Checkpoint = {
  version: 1;
  pass: ReminderScanPass;
  createdAt: number;
  expiresAt: number;
  lower: string;
  upper: string;
  after: ReminderScanCursor | null;
  complete: boolean;
};
type Rotation = { version: 1; next: ReminderScanPass; known: ReminderScanPass[] };
export type ReminderScanRedis = {
  set(key: string, value: string, opts: { nx: true; ex: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
};

const READ = "if redis.call('get', KEYS[1]) ~= ARGV[1] then return {0,''} end; return {1,redis.call('get',KEYS[2]) or ''}";
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
// Checkpoint + next-pass publication is atomic and belongs to this owner only.
// Each pass has its OWN absolute-expiry key. Another pass cannot renew its ID.
const SAVE = "if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('set',KEYS[2],ARGV[2]); redis.call('pexpireat',KEYS[2],ARGV[3]); if redis.call('exists',KEYS[2]) == 0 then return 0 end; redis.call('set',KEYS[3],ARGV[4],'EX',ARGV[5]); redis.call('expire',KEYS[1],ARGV[6]); return 1";
const yes = (v: unknown) => v === 1 || v === "1";
const passIsValid = (v: unknown): v is ReminderScanPass => typeof v === "string" && (REMINDER_SCAN_PASSES as readonly string[]).includes(v);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ISO_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const validTime = (v: unknown): v is string => typeof v === "string" && ISO_TIME.test(v) && Number.isFinite(Date.parse(v));
function micros(value: string): bigint {
  const match = ISO_TIME.exec(value)!;
  return BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function cursorIsValid(v: unknown): v is ReminderScanCursor {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).length === 2 && validTime(r.startsAt) && typeof r.id === "string" && UUID.test(r.id);
}
function decode(v: unknown): unknown {
  return typeof v === "string" ? JSON.parse(v) : v;
}
function checkpointIsValid(v: unknown): v is Checkpoint {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).sort().join(",") === "after,complete,createdAt,expiresAt,lower,pass,upper,version" && r.version === 1 && passIsValid(r.pass) &&
    Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.expiresAt) &&
    Number(r.expiresAt) - Number(r.createdAt) === REMINDER_SCAN_TTL_SECONDS * 1000 &&
    validTime(r.lower) && validTime(r.upper) && (r.after === null || cursorIsValid(r.after)) &&
    typeof r.complete === "boolean" && (!r.complete || r.after === null) &&
    (r.complete || micros(r.lower) <= micros(r.upper)) &&
    (r.after === null || micros(r.after.startsAt) <= micros(r.upper));
}
function rotationIsValid(v: unknown): v is Rotation {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Object.keys(r).sort().join(",") === "known,next,version" && r.version === 1 && passIsValid(r.next) &&
    Array.isArray(r.known) && r.known.length <= 4 && r.known.every(passIsValid) && new Set(r.known).size === r.known.length;
}

// Bounded reads/coordination only. A lost Redis write reply is never assumed
// committed; token fencing and the unchanged DB claims remain authoritative.
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("scan coordination unavailable")), 1000); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

export function createReminderScanCoordinator(redis: ReminderScanRedis | null, newToken: () => string = randomUUID) {
  async function read(token: string, key: string): Promise<unknown> {
    if (!redis) throw new Error("scan coordination unavailable");
    const r = await bounded(redis.eval(READ, [LOCK, key], [token]));
    if (!Array.isArray(r) || !yes(r[0])) throw new Error("scan ownership lost");
    return r[1] === "" || r[1] == null ? null : decode(r[1]);
  }
  return {
    async acquire(): Promise<string | null> {
      if (!redis) return null;
      const token = newToken();
      try { return await bounded(redis.set(LOCK, token, { nx: true, ex: REMINDER_SCAN_LEASE_SECONDS })) === "OK" ? token : null; } catch { return null; }
    },
    async rotation(token: string): Promise<Rotation & { missing?: true }> {
      const raw = await read(token, ROTATION);
      if (raw === null) return { version: 1, next: "email24h", known: [], missing: true };
      if (!rotationIsValid(raw)) throw new Error("scan checkpoint invalid");
      return raw;
    },
    async checkpoint(token: string, pass: ReminderScanPass): Promise<Checkpoint | null> {
      if (!passIsValid(pass)) throw new Error("scan checkpoint invalid");
      const raw = await read(token, checkpointKey(pass));
      if (raw === null) return null;
      if (!checkpointIsValid(raw) || raw.pass !== pass) throw new Error("scan checkpoint invalid");
      return raw;
    },
    async renew(token: string): Promise<boolean> {
      if (!redis) return false;
      try { return yes(await bounded(redis.eval(RENEW, [LOCK], [token, REMINDER_SCAN_LEASE_SECONDS]))); } catch { return false; }
    },
    async save(token: string, pass: ReminderScanPass, checkpoint: Checkpoint, rotation: Rotation, now: number): Promise<boolean> {
      if (!redis || !passIsValid(pass) || !Number.isSafeInteger(now) || !checkpointIsValid(checkpoint) || checkpoint.pass !== pass || !rotationIsValid(rotation) || !rotation.known.includes(pass) || checkpoint.createdAt > now) return false;
      const ttl = Math.min(REMINDER_SCAN_TTL_SECONDS, Math.floor((checkpoint.expiresAt - now) / 1000));
      const value = JSON.stringify(checkpoint);
      if (ttl < 1 || Buffer.byteLength(value) > MAX_PASS_BYTES || Buffer.byteLength(JSON.stringify(rotation)) > MAX_ROTATION_BYTES) return false;
      try {
        return yes(await bounded(redis.eval(SAVE, [LOCK, checkpointKey(pass), ROTATION],
          [token, value, checkpoint.expiresAt, JSON.stringify(rotation), REMINDER_SCAN_TTL_SECONDS, REMINDER_SCAN_LEASE_SECONDS])));
      } catch { return false; }
    },
    async release(token: string): Promise<void> {
      try { if (redis) await bounded(redis.eval(RELEASE, [LOCK], [token])); } catch { /* TTL remains the backstop. */ }
    },
  };
}

type Coordinator = ReturnType<typeof createReminderScanCoordinator>;
type Candidate = { id: string; starts_at: string };
type Window = { startIso: string; endIso: string };
type Handling = { kind: "processed" | "skipped" | "claim_unavailable"; attempted: boolean };
type BatchResult = {
  kind: "complete" | "partial" | "unavailable";
  reason: "complete" | "work_budget" | "deadline" | "checkpoint_reset" | "coverage_unconfirmed" | "coordination" | "read_or_handler" | "claim_unavailable";
  scanned: number;
  attempted: number;
  queries: number;
  coverageUnconfirmed: boolean;
};
function currentWindow(pass: ReminderScanPass, now: number): Window {
  return reminderWindowIso(pass.endsWith("24h") ? "24h" : "2h", now);
}
function compare(a: ReminderScanCursor, b: ReminderScanCursor): number {
  const left = micros(a.startsAt), right = micros(b.startsAt);
  return left === right ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : left < right ? -1 : 1;
}

/** Bounded driver. Ports use the existing query and MSG005/claim/send
 * laws. This coordinator only orders attempts, never authorizes a provider call.
 * Results contain aggregates/categories, NEVER checkpoint tuples or lease IDs.
 * Partial/outage/error results must not become a healthy success heartbeat.
 * Handle is awaited: no detached SDK work or cancellation promise is introduced.
 * Its existing transport/record bounds still need final route integration proof. */
export async function runReminderScanBatch<T extends Candidate>(ports: {
  coordinator: Coordinator;
  readPage: (pass: ReminderScanPass, query: Window & { after: ReminderScanCursor | null; limit: number }, signal: AbortSignal) => Promise<readonly T[]>;
  handle: (pass: ReminderScanPass, candidate: T, window: Window, deadline: number) => Promise<Handling>;
  now?: () => number;
}): Promise<BatchResult> {
  const now = ports.now ?? Date.now;
  const deadline = now() + 45_000;
  const result: BatchResult = { kind: "partial", reason: "work_budget", scanned: 0, attempted: 0, queries: 0, coverageUnconfirmed: false };
  const token = await ports.coordinator.acquire();
  if (!token) return { ...result, kind: "unavailable", reason: "coordination" };
  const finish = (kind: BatchResult["kind"], reason: BatchResult["reason"]) => ({ ...result, kind, reason });
  const states = new Map<ReminderScanPass, Checkpoint>();
  const done = new Set<ReminderScanPass>();
  const attempts = new Map<ReminderScanPass, number>();
  try {
    const { missing, ...rotation } = await ports.coordinator.rotation(token);
    // No durable history also means no proof that an earlier finite cycle
    // finished. Bootstrap/total TTL loss must not report healthy coverage.
    if (missing) result.coverageUnconfirmed = true;
    let index = REMINDER_SCAN_PASSES.indexOf(rotation.next);
    while (done.size < 4 && result.scanned < REMINDER_SCAN_MAX_CANDIDATES && result.queries < REMINDER_SCAN_MAX_QUERIES) {
      if (now() + 20_000 >= deadline) return finish("partial", "deadline");
      const pass = REMINDER_SCAN_PASSES[index];
      index = (index + 1) % 4;
      if (done.has(pass)) continue;
      if (!await ports.coordinator.renew(token)) return finish("unavailable", "coordination");
      let pageNow = now();
      let state = states.get(pass);
      if (!state) {
        const saved = await ports.coordinator.checkpoint(token, pass);
        if (saved && !rotation.known.includes(pass)) return finish("unavailable", "coordination");
        if (saved && saved.createdAt > now()) return finish("unavailable", "coordination");
        const reset = !saved || saved.expiresAt <= now();
        const createdAt = pageNow = now();
        const initialWindow = currentWindow(pass, createdAt);
        state = saved && !saved.complete && !reset ? { ...saved, after: saved.after && { ...saved.after } } : {
          version: 1, pass, createdAt, expiresAt: createdAt + REMINDER_SCAN_TTL_SECONDS * 1000,
          lower: initialWindow.startIso, upper: initialWindow.endIso, after: null, complete: false,
        };
        states.set(pass, state);
        if (reset && rotation.known.includes(pass)) {
          // Loss/expiry is visible, not silently interpreted as prior coverage.
          result.coverageUnconfirmed = true;
          rotation.next = REMINDER_SCAN_PASSES[index];
          if (!await ports.coordinator.save(token, pass, state, rotation, now())) return finish("unavailable", "coordination");
          return finish("partial", "checkpoint_reset");
        }
      }
      const window = currentWindow(pass, pageNow);
      if (!rotation.known.includes(pass)) rotation.known.push(pass);
      rotation.next = REMINDER_SCAN_PASSES[index];
      const coveredThrough = state.after && micros(state.after.startsAt) > micros(state.lower) ? state.after.startsAt : state.lower;
      if (micros(window.startIso) > micros(coveredThrough)) {
        // An unvisited time range aged out while this finite cycle was pending.
        // Never call that empty success or send its rows outside CURRENT bounds.
        result.coverageUnconfirmed = true;
        state.lower = window.startIso;
      }
      const endIso = Date.parse(state.upper) < Date.parse(window.endIso) ? state.upper : window.endIso;
      const limit = Math.min(PAGE_SIZE, REMINDER_SCAN_MAX_CANDIDATES - result.scanned);
      const query = { startIso: window.startIso, endIso, after: state.after, limit };
      result.queries++;
      const rows = Date.parse(endIso) < Date.parse(window.startIso) ? [] : await bounded(ports.readPage(pass, query, AbortSignal.timeout(1000)));
      if (!Array.isArray(rows) || rows.length > limit) return finish("unavailable", "read_or_handler");
      let exhausted = rows.length < limit;
      for (const candidate of rows) {
        if (now() + 20_000 >= deadline) { exhausted = false; break; }
        const cursor = { startsAt: candidate.starts_at, id: candidate.id };
        if (!cursorIsValid(cursor) || (state.after && compare(cursor, state.after) <= 0)) return finish("unavailable", "read_or_handler");
        if (micros(cursor.startsAt) < micros(query.startIso) || micros(cursor.startsAt) > micros(query.endIso)) return finish("unavailable", "read_or_handler");
        const freshWindow = currentWindow(pass, now());
        const inWindow = micros(candidate.starts_at) >= micros(freshWindow.startIso) && micros(candidate.starts_at) <= micros(freshWindow.endIso);
        if (!inWindow) { result.coverageUnconfirmed = true; state.lower = freshWindow.startIso; }
        const outcome = inWindow ? await ports.handle(pass, candidate, freshWindow, deadline) : { kind: "skipped" as const, attempted: false };
        if (!outcome || !["processed", "skipped", "claim_unavailable"].includes(outcome.kind) || typeof outcome.attempted !== "boolean" || (outcome.kind === "claim_unavailable" && outcome.attempted)) return finish("unavailable", "read_or_handler");
        result.scanned++;
        if (outcome.attempted) {
          result.attempted++;
          attempts.set(pass, (attempts.get(pass) ?? 0) + 1);
        }
        if (outcome.kind === "claim_unavailable") {
          // No authoritative handling occurred: retain the handled prefix so
          // the next fire can retry this row while its CURRENT window permits.
          if (!await ports.coordinator.save(token, pass, state, rotation, now())) return finish("unavailable", "coordination");
          return finish("unavailable", "claim_unavailable");
        }
        // Last ACTUALLY handled candidate, not page end or refreshed timestamp.
        state.after = cursor;
        if ((attempts.get(pass) ?? 0) >= ATTEMPTS_PER_PASS) {
          exhausted = false;
          done.add(pass); // preserve per-invocation attempt cap; cursor resumes
          break;
        }
      }
      if (micros(state.lower) > micros(state.upper)) exhausted = true;
      if (exhausted) { state.complete = true; state.after = null; done.add(pass); }
      if (!await ports.coordinator.save(token, pass, state, rotation, now())) return finish("unavailable", "coordination");
    }
    if (result.coverageUnconfirmed) return finish("partial", "coverage_unconfirmed");
    return [...states.values()].every((s) => s.complete) && done.size === 4 ? finish("complete", "complete") : result;
  } catch {
    return finish("unavailable", "read_or_handler");
  } finally {
    await ports.coordinator.release(token);
  }
}

// Same configured service and fail-closed binding as the established Google
// coordinator. Construction performs no operation; tests replace this factory
// with the existing mocked Redis seam. No memory-only production fallback.
export function createUpstashReminderScanCoordinator() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return createReminderScanCoordinator(null);
  try {
    const redis = new Redis({ url, token });
    return createReminderScanCoordinator({
      set: (key, value, opts) => redis.set(key, value, opts),
      eval: (script, keys, args) => redis.eval(script, keys, args),
    });
  } catch { return createReminderScanCoordinator(null); }
}
