import { createHash } from "node:crypto";

// PAY-CCY-09 (Codex P2 4265594520). The digest of the metadata a PaymentIntent
// was CREATED with, as the fake processor records it (lib/stripe/e2e-fake-stripe.ts
// fakeMetadataDigest). The fake ledger keeps only this digest, never the values:
// metadata carries client and authorization ids, and the ledger records no
// client identity.
//
// Canonical form: keys with a null, undefined or empty value are dropped (Stripe
// stores no empty metadata value), the rest are compared as strings, sorted by
// key. The server-side twin cannot be imported here (it is `server-only`), so
// tests/lib/stripe/e2e-fake-stripe.test.ts pins the two to the same output.
//
// Deliberately import-free beyond node:crypto, so a unit test can load it under
// the unit lane's hosted placeholder env (the other helpers import local-env,
// which refuses that env at import).
export function metadataDigest(
  metadata: Record<string, string | null | undefined> | null | undefined,
): string | null {
  if (!metadata) return null;
  const entries = Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
