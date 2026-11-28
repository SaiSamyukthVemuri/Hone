import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - .mjs utilities ship without type declarations
import { classify, STORAGE_DB_TEST, WEBKIT_PAYMENT_SEEDS, storagePolicyDeps, touchesStorageDeps } from "../../scripts/classify-changes.mjs";
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

describe("storage_photos: a migration that redefines what the storage policies call or read starts the lane", () => {
  const real = storagePolicyDeps(process.cwd()) as { fns: string[]; tables: string[] };

  it("the dependency list is derived from the policies in the tree and contains the membership helper and its table", () => {
    expect(real.fns).toContain("is_studio_member");
    expect(real.tables).toContain("practitioners");
  });

  it("is derived, not hard-coded: a fixture tree with its own policy yields its own helper and table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "storage-deps-"));
    mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
    const w = (n: string, t: string) => writeFileSync(path.join(root, "supabase/migrations", n), t);
    w("0001_a.sql", "create or replace function public.can_see_blob(x uuid) returns boolean language sql as $$ select exists (select 1 from public.blob_owners where id = x) $$;");
    w("0002_b.sql", 'create policy "p" on storage.objects for select using (public.can_see_blob(owner::uuid));');
    w("0003_c.sql", "create or replace function public.unrelated() returns int language sql as $$ select 1 $$;");
    const d = storagePolicyDeps(root) as { fns: string[]; tables: string[] };
    expect(d.fns).toEqual(["can_see_blob"]);
    expect(d.tables).toEqual(["blob_owners"]);
    expect(touchesStorageDeps("create or replace function public.can_see_blob(x uuid) returns boolean as $$ select true $$;", d)).toBe(true);
    expect(touchesStorageDeps("alter table public.blob_owners add column z int;", d)).toBe(true);
    expect(touchesStorageDeps("create or replace function public.unrelated() returns int as $$ select 2 $$;", d)).toBe(false);
  });

  it("a migration redefining is_studio_member, or altering the membership table, names no storage word and still starts storage_photos", () => {
    const redefine = "create or replace function public.is_studio_member(target_studio_id uuid) returns boolean language sql as $$ select true $$;";
    expect(/storage\.|\bbucket|treatment_image|photo|signed/i.test(redefine)).toBe(false);
    expect(touchesStorageDeps(redefine, real)).toBe(true);
    expect(touchesStorageDeps("alter table public.practitioners add column nickname text;", real)).toBe(true);
    expect(touchesStorageDeps("create table public.unrelated_widgets (id int);", real)).toBe(false);
  });

  it("end to end through classify: a real migration that only alters the membership table starts the lane", () => {
    expect(c("supabase/migrations/0023_practitioner_color.sql").storage_photos).toBe(true);
  });

  it("an empty diff (a re-run) runs everything: both non-required lane flags are true with the full matrix", () => {
    const r = c();
    expect(r.full_matrix_required).toBe(true);
    expect(r.storage_photos).toBe(true);
    expect(r.webkit_surface).toBe(true);
  });
});

describe("storage_photos: grant hardening, policies and triggers on what the storage policies depend on", () => {
  const real = storagePolicyDeps(process.cwd()) as { fns: string[]; tables: string[] };
  const STORAGE_WORDS = /storage\.|\bbucket|treatment_image|photo|signed/i;

  it("REVOKE EXECUTE ON FUNCTION public.is_studio_member starts storage_photos", () => {
    const t = "revoke execute on function public.is_studio_member(uuid) from anon;";
    expect(STORAGE_WORDS.test(t)).toBe(false);
    expect(touchesStorageDeps(t, real)).toBe(true);
    expect(touchesStorageDeps("grant execute on function public.is_studio_member(uuid) to authenticated;", real)).toBe(true);
  });

  it("GRANT and REVOKE on a derived table, and policies and triggers on one, start it; the same on an unrelated table do not", () => {
    for (const t of [
      "revoke insert, update, delete on public.appointments from authenticated;",
      "grant select on table public.practitioners to authenticated;",
      'create policy "x" on public.practitioners for select using (true);',
      'drop policy if exists "x" on public.practitioners;',
      "create constraint trigger t after insert on public.studio_receptionists deferrable initially deferred for each row execute function public.f();",
      "alter table public.practitioners disable trigger all;",
    ]) expect(touchesStorageDeps(t, real), t).toBe(true);
    for (const t of [
      "revoke insert on public.unrelated_widgets from authenticated;",
      'create policy "x" on public.unrelated_widgets for select using (true);',
      "revoke execute on function public.unrelated_fn(uuid) from anon;",
    ]) expect(touchesStorageDeps(t, real), t).toBe(false);
  });

  it("a real grant-hardening migration (0172, revokes DML on appointments) starts the lane through classify with no storage word in it", async () => {
    const { readFileSync } = await import("node:fs");
    expect(STORAGE_WORDS.test(readFileSync("supabase/migrations/0172_revoke_authenticated_appointment_dml.sql", "utf8"))).toBe(false);
    expect(c("supabase/migrations/0172_revoke_authenticated_appointment_dml.sql").storage_photos).toBe(true);
  });

  it("a function a policy calls is in the set BEFORE its definition is parsed: an unparseable or undefined one is still watched", () => {
    const root = mkdtempSync(path.join(tmpdir(), "storage-deps-"));
    mkdirSync(path.join(root, "supabase/migrations"), { recursive: true });
    const w = (n: string, t: string) => writeFileSync(path.join(root, "supabase/migrations", n), t);
    // can_see_blob has no `$$ ... $$` body anywhere (defined by a tool, or in a form the parser does not read); the policy still calls it.
    w("0001_a.sql", 'create policy "p" on storage.objects for select using (public.can_see_blob(owner::uuid));');
    const d = storagePolicyDeps(root) as { fns: string[]; tables: string[] };
    expect(d.fns).toEqual(["can_see_blob"]);
    expect(touchesStorageDeps("revoke execute on function public.can_see_blob(uuid) from anon;", d)).toBe(true);
    expect(touchesStorageDeps("create or replace function public.can_see_blob(x uuid) returns boolean as 'select true' language sql;", d)).toBe(true);
  });
});
