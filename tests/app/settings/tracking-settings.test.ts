import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source pins for the owner-only, self-serve tracking settings (no DOM here).
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const ACTIONS = read("app/(app)/settings/tracking/actions.ts");
const PAGE = read("app/(app)/settings/tracking/page.tsx");
const FORM = read("app/(app)/settings/tracking/TrackingProviderForm.tsx");

describe("tracking settings — owner-gated + encrypted-at-rest", () => {
  it("every action rejects non-owners", () => {
    expect(ACTIONS).toMatch(/practitioner\.role !== "owner"/);
    expect(ACTIONS).toMatch(/requireOwner/);
  });

  it("encrypts the token before storing; stores ciphertext + last4, never raw", () => {
    expect(ACTIONS).toMatch(/encryptTrackingProviderToken\(rawToken\)/);
    expect(ACTIONS).toMatch(/patch\.encrypted_server_token = enc\.encrypted/);
    expect(ACTIONS).toMatch(/patch\.server_token_last4 = enc\.last4/);
    // The raw token is never written to any column.
    expect(ACTIONS).not.toMatch(/(server_token|token)\s*:\s*rawToken/);
  });

  it("never logs the token (no console/logger lines referencing the raw token)", () => {
    expect(ACTIONS).not.toMatch(/console\.[a-z]+\([^)]*rawToken/);
    expect(ACTIONS).not.toMatch(/console\.[a-z]+\([^)]*token/i);
  });

  it("blank token keeps the existing one (add/rotate distinguished by added_at)", () => {
    expect(ACTIONS).toMatch(/if \(rawToken\) \{/);
    expect(ACTIONS).toMatch(/server_token_rotated_at/);
    expect(ACTIONS).toMatch(/server_token_added_at/);
  });

  it("clear/delete token sets absent + disables (cannot send without a token)", () => {
    expect(ACTIONS).toMatch(/encrypted_server_token: null/);
    expect(ACTIONS).toMatch(/token_status: "absent"/);
    expect(ACTIONS).toMatch(/enabled: false/);
  });
});

describe("tracking settings — the encrypted token never reaches the client", () => {
  it("the server page selects only redacted status, NOT encrypted_server_token", () => {
    expect(PAGE).toMatch(/server_token_last4/);
    expect(PAGE).not.toMatch(/select\([^)]*encrypted_server_token/);
    expect(PAGE).toMatch(/practitioner\.role !== "owner"/);
  });

  it("the client form is write-only for the token (never pre-filled, shows only last4)", () => {
    expect(FORM).toMatch(/type="password"/);
    // token starts empty and is not seeded from any incoming value
    expect(FORM).toMatch(/useState\(""\)/);
    expect(FORM).not.toMatch(/encrypted_server_token/);
    expect(FORM).toMatch(/tokenLast4/);
  });
});
