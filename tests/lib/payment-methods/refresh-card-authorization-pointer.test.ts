import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #177. Source-grep tests pin the load-bearing shape of the
// refresh helper. The helper is a server-only async function that
// (1) reads candidate card rows, (2) filters to stale ones, and
// (3) writes the new signature id. Every load-bearing decision the
// helper makes is asserted here so a future refactor cannot
// silently widen the scope or weaken the safety posture.

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/payment-methods/refresh-card-authorization-pointer.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

describe("refreshActiveCardAuthorizationPointersForSignature: server boundary", () => {
  it("imports 'server-only' to lock the helper out of client trees", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient (service role)", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });

  it("uses inferStripeLivemode to scope by current env's livemode", () => {
    expect(HELPER).toMatch(/inferStripeLivemode\(\)/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: deadlock prevention", () => {
  it("does NOT import getCardAuthorizationStatus (would risk deadlock)", () => {
    expect(HELPER).not.toMatch(/import \{[^}]*getCardAuthorizationStatus/);
  });

  it("does NOT import getChargeReadyCardAuthorizationStatus (would risk deadlock)", () => {
    expect(HELPER).not.toMatch(
      /import \{[^}]*getChargeReadyCardAuthorizationStatus/,
    );
  });

  it("documents the deadlock-prevention reasoning in a comment", () => {
    expect(HELPER).toMatch(/deadlock/i);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: scoping", () => {
  it("filters by studio_id", () => {
    expect(HELPER).toMatch(/\.eq\("studio_id", args\.studioId\)/);
  });

  it("filters by client_id", () => {
    expect(HELPER).toMatch(/\.eq\("client_id", args\.clientId\)/);
  });

  it("filters by stripe_livemode (current env's livemode)", () => {
    expect(HELPER).toMatch(/\.eq\("stripe_livemode", livemode\)/);
  });

  it("filters by status='active'", () => {
    expect(HELPER).toMatch(/\.eq\("status", "active"\)/);
  });

  it("excludes removed cards via removed_at IS NULL", () => {
    expect(HELPER).toMatch(/\.is\("removed_at", null\)/);
  });

  it("does NOT cross studio_id when selecting candidates (verified by the .eq call)", () => {
    // negative: no .neq("studio_id", ...) anywhere
    expect(HELPER).not.toMatch(/\.neq\("studio_id"/);
  });

  it("does NOT cross client_id when selecting candidates", () => {
    expect(HELPER).not.toMatch(/\.neq\("client_id"/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: idempotency + stale-only", () => {
  it("filters candidates whose pointer is NOT already the new signature id", () => {
    // The filter step compares card.card_authorization_signature_id
    // to args.signatureId; non-equal (including NULL) rows are stale.
    expect(HELPER).toMatch(
      /\.filter\([\s\S]{0,200}!==\s*\n?\s*args\.signatureId/,
    );
  });

  it("early-returns ok:true rowsUpdated:0 when no candidates exist", () => {
    expect(HELPER).toMatch(/candidates\.length === 0/);
    expect(HELPER).toMatch(/\{ ok: true, rowsUpdated: 0 \}/);
  });

  it("early-returns ok:true rowsUpdated:0 when no stale candidates exist", () => {
    expect(HELPER).toMatch(/staleIds\.length === 0/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: write shape", () => {
  it("updates card_authorization_signature_id to the new signatureId", () => {
    expect(HELPER).toMatch(
      /\.update\(\{ card_authorization_signature_id: args\.signatureId \}\)/,
    );
  });

  it("scopes the update by id IN staleIds (not by studio/client again)", () => {
    expect(HELPER).toMatch(/\.in\("id", staleIds\)/);
  });

  it("returns the actual rowsUpdated count via .select('id')", () => {
    expect(HELPER).toMatch(/\.select\("id"\)/);
    expect(HELPER).toMatch(/updated\?\.length \?\? 0/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: fail-soft + ops_alert", () => {
  it("records a critical ops_alert on select error", () => {
    expect(HELPER).toMatch(
      /recordOpsAlert\(\{[\s\S]{0,500}severity:\s*"critical"[\s\S]{0,500}db_phase:\s*"select_candidates"/,
    );
  });

  it("records a critical ops_alert on update error", () => {
    expect(HELPER).toMatch(
      /recordOpsAlert\(\{[\s\S]{0,500}severity:\s*"critical"[\s\S]{0,500}db_phase:\s*"update_pointer"/,
    );
  });

  it("ops_alert events share the same name so an operator filters one event", () => {
    const events = HELPER.match(/event:\s*"([^"]+)"/g) ?? [];
    const names = events.map((e) => e.match(/"([^"]+)"/)?.[1]).filter(Boolean);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toBe("card_authorization_pointer_refresh_failed");
  });

  it("returns ok:false with reason='database_error' on either DB failure", () => {
    const matches = HELPER.match(/reason:\s*"database_error"/g) ?? [];
    // 1 type-union declaration + 1 select-err return + 1 update-err return = 3.
    expect(matches.length).toBe(3);
  });

  it("does NOT roll back the signature insert on refresh failure (no throw)", () => {
    // The helper returns an ok:false result; it does not throw, so
    // the caller's signature insert is preserved. Absence of
    // `throw new Error` or `throw` after the recordOpsAlert calls
    // pins that contract.
    const errorBlocks = HELPER.match(
      /recordOpsAlert\([\s\S]{0,1000}return \{[\s\S]{0,200}\};/g,
    );
    expect(errorBlocks).toBeTruthy();
    for (const block of errorBlocks ?? []) {
      expect(block).not.toMatch(/throw\s/);
    }
  });

  it("ops_alert safeDetails carries signature_id + db_code", () => {
    expect(HELPER).toMatch(/signature_id:\s*args\.signatureId/);
    expect(HELPER).toMatch(/db_code:\s*selectErr\.code/);
    expect(HELPER).toMatch(/db_code:\s*updateErr\.code/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: forbidden operations", () => {
  it("does NOT delete card rows", () => {
    expect(HELPER).not.toMatch(/\.delete\(\)/);
  });

  it("does NOT call Stripe", () => {
    expect(HELPER).not.toMatch(/getStripe\(\)|stripe\.|paymentIntents|setupIntents|customers\.create/);
  });

  it("does NOT modify status (only card_authorization_signature_id)", () => {
    // Pin the .update body shape to a single column.
    expect(HELPER).toMatch(
      /\.update\(\{ card_authorization_signature_id: args\.signatureId \}\)/,
    );
    expect(HELPER).not.toMatch(/\.update\(\{[\s\S]*status:/);
    expect(HELPER).not.toMatch(/\.update\(\{[\s\S]*removed_at:/);
  });

  it("does NOT modify any payment_charge_attempts row", () => {
    expect(HELPER).not.toMatch(/payment_charge_attempts/);
  });

  it("does NOT modify any manual_fee_charge_attempts row", () => {
    expect(HELPER).not.toMatch(/manual_fee_charge_attempts/);
  });
});

describe("refreshActiveCardAuthorizationPointersForSignature: result type contract", () => {
  it("declares both ok:true and ok:false variants of the result union", () => {
    expect(HELPER).toMatch(/ok: true;\s*rowsUpdated: number/);
    expect(HELPER).toMatch(
      /ok: false;\s*reason:\s*"database_error";\s*message: string/,
    );
  });
});
