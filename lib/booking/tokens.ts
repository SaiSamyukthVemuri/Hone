import { createHmac, timingSafeEqual } from "crypto";

// HMAC-signed cancellation token payload.
// Format: base64url(payload).base64url(signature)
// payload = JSON { appointment_id, expires_at }
// signature = HMAC-SHA256(payload, secret)

type Payload = {
  appointment_id: string;
  expires_at: string; // ISO timestamp
};

// Booking tokens REQUIRE a dedicated APPOINTMENT_SIGNING_SECRET. The
// previous fallback to the Supabase service-role key was unsafe: signing
// cancellation/reschedule tokens with the bypass-RLS service-role key
// means any leak of that key (e.g. an accidental client-side import)
// would also hand over token-signing power. Mirrors lib/intake/tokens.ts.
//
// Deployment requirement: set APPOINTMENT_SIGNING_SECRET to a high-entropy
// random string (>= 32 bytes) in every environment. Apps that fail to set
// it fail fast server-side rather than silently signing with a fallback.
function getSecret(): string {
  const secret = process.env.APPOINTMENT_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      "APPOINTMENT_SIGNING_SECRET is not set. " +
        "Generate a fresh random secret (>= 32 bytes) and set it in env. " +
        "The previous service-role-key fallback has been removed.",
    );
  }
  return secret;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(
    createHmac("sha256", secret).update(payload).digest(),
  );
}

export function generateCancellationToken(
  appointmentId: string,
  expiresAt: Date,
): string {
  const payload: Payload = {
    appointment_id: appointmentId,
    expires_at: expiresAt.toISOString(),
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = sign(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; appointment_id: string; expires_at: Date }
  | { ok: false; error: "malformed" | "bad_signature" | "expired" };

export function verifyCancellationToken(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, error: "malformed" };
  }
  const [payloadB64, sigB64] = parts;

  let expectedSig: string;
  try {
    expectedSig = sign(payloadB64, getSecret());
  } catch {
    return { ok: false, error: "malformed" };
  }
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: Payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    typeof payload.appointment_id !== "string" ||
    typeof payload.expires_at !== "string"
  ) {
    return { ok: false, error: "malformed" };
  }
  const expiresAt = new Date(payload.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: "malformed" };
  }
  if (expiresAt.getTime() < Date.now()) {
    return { ok: false, error: "expired" };
  }
  return { ok: true, appointment_id: payload.appointment_id, expires_at: expiresAt };
}
