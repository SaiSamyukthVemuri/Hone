// ===========================================================================
// #828 G-26 (egress-audit row 25): server logs without record ids.
// ===========================================================================
//
// Hone's server console output goes to Vercel runtime logs, a third party.
// Clients, sessions, appointments, intake forms and studios are addressed by
// UUID, and a UUID beside clinical or booking context is a linkable record id,
// so it must not leave in a log line.
//
// `safeLog.error / warn / info` replace every record id with "[id]" in each
// argument, then hand the arguments to console unchanged otherwise:
//   * strings: the id is replaced in place;
//   * Error: a copy keeps the name, with the id removed from message and stack;
//   * plain objects and arrays: ids are replaced in every string value and
//     every key, to a bounded depth (anything deeper is dropped as
//     "[Redacted]", never logged unscrubbed);
//   * numbers, booleans, null and undefined pass through.
//
// ID-ONLY on purpose: an event slug, a Postgres error code or a stage name
// keeps its shape, so logs stay greppable. Emails, phones and tokens are not
// this module's job.
//
// The id handling matches lib/observability/sentry-scrub.ts (#891). To be
// consolidated into one shared definition once #891 merges.

const RECORD_ID_PLACEHOLDER = "[id]";
const REDACTED = "[Redacted]";
const MAX_DEPTH = 8;

// THE GUARANTEE for encodings: no string or key, after ASCII percent-decoding
// to a fixed point, contains a UUID.
//
// The regex is the plain dashed 8-4-4-4-12 form with no boundary (an id glued
// to letters, "_" or digits is still a full id). Its dashes are what make it a
// UUID, so dashless hex (Sentry trace and span ids, hashes) is never matched.
// Encodings are NOT enumerated in it (%2D, %36, %252D, ... were found one at a
// time in review). Instead, each whitespace-delimited token that contains "%"
// is decoded (ASCII %XX only, so a malformed escape never throws and
// multibyte text is untouched), repeatedly until stable, at most
// MAX_DECODE_ROUNDS times. If the decoded token contains a UUID, the DECODED
// token is written with the ids replaced ("/clients/%36f1…" becomes
// "/clients/[id]", keeping the route shape). A token still changing after the
// bound is replaced with "[Redacted]": fail closed, never sent undecoded.
// Out of scope: non-URL encodings (HTML entities, \u escapes, base64), which
// URL serialization does not produce.
const RECORD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HAS_RECORD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_DECODE_ROUNDS = 4;

function reescapeControls(text: string): string {
  return text.replace(/[\x00-\x20\x7f]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function decodeAsciiEscapes(text: string): string {
  return text.replace(/%([0-7][0-9a-f])/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function replaceRecordIds(text: string): string {
  if (!text.includes("%")) return text.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!token.includes("%")) return token.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
      let decoded = token;
      for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
        const next = decodeAsciiEscapes(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (decodeAsciiEscapes(decoded) !== decoded) return REDACTED;
      if (decoded !== token && HAS_RECORD_ID.test(decoded)) {
        // Decoding must not INJECT characters (Codex P2 4301838851): a
        // control character or whitespace that was escaped in the input
        // (%0A, %1B, %20) is escaped again on the way out, so a decoded
        // token can never forge a log line or a terminal sequence.
        return reescapeControls(decoded.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER));
      }
      return token.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
    })
    .join("");
}

function scrubText(text: string): string {
  return replaceRecordIds(text);
}

function scrubKey(key: string, taken: Record<string, unknown>): string {
  const base = scrubText(key);
  if (!Object.hasOwn(taken, base)) return base;
  let n = 2;
  while (Object.hasOwn(taken, `${base}#${n}`)) n += 1;
  return `${base}#${n}`;
}

function scrubValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH || seen.has(value)) return REDACTED;
  seen.add(value);

  if (value instanceof Error) {
    const copy = new Error(scrubText(value.message));
    copy.name = scrubText(value.name);
    copy.stack = typeof value.stack === "string" ? scrubText(value.stack) : undefined;
    const extra = Object.entries(value).filter(([k]) => k !== "message" && k !== "stack" && k !== "name");
    for (const [k, v] of extra) {
      (copy as unknown as Record<string, unknown>)[scrubKey(k, copy as unknown as Record<string, unknown>)] =
        scrubValue(v, seen, depth + 1);
    }
    return copy;
  }

  if (Array.isArray(value)) return value.map((v) => scrubValue(v, seen, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[scrubKey(k, out)] = scrubValue(v, seen, depth + 1);
  }
  return out;
}

/** The arguments as they will be logged: every record id replaced. */
export function withoutRecordIds(args: readonly unknown[]): unknown[] {
  const seen = new WeakSet<object>();
  return args.map((a) => scrubValue(a, seen, 0));
}

export const safeLog = {
  error: (...args: unknown[]): void => console.error(...withoutRecordIds(args)),
  warn: (...args: unknown[]): void => console.warn(...withoutRecordIds(args)),
  info: (...args: unknown[]): void => console.info(...withoutRecordIds(args)),
};
