import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utilities ship without type declarations
import { classify, STORAGE_DB_TEST, WEBKIT_PAYMENT_SEEDS } from "../../scripts/classify-changes.mjs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { forwardClosure } from "../../scripts/import-graph.mjs";

// CI-SELECT-03. storage-photos used to start on ANY database change and webkit-hon-62 on ANY payment change. Each now starts only when a changed
// file can alter what that lane executes, and fails safe (unreadable migration, shared infrastructure, the full matrix).
type R = { storage_photos: boolean; webkit_surface: boolean; database: boolean; payment: boolean; full_matrix_required: boolean };
const c = (...f: string[]) => classify(f) as R;

describe("storage_photos: only a diff that can touch storage starts the storage lane", () => {
  it("a database change that names no storage does not", () => {
    const r = c("supabase/migrations/0391_retire_direct_public_lead_inserts.sql");
    expect(r.database).toBe(true);
    expect(r.storage_photos).toBe(false);
  });
  it("a migration that names storage, buckets or treatment images does", () => {
    expect(c("supabase/migrations/0099_treatment_image_notes.sql").storage_photos).toBe(true);
    expect(c("supabase/migrations/0093_harden_treatment_image_storage.sql").storage_photos).toBe(true);
  });
  it("the signed-URL DB test, everything it imports, the photo libraries and storage config do", () => {
    for (const f of [STORAGE_DB_TEST, "lib/images/upload.ts", "supabase/config.toml", "tests/db/helpers/harness.ts"]) expect(c(f).storage_photos, f).toBe(true);
    const closure = forwardClosure(process.cwd(), [STORAGE_DB_TEST]) as Set<string>;
    expect(closure.has(STORAGE_DB_TEST)).toBe(true);
    expect(closure.size).toBeGreaterThan(1);
    for (const f of closure) if (/^(lib|tests\/db\/helpers)\//.test(f)) expect(c(f).storage_photos, f).toBe(true);
  });
  it("FAIL-SAFE: an unreadable migration, shared infrastructure and the full matrix all do", () => {
    expect(c("supabase/migrations/0999_not_in_tree.sql").storage_photos).toBe(true);
    expect(c("lib/supabase/server.ts").storage_photos).toBe(true);
    expect(c("package.json").storage_photos).toBe(true);
  });
  it("a mixed diff is judged by its most storage-touching file", () => {
    expect(c("supabase/migrations/0391_retire_direct_public_lead_inserts.sql", "supabase/migrations/0099_treatment_image_notes.sql").storage_photos).toBe(true);
  });
  it("a documentation-only or unrelated application diff does not", () => {
    expect(c("docs/README.md").storage_photos).toBe(false);
    expect(c("app/(app)/financials/analytics/charts.tsx").storage_photos).toBe(false);
  });
});

describe("webkit_surface: only the quick-checkout surface of the payment lane starts WebKit", () => {
  it("the payment lane without the quick-checkout surface does not", () => {
    const r = c("lib/billing/stripe-webhook.ts");
    expect(r.payment).toBe(true);
    expect(r.webkit_surface).toBe(false);
  });
  it("quick checkout, everything its specs import, the payment e2e and the payment fixtures do", () => {
    for (const f of [...WEBKIT_PAYMENT_SEEDS, "lib/billing/quick-checkout.ts", "e2e-payment/helpers/payment-fixture.ts", "playwright.payment.config.ts", "tests/db/helpers/payment-seed.ts"]) {
      expect(c(f).webkit_surface, f).toBe(true);
    }
    const closure = forwardClosure(process.cwd(), WEBKIT_PAYMENT_SEEDS) as Set<string>;
    for (const f of closure) if (/^(lib|components)\//.test(f)) expect(c(f).webkit_surface, f).toBe(true);
  });
  it("a payment migration does, an unrelated one does not, an unreadable one does", () => {
    expect(c("supabase/migrations/0093_harden_treatment_image_storage.sql").webkit_surface).toBe(true);
    expect(c("supabase/migrations/0391_retire_direct_public_lead_inserts.sql").webkit_surface).toBe(false);
    expect(c("supabase/migrations/0999_not_in_tree.sql").webkit_surface).toBe(true);
  });
  it("FAIL-SAFE: the full matrix and shared infrastructure do; a mixed diff is judged by its most WebKit-touching file", () => {
    expect(c("package.json").webkit_surface).toBe(true);
    expect(c("lib/billing/stripe-webhook.ts", "components/quick-checkout-modal.tsx").webkit_surface).toBe(true);
  });
});
