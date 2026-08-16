import { beforeEach, describe, expect, it, vi } from "vitest";

// P1 DATA-LOSS REGRESSION.
//
// The defect this pins: getClientBudgetContext used to collapse EVERY read
// failure into the same value as "this client has no budget row". With an
// existing row plus one transient error, the Consultation page rendered blank
// editable controls, and the next Save upserted ''/NULL over the practitioner's
// real notes and level.
//
// "Could not read" and "there is nothing to read" are different facts. These
// tests prove the module can tell them apart, and — crucially — that the page
// renders NO editable form for the failure case, so a failed read can never be
// turned into a destructive write.
//
// MUTATION CHECK: restoring `if (error || !data) return EMPTY` collapses
// `unavailable` into `empty` and the first three tests below go red.

const CLIENT = "client-1";

type QueryOutcome =
  | { kind: "row"; row: Record<string, unknown> }
  | { kind: "noRow" }
  | { kind: "error"; error: unknown }
  | { kind: "throw"; error: unknown };

let outcome: QueryOutcome = { kind: "noRow" };

const { createClientSpy } = vi.hoisted(() => ({ createClientSpy: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));

function fakeSupabase() {
  return {
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        async maybeSingle() {
          if (outcome.kind === "throw") throw outcome.error;
          if (outcome.kind === "error") {
            return { data: null, error: outcome.error };
          }
          if (outcome.kind === "noRow") return { data: null, error: null };
          return { data: outcome.row, error: null };
        },
      };
      return chain;
    },
  };
}

import { getClientBudgetContext } from "@/lib/budget/queries";

// Verbatim shapes captured from this repository's local Supabase stack.
const MISSING_RELATION = {
  code: "PGRST205",
  message:
    "Could not find the table 'public.client_budget_context' in the schema cache",
};
const PERMISSION_DENIED = {
  code: "42501",
  message: "permission denied for table client_budget_context",
};

beforeEach(() => {
  vi.clearAllMocks();
  createClientSpy.mockResolvedValue(fakeSupabase());
  outcome = { kind: "noRow" };
});

describe("the three read states are distinguishable", () => {
  it("AVAILABLE: an existing row is returned as stored", async () => {
    outcome = {
      kind: "row",
      row: {
        budget_level: "somewhat_limited",
        budget_notes: "Prefers shorter appointments",
        updated_at: "2026-08-16T00:00:00Z",
      },
    };
    const r = await getClientBudgetContext(CLIENT);
    expect(r).toMatchObject({
      status: "available",
      budgetLevel: "somewhat_limited",
      budgetNotes: "Prefers shorter appointments",
    });
  });

  it("EMPTY: a successful query with no row is editable", async () => {
    outcome = { kind: "noRow" };
    expect(await getClientBudgetContext(CLIENT)).toEqual({ status: "empty" });
  });

  it("NOT_INSTALLED: only the proven missing-relation condition", async () => {
    outcome = { kind: "error", error: MISSING_RELATION };
    expect(await getClientBudgetContext(CLIENT)).toEqual({
      status: "not_installed",
    });
  });
});

describe("P1: a failed read must NEVER read as empty", () => {
  // The seeded reality for every case below: this client HAS a budget.
  //   level = somewhat_limited
  //   notes = "Prefers shorter appointments"
  // A caller that cannot tell these apart from "no budget" will overwrite it.

  it("a permission denial is UNAVAILABLE, not empty", async () => {
    outcome = { kind: "error", error: PERMISSION_DENIED };
    const r = await getClientBudgetContext(CLIENT);
    expect(r.status).toBe("unavailable");
    expect(r.status).not.toBe("empty");
  });

  it("an RLS/row-level refusal is UNAVAILABLE, not empty", async () => {
    outcome = {
      kind: "error",
      error: { code: "42501", message: "new row violates row-level security policy" },
    };
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });

  it("a timeout is UNAVAILABLE, not empty", async () => {
    outcome = {
      kind: "error",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });

  it("a thrown network error is UNAVAILABLE, not empty", async () => {
    outcome = { kind: "throw", error: new TypeError("fetch failed") };
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });

  it("a failure to construct the client at all is UNAVAILABLE, not empty", async () => {
    createClientSpy.mockRejectedValueOnce(new Error("no cookies"));
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });

  it("a MISSING-relation error for a DIFFERENT table is UNAVAILABLE", async () => {
    // A broken deployment must not masquerade as "budget not installed".
    outcome = {
      kind: "error",
      error: {
        code: "PGRST205",
        message: "Could not find the table 'public.clients' in the schema cache",
      },
    };
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });

  it("an error with no code at all is UNAVAILABLE", async () => {
    outcome = { kind: "error", error: { message: "something went wrong" } };
    expect((await getClientBudgetContext(CLIENT)).status).toBe("unavailable");
  });
});

describe("the UI cannot turn a failed read into a destructive write", () => {
  it("only `available` and `empty` render the editable card", async () => {
    // The page gates the form on exactly these two states; `unavailable`
    // renders a notice with no form and no Save, and `not_installed` renders
    // nothing. This pins that gate so a future edit cannot widen it back to
    // "render the form unless not_installed".
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(
      join(__dirname, "../../../app/(app)/clients/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /budgetContext\.status === "available"\s*\|\|\s*\n?\s*budgetContext\.status === "empty"/,
    );
    expect(page).toMatch(
      /budgetContext\?\.status === "unavailable"[\s\S]{0,120}ClientBudgetCardUnavailable/,
    );
  });

  it("the unavailable card contains no form, textarea, chips or submit", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const card = readFileSync(
      join(__dirname, "../../../components/client-budget-card.tsx"),
      "utf8",
    );
    const start = card.indexOf("export function ClientBudgetCardUnavailable");
    const end = card.indexOf("export function ClientBudgetCard(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const unavailable = card.slice(start, end);
    for (const forbidden of [
      "<form",
      "<textarea",
      'type="submit"',
      "formAction",
      "CLIENT_BUDGET_LEVELS",
    ]) {
      expect(unavailable).not.toContain(forbidden);
    }
    // And it tells the truth about what happened.
    expect(unavailable).toContain("could not be loaded");
  });
});
