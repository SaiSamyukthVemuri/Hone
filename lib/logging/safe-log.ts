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
// The id pattern matches lib/observability/sentry-scrub.ts (#891): a dashed
// 8-4-4-4-12 UUID, a hyphen possibly percent-encoded as %2D, bounded by "not
// a hex digit" so an id joined to letters or "_" is still matched. To be
// consolidated into one shared definition once #891 merges.

const RECORD_ID_RE =
  /(?<![0-9a-f])[0-9a-f]{8}(?:-|%2d)[0-9a-f]{4}(?:-|%2d)[0-9a-f]{4}(?:-|%2d)[0-9a-f]{4}(?:-|%2d)[0-9a-f]{12}(?![0-9a-f])/gi;
const RECORD_ID_PLACEHOLDER = "[id]";
const REDACTED = "[Redacted]";
const MAX_DEPTH = 8;

function scrubText(text: string): string {
  return text.replace(RECORD_ID_RE, RECORD_ID_PLACEHOLDER);
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
