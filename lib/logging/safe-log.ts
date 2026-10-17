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
// is DECODED FOR DETECTION ONLY: every character of the decoded form keeps the
// range of the original text it came from (ASCII %XX escapes, decoded
// repeatedly until stable, at most MAX_DECODE_ROUNDS times, so %252D, %2536
// and %25%32%44 all resolve). Each match found in the decoded form replaces
// exactly its ORIGINAL range; everything else in the token is written back
// byte for byte, still encoded (Codex P2 4301838851, P2 4301902163, P1
// 4301902565: emitting the decoded token injected control characters, forged
// JSON fields, and re-exposed an email the upstream redaction had removed). A
// token still changing after the bound is replaced with "[Redacted]": fail
// closed, never sent undecoded.
// Out of scope: non-URL encodings (HTML entities, \u escapes, base64), which
// URL serialization does not produce.
const RECORD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_DECODE_ROUNDS = 4;

type Detector = { re: RegExp; placeholder: string };

/** One decoded character and the [start, end) range of the original token it
 *  decodes from. */
type Unit = { ch: string; start: number; end: number };

const isHex = (u: Unit | undefined): boolean => u !== undefined && /^[0-9a-f]$/i.test(u.ch);

/** One round of ASCII %XX decoding over units, left to right. Returns null
 *  when nothing changed. */
function decodeRound(units: Unit[]): Unit[] | null {
  const out: Unit[] = [];
  let changed = false;
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]!;
    const h1 = units[i + 1];
    const h2 = units[i + 2];
    if (u.ch === "%" && isHex(h1) && isHex(h2)) {
      const code = parseInt(h1!.ch + h2!.ch, 16);
      if (code < 0x80) {
        out.push({ ch: String.fromCharCode(code), start: u.start, end: h2!.end });
        i += 2;
        changed = true;
        continue;
      }
    }
    out.push(u);
  }
  return changed ? out : null;
}

/** Replace every detector match found in the token's decoded form, at its
 *  original range. `undefined` means the token is still changing after the
 *  bound and must be dropped. */
function replaceDecodedMatches(token: string, detectors: readonly Detector[]): string | undefined {
  // UTF-16 code units, not code points (Codex P2 4301959849 / 4301959252):
  // regex indexes and String.slice count code units, so an astral character
  // (an emoji is two units) must be two units here too.
  let units: Unit[] = Array.from({ length: token.length }, (_v, i) => ({ ch: token[i]!, start: i, end: i + 1 }));
  for (let round = 0; ; round += 1) {
    const next = decodeRound(units);
    if (next === null) break;
    if (round === MAX_DECODE_ROUNDS) return undefined;
    units = next;
  }
  const decoded = units.map((u) => u.ch).join("");
  const hits: Array<{ start: number; end: number; placeholder: string }> = [];
  for (const { re, placeholder } of detectors) {
    for (const m of decoded.matchAll(re)) {
      const first = units[m.index!]!;
      const last = units[m.index! + m[0].length - 1]!;
      hits.push({ start: first.start, end: last.end, placeholder });
    }
  }
  if (hits.length === 0) return token;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue; // overlapped by an earlier (wider) hit
    out += token.slice(at, h.start) + h.placeholder;
    at = h.end;
  }
  return out + token.slice(at);
}

/** Apply detectors to text, decoding any token that contains "%". */
function replaceEncodedAware(text: string, detectors: readonly Detector[]): string {
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!token.includes("%")) {
        return detectors.reduce((t, { re, placeholder }) => t.replace(re, placeholder), token);
      }
      return replaceDecodedMatches(token, detectors) ?? REDACTED;
    })
    .join("");
}

const RECORD_ID_DETECTORS: readonly Detector[] = [{ re: RECORD_ID_RE, placeholder: RECORD_ID_PLACEHOLDER }];

function scrubText(text: string): string {
  return replaceEncodedAware(text, RECORD_ID_DETECTORS);
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
  // Logging must never throw from an error path: an argument the scrubber
  // cannot process is withheld, never logged raw.
  return args.map((a) => {
    try {
      return scrubValue(a, seen, 0);
    } catch {
      return REDACTED;
    }
  });
}

export const safeLog = {
  error: (...args: unknown[]): void => console.error(...withoutRecordIds(args)),
  warn: (...args: unknown[]): void => console.warn(...withoutRecordIds(args)),
  info: (...args: unknown[]): void => console.info(...withoutRecordIds(args)),
};
