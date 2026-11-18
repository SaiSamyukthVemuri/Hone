import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #257: Quick Import V1 action safety pins. The pure pipeline is covered by
// tests/lib/import/quick-import.test.ts; the live RLS write path by
// tests/db/quick-import.db.test.ts; the full flow by e2e/quick-import.spec.ts;
// the owner + operator gate (zero writes on denial) by
// ./operator-assisted-gate.test.ts. These source-pins lock the absence
// properties a behavioural test cannot see.

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
const GATE = read("lib/import/operator-assist.ts");
const GATE_CODE = codeOnly(GATE);

describe("RLS-backed (no service role)", () => {
  it("uses the RLS-backed authenticated client, never the service-role admin client", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTIONS_CODE).not.toMatch(/admin-server|createAdminClient|service_role|SERVICE_ROLE/);
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

describe("honest failure handling", () => {
  it("never interpolates a raw DB error message into a user-facing string", () => {
    // Generic messages only — a raw DB error could carry a pasted email/phone.
    expect(ACTIONS_CODE).not.toMatch(/\.message\}/);
  });
});

// IMPORT-01 — operator-assisted only. The behavioural proof (real actions,
// recording stub, zero writes on denial) lives in
// ./operator-assisted-gate.test.ts, which drives the two exported actions. A
// THIRD exported action would be an entry point that proof never calls.

describe("IMPORT-01: the gated actions are the only entry points", () => {
  it("BOTH actions route through the one gated helper — no second entry point", () => {
    const exported = Array.from(
      ACTIONS_CODE.matchAll(/export async function (\w+)/g),
    ).map((m) => m[1]);
    expect(new Set(exported)).toEqual(
      new Set(["previewImportAction", "confirmImportAction"]),
    );
  });

  it("the gate introduces no service-role client", () => {
    expect(GATE_CODE).not.toMatch(
      /admin-server|createAdminClient|service_role|SERVICE_ROLE/,
    );
  });
});
