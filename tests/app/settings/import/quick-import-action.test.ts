import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #257: Quick Import V1 action/page safety pins. The pure pipeline is
// covered by tests/lib/import/quick-import.test.ts; the live RLS write path by
// tests/db/quick-import.db.test.ts; the full flow by e2e/quick-import.spec.ts.
// These source-pins lock the non-negotiable safety posture of the server side.

const ROOT = path.resolve(__dirname, "../../../..");
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const ACTIONS = read("app/(app)/settings/import/actions.ts");
const ACTIONS_CODE = codeOnly(ACTIONS);
const PAGE = read("app/(app)/settings/import/page.tsx");
const LAYOUT = read("app/(app)/settings/layout.tsx");

describe("owner-gated, RLS-backed (no service role)", () => {
  it("the owner gate runs before any write", () => {
    expect(ACTIONS_CODE).toMatch(/practitioner\.role !== "owner"/);
    const gateIdx = ACTIONS_CODE.indexOf('!== "owner"');
    const firstInsert = ACTIONS_CODE.indexOf(".insert(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(gateIdx);
  });

  it("uses the RLS-backed authenticated client, never the service-role admin client", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTIONS_CODE).not.toMatch(/admin-server|createAdminClient|service_role|SERVICE_ROLE/);
  });

  it("the page is owner-gated and the nav exposes Import only to owners", () => {
    expect(PAGE).toMatch(/practitioner\.role !== "owner"/);
    expect(PAGE).toMatch(/Only studio owners can import/);
    // The nav entry sits inside the isOwner-only spread.
    const ownerBlock = LAYOUT.slice(LAYOUT.indexOf("isOwner"));
    expect(ownerBlock).toMatch(/href: "\/settings\/import"/);
  });
});

describe("writes ONLY import tables + clients; never clinical/booking/payment", () => {
  it("inserts only import_batches, clients, imported_treatment_memories", () => {
    const inserts = Array.from(
      ACTIONS_CODE.matchAll(/\.from\("([a-z_]+)"\)\s*\n?\s*\.insert/g),
    ).map((m) => m[1]);
    expect(new Set(inserts)).toEqual(
      new Set(["import_batches", "clients", "imported_treatment_memories"]),
    );
  });

  it("never touches live charting, booking, or payment tables", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /\.from\("(sessions|session_blocks|electrolysis_entries|laser_entries|appointments|appointment_payments|payment_charge_attempts)"\)/,
    );
  });

  it("never hard-deletes (correction is soft-void only)", () => {
    expect(ACTIONS_CODE).not.toMatch(/\.delete\(\)/);
    expect(ACTIONS_CODE).toMatch(/voided_at/);
  });
});

describe("no AI / OCR / external / file storage / raw-text logging", () => {
  it("makes no model, OCR, fetch, or upload calls", () => {
    expect(ACTIONS_CODE).not.toMatch(/anthropic|openai|\bocr\b/i);
    expect(ACTIONS_CODE).not.toMatch(/\bfetch\(|https?:\/\//);
    expect(ACTIONS_CODE).not.toMatch(/\.upload\(|storage\.from|\.from\("storage/);
  });

  it("does not log or persist the raw pasted text", () => {
    expect(ACTIONS_CODE).not.toMatch(/console\.(log|info|warn|error)\s*\([^)]*text/);
    // The raw text is only parsed, never inserted as a column value.
    expect(ACTIONS_CODE).not.toMatch(/raw_text|raw_csv|raw_tsv|original_text|csv_text/);
  });

  it("sends no emails / SMS / reminders / payments as a side effect", () => {
    expect(ACTIONS_CODE).not.toMatch(/sendEmail|sendSms|reminder|paymentIntents|stripe/i);
  });
});

describe("honest failure handling + safe matching", () => {
  it("never interpolates a raw DB error message into a user-facing string", () => {
    // Generic messages only — a raw DB error could carry a pasted email/phone.
    expect(ACTIONS_CODE).not.toMatch(/\.message\}/);
  });

  it("does not falsely promise that re-running will add the lost history", () => {
    expect(ACTIONS_CODE).not.toMatch(/re-run to add the history/i);
  });

  it("matches inserted clients via the single-source clientIdentityKey", () => {
    expect(ACTIONS).toMatch(/clientIdentityKey/);
  });
});
