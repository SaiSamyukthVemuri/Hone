import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseExportScope, type ExportScope } from "@/lib/clinical-records/export-scope";

// HON-46 (Codex P1 4303617257). THE PRINT AUDIT IS BOUND TO THE RENDERED
// PREVIEW. The print action used to take the client id and scope from the
// browser, so an owner could alter that payload and audit a DIFFERENT client
// or scope while printing the document on screen. Now the server mints this
// token when it renders a preview (after that preview's audit row is written),
// the page embeds it, and the print action accepts NOTHING ELSE: client and
// scope come from the verified token, never from the request.
//
// Claims: studio, client, the acting owner, the normalized scope, the id of
// the preview's own audit row, and when it was issued. Verified: signature
// (constant-time), studio and actor of the CURRENT request, issued-at not in
// the future, and age at most PRINT_TOKEN_TTL_MS.
//
// KEY. No new secret: APPOINTMENT_SIGNING_SECRET, the app's existing server
// HMAC key (already reused by the invitation proof cookie), with a DOMAIN
// prefix in the signed input, so a print token can never verify as a booking
// token or the reverse. If the key is missing this fails CLOSED: no token is
// minted and none verifies, so nothing prints unaudited.

const DOMAIN = "hone:hon46:records-print:v1";
export const PRINT_TOKEN_TTL_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

export type PrintClaims = {
  studioId: string;
  clientId: string;
  actorId: string;
  previewAuditId: string;
  scope: ExportScope;
  issuedAt: number;
};

function key(): string | null {
  const secret = process.env.APPOINTMENT_SIGNING_SECRET;
  return typeof secret === "string" && secret.length > 0 ? secret : null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${DOMAIN}.${payloadB64}`).digest();
}

/** A token for exactly this rendered preview, or null when signing is unavailable. */
export function mintPrintToken(claims: Omit<PrintClaims, "issuedAt">, now: number = Date.now()): string | null {
  const secret = key();
  if (!secret) return null;
  const body: PrintClaims = { ...claims, issuedAt: now };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(body)));
  return `${payloadB64}.${b64url(sign(payloadB64, secret))}`;
}

export type PrintTokenCheck =
  | { ok: true; claims: PrintClaims }
  | { ok: false; reason: "unavailable" | "malformed" | "bad_signature" | "wrong_studio" | "wrong_actor" | "expired" };

/** Verify a token for the CURRENT request's studio and actor. */
export function verifyPrintToken(
  token: unknown,
  expected: { studioId: string; actorId: string },
  now: number = Date.now(),
): PrintTokenCheck {
  const secret = key();
  if (!secret) return { ok: false, reason: "unavailable" };
  if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payloadB64, sigB64] = parts;

  const expectedSig = sign(payloadB64, secret);
  const givenSig = fromB64url(sigB64);
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: PrintClaims;
  try {
    claims = JSON.parse(fromB64url(payloadB64).toString("utf8")) as PrintClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !claims ||
    typeof claims.studioId !== "string" ||
    typeof claims.clientId !== "string" ||
    typeof claims.actorId !== "string" ||
    typeof claims.previewAuditId !== "string" ||
    typeof claims.issuedAt !== "number" ||
    !claims.scope
  ) {
    return { ok: false, reason: "malformed" };
  }
  // The scope is re-validated exactly as a URL scope is, never trusted raw.
  const s = claims.scope as Partial<Record<string, string>>;
  const reparsed = parseExportScope({
    scope: s.kind,
    session: s.sessionId,
    day: s.day,
    from: s.from,
    to: s.to,
  });
  if (!reparsed.ok) return { ok: false, reason: "malformed" };

  if (claims.studioId !== expected.studioId) return { ok: false, reason: "wrong_studio" };
  if (claims.actorId !== expected.actorId) return { ok: false, reason: "wrong_actor" };
  if (claims.issuedAt > now + CLOCK_SKEW_MS || now - claims.issuedAt > PRINT_TOKEN_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims: { ...claims, scope: reparsed.scope } };
}
