import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phase B2.4 — the OAuth CALLBACK credential boundary, verified by SOURCE PIN.
// The callback runs on the Node runtime with a real Supabase session + Google
// round-trips, so the Vitest node env cannot execute it. Instead we pin the exact
// structure that makes it safe: single-use state consumed BEFORE any persist;
// destination/account/scope gates ALL BEFORE the one atomic credential
// replacement (persistConnectedFromCallback). A partial or wrong grant preserves
// the PREVIOUS credentials and stores nothing.
const SRC = readFileSync(
  join(process.cwd(), "app/api/google-calendar/oauth/callback/route.ts"),
  "utf8",
);

// Index of the ACTUAL call site (not the import) of the credential-replacement fn.
const PERSIST_CALL = SRC.indexOf("await persistConnectedFromCallback(");

describe("callback boundary — state consumed before persist", () => {
  it("consumes the single-use OAuth state", () => {
    expect(SRC).toMatch(/consumeOAuthState\(\{ state, nonce, userId: user\.id \}\)/);
  });
  it("the credential replacement has exactly one call site", () => {
    expect(PERSIST_CALL).toBeGreaterThan(-1);
    // Exactly one `await persistConnectedFromCallback(` invocation (the atomic
    // boundary); other name mentions are the import + the boundary comment.
    const callSites = SRC.split("await persistConnectedFromCallback(").length - 1;
    expect(callSites).toBe(1);
  });
  it("consumeOAuthState runs BEFORE the credential replacement", () => {
    expect(SRC.indexOf("consumeOAuthState(")).toBeGreaterThan(-1);
    expect(SRC.indexOf("consumeOAuthState(")).toBeLessThan(PERSIST_CALL);
  });
});

describe("callback boundary — uses the exact destination-scope helpers", () => {
  it("imports/uses normalizeGrantedScopes, hasRequiredEventScopes, requiredEventScopeFor", () => {
    expect(SRC).toMatch(/normalizeGrantedScopes/);
    expect(SRC).toMatch(/hasRequiredEventScopes/);
    expect(SRC).toMatch(/requiredEventScopeFor/);
  });
  it("normalizes the granted scopes from the token response (primary) with a tokeninfo fallback", () => {
    expect(SRC).toMatch(/grantedScopes = normalizeGrantedScopes\(token\.grantedScopes\)/);
    expect(SRC).toMatch(/grantedScopes\.length === 0[\s\S]{0,120}fetchTokenInfoScopes/);
  });
});

describe("callback boundary — boundMode / destination_changed gate", () => {
  it("has a boundMode branch returning destination_changed when the mode differs", () => {
    expect(SRC).toMatch(/const boundMode = consumed\.destinationMode/);
    expect(SRC).toMatch(/existing\.destinationMode !== boundMode/);
    expect(SRC).toMatch(/"destination_changed"/);
  });
  it("destination_changed is returned BEFORE the credential replacement (pre-replacement)", () => {
    const idx = SRC.indexOf('"destination_changed"');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(PERSIST_CALL);
  });
});

describe("callback boundary — partial/wrong-scope grant is pre-replacement", () => {
  it("returns event_scope_not_granted when the exact destination scope is missing", () => {
    expect(SRC).toMatch(/!hasRequiredEventScopes\(boundMode, grantedScopes\)/);
    expect(SRC).toMatch(/"event_scope_not_granted"/);
  });
  it("event_scope_not_granted is returned BEFORE the credential replacement (no persist)", () => {
    const idx = SRC.indexOf('"event_scope_not_granted"');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(PERSIST_CALL);
  });
});

describe("callback boundary — account-switch protection", () => {
  it("rejects a returned identity that differs from the stored account => account_mismatch", () => {
    expect(SRC).toMatch(/existingAccountId !== null && existingAccountId !== info\.sub/);
    expect(SRC).toMatch(/"account_mismatch"/);
  });
  it("account_mismatch is returned BEFORE the credential replacement (never overwrite)", () => {
    const idx = SRC.indexOf('"account_mismatch"');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(PERSIST_CALL);
  });
});

describe("callback boundary — the removed broad scope + no event I/O", () => {
  it("does NOT import or reference the removed broad EVENT_WRITE_SCOPE", () => {
    expect(SRC).not.toMatch(/EVENT_WRITE_SCOPE/);
  });
  it("does NOT enqueue, sync, or write any Google event (setup only)", () => {
    expect(SRC).not.toMatch(/calendar_sync_outbox|calendar_event_links|events\.(insert|patch|delete)/);
  });
});
