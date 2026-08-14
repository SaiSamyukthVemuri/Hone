import "server-only";
import { createHash } from "node:crypto";

// Google Calendar: Phase B2.3-c1: deterministic provider event identity + the
// private Hone correlation marker.
//
// The Google event id is derived from the IMMUTABLE calendar_event_links.id (the
// per-provider-lifecycle link UUID), NEVER from a mutable appointment field. It
// therefore stays byte-identical across retries, replays, ambiguous responses,
// process restarts, sync_version bumps, and time/duration/reschedule changes that
// keep the same provider lifecycle, and changes ONLY when a fresh active link row
// (a new link UUID) begins a new lifecycle (rotate_for_recreate).
//
// Format (exact): "hone1" + lowercase, padding-free base32hex of
// SHA-256(UTF-8(studio_id + ":" + link.id)). Prefix 5 + digest 52 = 57 chars,
// alphabet [0-9a-v] only: within Google's permitted event-id charset
// (base32hex) and length (5..1024). The digest is NEVER truncated.

const EVENT_ID_PREFIX = "hone1";
export const EVENT_ID_TOTAL_LENGTH = 57;
export const EVENT_ID_DIGEST_LENGTH = 52;

// RFC 4648 base32hex alphabet, lowercase (0-9 then a-v).
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

// Encode a byte buffer as lowercase, padding-free base32hex.
function base32hexNoPad(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32HEX[(value << (5 - bits)) & 31];
  }
  return out;
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

// The deterministic Google event id for a link lifecycle. Requires the studio id
// and the immutable link UUID; identical inputs always yield the identical id.
export function deriveEventId(studioId: string, linkId: string): string {
  const digest = base32hexNoPad(sha256(`${studioId}:${linkId}`));
  // SHA-256 (32 bytes) => exactly 52 base32hex chars; assert to catch a change.
  const id = EVENT_ID_PREFIX + digest;
  if (id.length !== EVENT_ID_TOTAL_LENGTH) {
    throw new Error("derived event id has an unexpected length");
  }
  return id;
}

// The private correlation marker. `hone="1"` is the ownership flag; `hlk` is a
// one-way fingerprint of THIS link.id (never a raw UUID, never reversible, never
// PHI). A GET whose event carries hone="1" AND a matching hlk is cryptographic
// proof of Hone's own prior lifecycle for this link; a missing/mismatched marker
// proves the event is foreign (=> terminal_conflict, never overwrite/delete).
export const MARKER_OWNER_KEY = "hone";
export const MARKER_OWNER_VALUE = "1";
export const MARKER_LINK_KEY = "hlk";

export function deriveLinkFingerprint(linkId: string): string {
  return base32hexNoPad(sha256(linkId));
}

export function buildEventMarker(linkId: string): Record<string, string> {
  return {
    [MARKER_OWNER_KEY]: MARKER_OWNER_VALUE,
    [MARKER_LINK_KEY]: deriveLinkFingerprint(linkId),
  };
}

export type MarkerVerdict = "match" | "mismatch" | "absent";

// Verify a fetched Google event's private extended properties against the marker
// expected for `linkId`. `match` = provably this Hone link lifecycle.
export function verifyEventMarker(
  privateProps: Record<string, unknown> | null | undefined,
  linkId: string,
): MarkerVerdict {
  if (!privateProps || typeof privateProps !== "object") return "absent";
  const owner = privateProps[MARKER_OWNER_KEY];
  const hlk = privateProps[MARKER_LINK_KEY];
  if (owner !== MARKER_OWNER_VALUE || typeof hlk !== "string") return "absent";
  return hlk === deriveLinkFingerprint(linkId) ? "match" : "mismatch";
}
