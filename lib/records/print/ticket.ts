// The print TICKET: how the owner opens the day packet WITHOUT a client id or a day in any URL.
//
// The owner presses Print on a session page. A POST (body, not URL) carries the client id and the day to
// /records/print/open, which mints a ticket and answers 303 to /records/print/ticket/<ticket>. The page resolves the
// ticket on the server. The URL, the Location header and every Referer therefore hold only an opaque string.
//
// OPAQUE, not merely signed. A signed payload (base64 JSON + HMAC) would put the client id in the URL in a form anyone
// can decode, which is the problem being removed. The ticket is AES-256-GCM authenticated encryption of a fixed binary
// payload, so it reveals nothing and any change to it fails authentication.
//
//   payload (67 bytes) = version(1) | expiresAtMs(6, big-endian) | studio(16) | owner(16) | client(16) | day(4) | nonce(8)
//   ticket             = base64url( iv(12) | ciphertext(67) | tag(16) )              = 127 characters
//
// BOUND to the studio and the owner (the practitioner row) that asked for it, and to the one client and one day.
// A ticket opened by another owner or from another studio is refused. Five minutes of life, checked on open.
//
// SINGLE USE is NOT a property of the ticket: a stateless token cannot know it was used. It is enforced by the
// store in ticket-store.ts (a set-if-absent marker keyed by a hash of the nonce, expiring with the ticket). This
// module returns the nonce so the caller can consume it; it never decides single use by itself.
//
// The secret is PRINT_TICKET_SECRET (>= 32 bytes). There is no fallback to any other secret: when it is missing or
// short, nothing is minted and nothing opens (fail closed). Pure apart from the clock and the random source, both
// injectable. Nothing here logs, and no error carries a payload byte.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

export const TICKET_TTL_MS = 5 * 60 * 1000;
const VERSION = 1;
const AAD = Buffer.from("hone/print-ticket/v1");
const PAYLOAD_BYTES = 67;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const TICKET_LENGTH = Math.ceil(((IV_BYTES + PAYLOAD_BYTES + TAG_BYTES) * 4) / 3); // 127, no padding

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TICKET_SHAPE = new RegExp(`^[A-Za-z0-9_-]{${TICKET_LENGTH}}$`);

export type TicketBinding = { studioId: string; ownerId: string };
export type TicketSubject = { clientId: string; day: string };

export type TicketRefusal = "unavailable" | "malformed" | "invalid" | "expired" | "foreign";
export type MintResult = { ok: true; ticket: string } | { ok: false; reason: "unavailable" | "invalid" };
export type OpenResult =
  | { ok: true; clientId: string; day: string; nonce: string }
  | { ok: false; reason: TicketRefusal };

function keyFrom(secret: string | undefined): Buffer | null {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return null;
  // Domain-separated, so the same secret could never decrypt anything else.
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), "hone/print-ticket/key/v1", 32));
}

const uuidBytes = (u: string): Buffer => Buffer.from(u.replace(/-/g, ""), "hex");
const bytesUuid = (b: Buffer): string => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

function dayToInt(day: string): number | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  // Reject 2026-02-31 and the like: the same real-date rule the page applies.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return y * 10000 + mo * 100 + d;
}
const intToDay = (n: number): string => {
  const y = Math.floor(n / 10000);
  const mo = Math.floor((n % 10000) / 100);
  const d = n % 100;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

export function mintTicket(args: {
  secret: string | undefined;
  binding: TicketBinding;
  subject: TicketSubject;
  now?: Date;
  random?: (n: number) => Buffer;
}): MintResult {
  const key = keyFrom(args.secret);
  if (key === null) return { ok: false, reason: "unavailable" };
  const { studioId, ownerId } = args.binding;
  const { clientId, day } = args.subject;
  const dayInt = dayToInt(day);
  if (![studioId, ownerId, clientId].every((u) => typeof u === "string" && UUID.test(u)) || dayInt === null) {
    return { ok: false, reason: "invalid" };
  }
  const random = args.random ?? randomBytes;
  const expires = (args.now ?? new Date()).getTime() + TICKET_TTL_MS;
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(VERSION, 0);
  payload.writeUIntBE(expires, 1, 6);
  uuidBytes(studioId).copy(payload, 7);
  uuidBytes(ownerId).copy(payload, 23);
  uuidBytes(clientId).copy(payload, 39);
  payload.writeUInt32BE(dayInt, 55);
  random(8).copy(payload, 59);
  const iv = random(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const sealed = Buffer.concat([cipher.update(payload), cipher.final()]);
  return { ok: true, ticket: Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url") };
}

export function openTicket(args: {
  secret: string | undefined;
  binding: TicketBinding;
  ticket: unknown;
  now?: Date;
}): OpenResult {
  const key = keyFrom(args.secret);
  if (key === null) return { ok: false, reason: "unavailable" };
  if (typeof args.ticket !== "string" || !TICKET_SHAPE.test(args.ticket)) return { ok: false, reason: "malformed" };
  const raw = Buffer.from(args.ticket, "base64url");
  if (raw.length !== IV_BYTES + PAYLOAD_BYTES + TAG_BYTES) return { ok: false, reason: "malformed" };
  // 127 base64url characters carry two spare bits that decoding ignores, so a differently spelled string could decode to
  // the same bytes. Only the canonical spelling is a ticket.
  if (raw.toString("base64url") !== args.ticket) return { ok: false, reason: "malformed" };
  let payload: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    payload = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return { ok: false, reason: "invalid" }; // forged, altered or minted under another secret
  }
  if (payload.length !== PAYLOAD_BYTES || payload.readUInt8(0) !== VERSION) return { ok: false, reason: "invalid" };
  const now = (args.now ?? new Date()).getTime();
  const expires = payload.readUIntBE(1, 6);
  // Expired, or claiming more than one TTL of life (cannot be minted by this code).
  if (now >= expires) return { ok: false, reason: "expired" };
  if (expires - now > TICKET_TTL_MS) return { ok: false, reason: "invalid" };
  const studio = bytesUuid(payload.subarray(7, 23));
  const owner = bytesUuid(payload.subarray(23, 39));
  if (studio !== args.binding.studioId.toLowerCase() || owner !== args.binding.ownerId.toLowerCase()) {
    return { ok: false, reason: "foreign" };
  }
  return {
    ok: true,
    clientId: bytesUuid(payload.subarray(39, 55)),
    day: intToDay(payload.readUInt32BE(55)),
    nonce: payload.subarray(59, 67).toString("hex"),
  };
}

/** The key under which a ticket's single use is recorded: a hash of the nonce, never an identifier. */
export const ticketUseKey = (nonce: string): string =>
  `print-ticket:${createHash("sha256").update(`hone/print-ticket/use/v1:${nonce}`).digest("hex")}`;
