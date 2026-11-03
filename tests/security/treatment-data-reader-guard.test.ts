import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Roles R4 (OPS, 3 Nov): every reader of treatment data is classified, so readers stop being found one at a time. A file under app/, lib/
// or components/ that reads one of the protected tables (directly with .from("t") or embedded in a select string) must either
//   (a) contain a clin.view_records / clin.view_intake / clin.view_photos check (GATED), or
//   (b) appear in ALLOW below with a class and a reason; caller-gated files also name the callers that must contain a check.
// A NEW reader that is neither fails here. Add the check, or add an ALLOW row with a real reason and get it reviewed.
const TABLES = "sessions|session_blocks|session_block_areas|electrolysis_entries|laser_entries|treatment_plans|treatment_plan_stages|client_clinical_notes|client_intake_forms|imported_treatment_memories";
const DIRECT = new RegExp(`\\.from\\(\\s*["'](${TABLES})["']`);
const EMBED = new RegExp(`(?<![\\w.])(?:\\w+:)?(${TABLES})\\s*(?:!\\w+)?\\(`);
const KEYS = ["clin.view_records", "clin.view_intake", "clin.view_photos"];

type Cls = "owner-only" | "operator-only" | "write-path" | "system-side" | "attribution-only" | "status-only" | "billing-owner" | "caller-gated";
const ALLOW: Record<string, { cls: Cls; why: string; callers?: string[] }> = {
  "app/(app)/settings/data/actions.ts": { cls: "owner-only", why: "owner data export; the owner holds every key" },
  "app/(app)/settings/data/page.tsx": { cls: "owner-only", why: "owner data export page" },
  "app/(app)/settings/import/actions.ts": { cls: "owner-only", why: "owner import of treatment memories (write)" },
  "app/admin/studios/[id]/page.tsx": { cls: "operator-only", why: "operator admin, not a studio role" },
  "app/(app)/clients/[id]/clinical-notes-actions.ts": { cls: "write-path", why: "add/revise note actions; clin.edit_records not wired yet, legacy checks stand" },
  "app/(app)/clients/[id]/treatment-plans-actions.ts": { cls: "write-path", why: "plan write actions" },
  "app/(app)/clients/[id]/intake/actions.ts": { cls: "write-path", why: "intake write actions; clin.edit_intake not wired yet" },
  "app/(app)/clients/[id]/images/actions.ts": { cls: "write-path", why: "photo upload/delete resolve their own session; photos key gates the page" },
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts": { cls: "write-path", why: "session write actions" },
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts": { cls: "write-path", why: "block write actions" },
  "app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions.ts": { cls: "write-path", why: "copy write action" },
  "app/(app)/clients/[id]/sessions/new/actions.ts": { cls: "write-path", why: "session create action" },
  "app/intake/[token]/actions.ts": { cls: "system-side", why: "the client's own tokened intake form" },
  "app/intake/[token]/page.tsx": { cls: "system-side", why: "the client's own tokened intake form" },
  "app/api/cron/appointment-reminders/route.ts": { cls: "system-side", why: "cron; reads intake status for reminders, no practitioner viewer" },
  "lib/portal/queries.ts": { cls: "system-side", why: "client portal, the client's own data" },
  "lib/billing/appointment-payment-state.ts": { cls: "billing-owner", why: "payment state is owner-only (HON-44)" },
  "lib/billing/authoritative-session-payment.ts": { cls: "billing-owner", why: "payment ledger path, owner-only" },
  "lib/billing/quick-checkout.ts": { cls: "billing-owner", why: "checkout is owner-only (HON-44)" },
  "lib/billing/session-payment-eligibility.ts": { cls: "billing-owner", why: "payment eligibility, owner-only" },
  "app/(app)/calendar/check-practitioner/page.tsx": { cls: "attribution-only", why: "reads only who performed a visit (performed_by_practitioner_id), no treatment content" },
  "lib/sessions/session-lineage.ts": { cls: "write-path", why: "asserts a session belongs to a client before a write; returns no data" },
  "lib/machines/machine-queries.ts": { cls: "caller-gated", why: "machine registry plus recorded setups; settings page owner-only, setup reads from the gated session page", callers: ["app/(app)/clients/[id]/sessions/[sessionId]/page.tsx"] },
  "lib/dashboard/intakes-awaiting-review.ts": { cls: "status-only", why: "client id, status and created_at only; never answers" },
  "lib/clients/directory-read.ts": { cls: "status-only", why: "client id, status and created_at only; never answers" },
  "lib/intake/queries.ts": {
    cls: "caller-gated",
    why: "loaders are shared with system paths (booking, reminders, portal) that have no practitioner viewer; every practitioner caller asks clin.view_intake",
    callers: ["app/(app)/clients/[id]/page.tsx", "app/(app)/calendar/[id]/page.tsx", "app/(app)/clients/[id]/intake/page.tsx", "app/(app)/clients/[id]/intake/assist/page.tsx"],
  },
  "lib/clinical-notes/queries.ts": {
    cls: "caller-gated",
    why: "loaders take a client id only (no studio to ask with); every practitioner caller asks clin.view_records",
    callers: ["app/(app)/clients/[id]/page.tsx", "app/(app)/calendar/[id]/page.tsx", "app/(app)/clients/[id]/clinical-notes/print/page.tsx"],
  },
  "lib/supabase/queries.ts": {
    cls: "caller-gated",
    why: "client and session loaders; every practitioner caller asks clin.view_records (getClientById also takes includeSessions)",
    callers: ["app/(app)/clients/[id]/page.tsx", "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "app/(app)/clients/[id]/sessions/new/page.tsx"],
  },
};

const read = (p: string) => readFileSync(p, "utf8");
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
function readsProtectedTable(src: string): boolean {
  if (DIRECT.test(src)) return true;
  for (const m of src.matchAll(/\.select\(\s*([`"'])((?:\\.|(?!\1).)*)\1/gs)) if (EMBED.test(m[2]!)) return true;
  return false;
}
const hasKey = (src: string) => KEYS.some((k) => src.includes(`"${k}"`));

const readers = ["app", "lib", "components"].flatMap(walk).filter((f) => readsProtectedTable(read(f)));

describe("every reader of treatment data is gated or classified", () => {
  it("finds the readers (the scan itself is alive)", () => {
    expect(readers.length).toBeGreaterThan(30);
  });

  it("no reader sits outside both the gated set and the allow-list", () => {
    const unclassified = readers.filter((f) => !hasKey(read(f)) && !ALLOW[f]);
    expect(unclassified, `ungated, unclassified readers of treatment data:\n${unclassified.join("\n")}`).toEqual([]);
  });

  it("every allow-list row names a file that still reads a protected table (no stale rows)", () => {
    for (const f of Object.keys(ALLOW)) {
      expect(existsSync(f), `${f} no longer exists`).toBe(true);
      expect(readers.includes(f), `${f} no longer reads a protected table; remove its row`).toBe(true);
    }
  });

  it("every caller-gated loader's callers really ask a key", () => {
    for (const [f, row] of Object.entries(ALLOW)) {
      if (row.cls !== "caller-gated") continue;
      expect(row.callers?.length, `${f} must name its callers`).toBeGreaterThan(0);
      for (const c of row.callers!) expect(hasKey(read(c)), `${c} calls ${f} without a clin.view_* check`).toBe(true);
    }
  });

  it("every allow-list row states a reason", () => {
    for (const [f, row] of Object.entries(ALLOW)) expect(row.why.length, f).toBeGreaterThan(15);
  });
});
