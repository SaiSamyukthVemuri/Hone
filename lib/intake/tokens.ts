import { createHmac, timingSafeEqual } from "crypto";

// HMAC-signed intake token payload.
// Format: base64url(payload).base64url(signature)
// payload = JSON { intake_id, expires_at }
// signature = HMAC-SHA256(payload, secret)
//
// Mirrors lib/booking/tokens.ts. Kept separate so the two link kinds can
// rotate secrets independently if we ever need to invalidate one set.

type Payload = {
  intake_id: string;
  expires_at: string;
};

function getSecret(): string {
  const secret =
    process.env.INTAKE_SIGNING_SECRET ||
    process.env.APPOINTMENT_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "INTAKE_SIGNING_SECRET (or APPOINTMENT_SIGNING_SECRET / SUPABASE_SERVICE_ROLE_KEY fallback) is not set",
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

export function generateIntakeToken(intakeId: string, expiresAt: Date): string {
  const payload: Payload = {
    intake_id: intakeId,
    expires_at: expiresAt.toISOString(),
  };
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = sign(payloadB64, getSecret());
  return `${payloadB64}.${sig}`;
}

export type VerifyResult =
  | { ok: true; intake_id: string; expires_at: Date }
  | { ok: false; error: "malformed" | "bad_signature" | "expired" };

export function verifyIntakeToken(token: string): VerifyResult {
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
    typeof payload.intake_id !== "string" ||
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
  return { ok: true, intake_id: payload.intake_id, expires_at: expiresAt };
}
