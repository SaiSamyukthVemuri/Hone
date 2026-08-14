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
const PAGE_CODE = codeOnly(PAGE);
const LAYOUT = read("app/(app)/settings/layout.tsx");
const GATE = read("lib/import/operator-assist.ts");
const GATE_CODE = codeOnly(GATE);

// --- bounded per-function extraction ---------------------------------------
//
// Structural pins about "the gate comes before the write" are only meaningful
// when the slice they examine is ONE function. Slicing to end-of-file lets a
// later function's inserts answer an earlier function's question.
//
// Boundaries are the file's TOP-LEVEL function declarations, column 0, `^`
// under the `m` flag. Nested helpers (`const softVoidBatch = async …`) are
// indented and are therefore correctly kept INSIDE their parent's body rather
// than treated as a boundary. Each slice runs to the next boundary, or to EOF
// for the last function. `braceBalance` is the self-check that the boundary
// landed on a real declaration edge; the "extractor is not lying" test asserts
// it, so a boundary regex that stopped matching cannot pass silently.

const TOP_LEVEL_FN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;

function functionBounds(src: string): Map<string, [number, number]> {
  const starts: Array<[string, number]> = [];
  for (const m of src.matchAll(TOP_LEVEL_FN)) {
    starts.push([m[1], m.index!]);
  }
  const out = new Map<string, [number, number]>();
  starts.forEach(([name, start], i) => {
    out.set(name, [start, starts[i + 1]?.[1] ?? src.length]);
  });
  return out;
}

const ACTION_BOUNDS = functionBounds(ACTIONS_CODE);

function actionBody(name: string): string {
  const span = ACTION_BOUNDS.get(name);
  if (!span) throw new Error(`top-level function ${name} not found`);
  return ACTIONS_CODE.slice(span[0], span[1]);
}

/** Net `{` minus `}`, ignoring braces inside string and template literals. */
function braceBalance(src: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
  }
  return depth;
}

/** Every PostgREST mutation verb. Absence claims are checked against all. */
const WRITE_VERBS = [
  ".insert(",
  ".update(",
  ".upsert(",
  ".delete(",
  ".rpc(",
] as const;

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
    // Generic messages only: a raw DB error could carry a pasted email/phone.
    expect(ACTIONS_CODE).not.toMatch(/\.message\}/);
  });

  it("does not falsely promise that re-running will add the lost history", () => {
    expect(ACTIONS_CODE).not.toMatch(/re-run to add the history/i);
  });

  it("matches inserted clients via the single-source clientIdentityKey", () => {
    expect(ACTIONS).toMatch(/clientIdentityKey/);
  });
});

// ---------------------------------------------------------------------------
// IMPORT-01, operator-assisted only, until the staged rebuild exists
// ---------------------------------------------------------------------------
//
// The behavioural proof (real actions, recording stub, zero writes on denial)
// lives in ./operator-assisted-gate.test.ts. These are the structural pins:
// they catch the shapes a behavioural test cannot see, a gate quietly moved
// after a write, a second executable island appearing on the page, the page
// and the server drifting into two different stories.

describe("IMPORT-01: execution is gated on the server, before any write", () => {
  it("the operator gate is imported and called inside the shared gate helper", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/import\/operator-assist"/);
    expect(ACTIONS_CODE).toMatch(/await isImportOperator\(\)/);
  });

  it("the gate runs BEFORE the first statement of either action", () => {
    const gateIdx = ACTIONS_CODE.indexOf("isImportOperator()");
    const firstInsert = ACTIONS_CODE.indexOf(".insert(");
    const firstUpdate = ACTIONS_CODE.indexOf(".update(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(firstInsert).toBeGreaterThan(gateIdx);
    expect(firstUpdate).toBeGreaterThan(gateIdx);
  });

  it("BOTH actions route through the one gated helper, no second entry point", () => {
    const exported = Array.from(
      ACTIONS_CODE.matchAll(/export async function (\w+)/g),
    ).map((m) => m[1]);
    expect(new Set(exported)).toEqual(
      new Set(["previewImportAction", "confirmImportAction"]),
    );
  });

  // -------------------------------------------------------------------------
  // Per-function, not per-file. The earlier version of this pin sliced from a
  // function's declaration to END OF FILE, so previewImportAction's
  // "ownerContext() comes before .insert(" could be satisfied by
  // confirmImportAction's inserts further down, true, but proving nothing
  // about preview. Each body is now bounded, and a decoy write dropped into
  // confirm cannot reach preview's assertions.
  // -------------------------------------------------------------------------

  it("each action body is bounded correctly (the extractor is not lying)", () => {
    const preview = actionBody("previewImportAction");
    const confirm = actionBody("confirmImportAction");
    const gate = actionBody("ownerContext");

    // Balanced braces => the boundary landed on a real declaration edge, not
    // mid-body. A slice that ran into the next function would not balance.
    for (const [name, body] of [
      ["previewImportAction", preview],
      ["confirmImportAction", confirm],
      ["ownerContext", gate],
    ] as const) {
      expect(braceBalance(body), `${name} slice has unbalanced braces`).toBe(0);
    }

    // Disjoint: each body contains its own marker and NONE of its neighbours'.
    expect(preview).toContain("toPreview(plan)");
    expect(preview).not.toContain("import_batches");
    expect(preview).not.toContain("softVoidBatch");
    expect(confirm).toContain("import_batches");
    expect(confirm).not.toContain("toPreview(plan)");
    expect(gate).toContain("isImportOperator()");
    expect(gate).not.toContain("buildImportPlan(parsed");

    // Sizes are sane: an empty or whole-file slice would pass the negatives.
    expect(preview.length).toBeGreaterThan(200);
    expect(preview.length).toBeLessThan(ACTIONS_CODE.length / 2);
    expect(confirm.length).toBeGreaterThan(1000);
  });

  it("previewImportAction opens through the gate and writes NOTHING, ever", () => {
    const preview = actionBody("previewImportAction");

    const gateIdx = preview.indexOf("await ownerContext()");
    expect(gateIdx, "previewImportAction does not call ownerContext()").toBeGreaterThan(-1);

    // "Opens through" it: nothing but the signature precedes the gate.
    const beforeGate = preview.slice(0, gateIdx);
    expect(beforeGate).not.toMatch(/\bawait\b/);
    expect(beforeGate).not.toMatch(/supabase|createClient/);

    // Preview's actual contract is zero writes, not "no writes before the
    // gate". Assert the stronger thing, scoped to THIS function.
    for (const verb of WRITE_VERBS) {
      expect(
        preview.includes(verb),
        `previewImportAction contains a write (${verb})`,
      ).toBe(false);
    }
  });

  it("confirmImportAction's gate precedes its OWN first write", () => {
    const confirm = actionBody("confirmImportAction");

    const gateIdx = confirm.indexOf("await ownerContext()");
    expect(gateIdx, "confirmImportAction does not call ownerContext()").toBeGreaterThan(-1);

    const beforeGate = confirm.slice(0, gateIdx);
    expect(beforeGate).not.toMatch(/\bawait\b/);

    // Non-vacuity: this function must genuinely contain writes, otherwise
    // "the gate precedes every write" is satisfied by there being none.
    const writeIdxs = WRITE_VERBS.map((v) => confirm.indexOf(v)).filter(
      (i) => i > -1,
    );
    expect(
      writeIdxs.length,
      "confirmImportAction has no writes at all, this pin would be vacuous",
    ).toBeGreaterThanOrEqual(2);

    for (const verb of WRITE_VERBS) {
      const idx = confirm.indexOf(verb);
      if (idx === -1) continue;
      expect(idx, `${verb} occurs before the gate`).toBeGreaterThan(gateIdx);
    }
  });

  it("the gate helper itself refuses before it can hand back a context", () => {
    const gate = actionBody("ownerContext");
    const operatorIdx = gate.indexOf("isImportOperator()");
    const ctxIdx = gate.indexOf("studioId:");
    expect(operatorIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(
      operatorIdx,
      "ownerContext builds the context before checking operator standing",
    ).toBeLessThan(ctxIdx);
  });

  it("operator standing is decided on the AUTH user, never on a DB column", () => {
    expect(GATE_CODE).toMatch(/supabase\.auth\.getUser\(\)/);
    expect(GATE_CODE).toMatch(/isAdmin\(user\?\.email\)/);
    // practitioners.email is application data; it must not decide authority.
    expect(GATE_CODE).not.toMatch(/practitioner\.email|practitioners\.email/);
  });

  it("reuses the existing platform-operator allowlist, not a new env var", () => {
    expect(GATE).toMatch(/from "@\/lib\/admin"/);
    expect(GATE_CODE).not.toMatch(/process\.env/);
  });

  it("the gate introduces no service-role client", () => {
    expect(GATE_CODE).not.toMatch(
      /admin-server|createAdminClient|service_role|SERVICE_ROLE/,
    );
  });
});

describe("IMPORT-01: the page tells the same story the server enforces", () => {
  it("the executable island renders only behind the operator check", () => {
    expect(PAGE).toMatch(/from "@\/lib\/import\/operator-assist"/);
    const gateIdx = PAGE_CODE.indexOf("await isImportOperator()");
    expect(gateIdx).toBeGreaterThan(-1);
    // Exactly one QuickImport usage, and it is downstream of the check.
    const usages = PAGE_CODE.match(/<QuickImport\b/g) ?? [];
    expect(usages).toHaveLength(1);
    expect(PAGE_CODE.indexOf("<QuickImport")).toBeGreaterThan(gateIdx);
    expect(PAGE_CODE).toMatch(/operator \? <OperatorImport \/>/);
  });

  it("a non-operator owner is told the truth, with a way to get help", () => {
    expect(PAGE).toMatch(/Import is currently operator-assisted/);
    expect(PAGE).toMatch(/IMPORT_SUPPORT_MAILTO/);
    expect(PAGE).toMatch(/Contact support/);
  });

  it("the page never promises a self-service run it cannot perform", () => {
    // The paste/preview/confirm vocabulary belongs to the operator island in
    // QuickImport.tsx. If any of it reappears as page-level copy, the page is
    // advertising an action the server refuses.
    const notice = PAGE.slice(
      PAGE.indexOf("function OperatorAssistedNotice"),
      PAGE.indexOf("function OperatorImport"),
    );
    expect(notice.length).toBeGreaterThan(400);
    expect(notice).not.toMatch(/Preview import|Confirm import|Paste from/i);
  });

  it("the page copy and the server denial cannot drift apart", () => {
    // One address, one phrase, in both places.
    expect(GATE).toMatch(/operator-assisted/);
    expect(GATE).toMatch(/support@hone\.care/);
    expect(PAGE).toMatch(/operator-assisted/);
    const denial = GATE.match(
      /IMPORT_OPERATOR_ASSISTED_DENIAL =\s*"([^"]+)"/,
    )?.[1];
    expect(denial).toBeTruthy();
    expect(denial).toMatch(/operator-assisted/);
    expect(denial).toMatch(/support@hone\.care/);
  });

  it("the metadata title no longer advertises a quick self-service import", () => {
    expect(PAGE).not.toMatch(/title: "Quick import/);
  });
});

describe("IMPORT-01: the implementation is preserved for the root fix", () => {
  it("the pure pipeline and the operator island are still here", () => {
    expect(read("lib/import/quick-import.ts").length).toBeGreaterThan(1000);
    expect(read("app/(app)/settings/import/QuickImport.tsx")).toMatch(
      /confirmImportAction/,
    );
  });

  it("the three-statement write path is intact, not deleted", () => {
    for (const table of [
      "import_batches",
      "clients",
      "imported_treatment_memories",
    ]) {
      expect(ACTIONS_CODE).toContain(`.from("${table}")`);
    }
  });

  it("the mitigation adds no migration and no schema change", () => {
    expect(GATE_CODE).not.toMatch(/create table|alter table|create policy/i);
    expect(ACTIONS_CODE).not.toMatch(/create table|alter table|create policy/i);
  });
});
