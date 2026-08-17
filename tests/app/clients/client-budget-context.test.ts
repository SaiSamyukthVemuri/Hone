import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CLIENT BUDGET CONTEXT — Chloe pilot feedback.
//
// Budget moved OFF treatment plans (where a client with three plans had three
// budget answers) and ONTO the client, surfaced on the existing Consultation &
// Skin/Hair tab.
//
// Section 1 is BEHAVIOURAL: the real updateClientBudgetContextAction runs
// against an in-memory fake implementing the PostgREST semantics it uses, so a
// test that says "persisted" is asserting the row the action actually wrote.
//
// Section 2 pins the SINGLE-AUTHORITY and NO-DATA-LOSS contracts on the
// treatment-plan side by source, following the convention stated in
// tests/app/clients/intake-review-ui-state.ts: the unit lane runs
// `environment: "node"` and the repo ships no jsdom / RTL, so rendered
// behaviour is proven in the browser lane and structure is pinned here.

type Row = Record<string, unknown>;

type DbState = {
  clients: Row[];
  budget: Row[];
  failUpsertWith?: { message: string } | null;
};

const STUDIO = "studio-1";
const OTHER_STUDIO = "studio-2";
const CLIENT = "client-1";
const FOREIGN_CLIENT = "client-foreign";
const PRAC = "prac-a";

const state: DbState = { clients: [], budget: [], failUpsertWith: null };

// Supports exactly the chains the action uses:
//   clients:               .select(cols).eq().eq().maybeSingle()
//   client_budget_context: .upsert(row, { onConflict: "client_id" })
function makeFakeSupabase(db: DbState) {
  return {
    from(table: string) {
      return {
        select(cols: string) {
          const predicates: Array<(r: Row) => boolean> = [];
          const chain = {
            eq(col: string, val: unknown) {
              predicates.push((r) => r[col] === val);
              return chain;
            },
            async maybeSingle() {
              if (table !== "clients") {
                throw new Error(`fake supabase: unexpected select on ${table}`);
              }
              const found = db.clients.filter((r) =>
                predicates.every((p) => p(r)),
              );
              if (found.length === 0) return { data: null, error: null };
              const projection = cols.split(",").map((c) => c.trim());
              return {
                data: Object.fromEntries(
                  projection.map((c) => [c, found[0][c]]),
                ) as Row,
                error: null,
              };
            },
          };
          return chain;
        },
        async upsert(row: Row, opts: { onConflict?: string }) {
          if (table !== "client_budget_context") {
            throw new Error(`fake supabase: unexpected upsert on ${table}`);
          }
          if (db.failUpsertWith) {
            const err = db.failUpsertWith;
            db.failUpsertWith = null;
            return { error: err };
          }
          // The real uniqueness guarantee is the client_id PRIMARY KEY; the
          // fake honours the same conflict target so "save twice" cannot
          // silently produce two current budgets here either.
          expect(opts.onConflict).toBe("client_id");
          // The DB trigger derives studio_id from the parent client and
          // OVERWRITES whatever the caller sent. Model that, so a test can
          // never pass because the action happened to send the right studio.
          const parent = db.clients.find((c) => c.id === row.client_id);
          const derived = parent ? parent.studio_id : null;
          const next = { ...row, studio_id: derived };
          const idx = db.budget.findIndex(
            (r) => r.client_id === row.client_id,
          );
          if (idx >= 0) db.budget[idx] = { ...db.budget[idx], ...next };
          else db.budget.push(next);
          return { error: null };
        },
      };
    },
  };
}

const {
  createClientSpy,
  getCurrentPractitionerWithStudio,
  revalidatePath,
} = vi.hoisted(() => ({
  createClientSpy: vi.fn(),
  getCurrentPractitionerWithStudio: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio }));

import { updateClientBudgetContextAction } from "@/app/(app)/clients/[id]/budget-context-actions";
import {
  CLIENT_BUDGET_LEVELS,
  CLIENT_BUDGET_LEVEL_LABELS,
} from "@/lib/budget/levels";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function currentBudget(clientId = CLIENT): Row | undefined {
  return state.budget.find((r) => r.client_id === clientId);
}

beforeEach(() => {
  state.clients = [
    { id: CLIENT, studio_id: STUDIO },
    // A client that exists but belongs to ANOTHER studio. The session below
    // is always scoped to STUDIO, so this is the forged-pointer case.
    { id: FOREIGN_CLIENT, studio_id: OTHER_STUDIO },
  ];
  state.budget = [];
  state.failUpsertWith = null;
  vi.clearAllMocks();
  createClientSpy.mockResolvedValue(makeFakeSupabase(state));
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id: PRAC },
    studio: { id: STUDIO },
  });
});

// ---------------------------------------------------------------------------
// 1. BEHAVIOURAL — the real action against a fake PostgREST
// ---------------------------------------------------------------------------

describe("client budget context: persistence", () => {
  it("A. a client with no context has no row at all (empty state, no chip)", () => {
    expect(currentBudget()).toBeUndefined();
  });

  it("B. each of the three levels round-trips exactly", async () => {
    for (const level of CLIENT_BUDGET_LEVELS) {
      state.budget = [];
      const r = await updateClientBudgetContextAction(
        form({ client_id: CLIENT, budget_level: level, budget_notes: "" }),
      );
      expect(r).toEqual({ ok: true });
      expect(currentBudget()?.budget_level).toBe(level);
    }
  });

  it("C. notes save with NO level (free text alone is valid)", async () => {
    const r = await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "",
        budget_notes: "Saving for underarms; wants to spread visits out.",
      }),
    );
    expect(r).toEqual({ ok: true });
    expect(currentBudget()?.budget_level).toBeNull();
    expect(currentBudget()?.budget_notes).toBe(
      "Saving for underarms; wants to spread visits out.",
    );
  });

  it("D. a level and notes coexist — neither overwrites the other", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "somewhat_limited",
        budget_notes: "About $60 a visit.",
      }),
    );
    expect(currentBudget()).toMatchObject({
      budget_level: "somewhat_limited",
      budget_notes: "About $60 a visit.",
    });
  });

  it("E. switching level leaves exactly ONE current value, not two rows", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "severely_limited",
        budget_notes: "n",
      }),
    );
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "no_stated_limit",
        budget_notes: "n",
      }),
    );
    expect(state.budget).toHaveLength(1);
    expect(currentBudget()?.budget_level).toBe("no_stated_limit");
  });

  it("F. clearing the level nulls it and PRESERVES the notes", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "severely_limited",
        budget_notes: "Tight until the new year.",
      }),
    );
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "",
        budget_notes: "Tight until the new year.",
      }),
    );
    expect(currentBudget()?.budget_level).toBeNull();
    expect(currentBudget()?.budget_notes).toBe("Tight until the new year.");
  });

  it("G. clearing the notes PRESERVES the level", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "somewhat_limited",
        budget_notes: "Some detail.",
      }),
    );
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "somewhat_limited",
        budget_notes: "",
      }),
    );
    expect(currentBudget()?.budget_level).toBe("somewhat_limited");
    expect(currentBudget()?.budget_notes).toBe("");
  });

  it("stamps the SERVER-derived practitioner, never a browser-supplied one", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "no_stated_limit",
        budget_notes: "",
        // Both of these are attacker-controlled and must be ignored.
        updated_by_practitioner_id: "prac-attacker",
        studio_id: OTHER_STUDIO,
      }),
    );
    expect(currentBudget()?.updated_by_practitioner_id).toBe(PRAC);
    expect(currentBudget()?.studio_id).toBe(STUDIO);
  });

  it("does not trim notes (leading whitespace is deliberate structure)", async () => {
    await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "",
        budget_notes: "  indented note",
      }),
    );
    expect(currentBudget()?.budget_notes).toBe("  indented note");
  });
});

describe("client budget context: authorization", () => {
  it("H. a forged CROSS-STUDIO client id is refused and writes NOTHING", async () => {
    const r = await updateClientBudgetContextAction(
      form({
        client_id: FOREIGN_CLIENT,
        budget_level: "severely_limited",
        budget_notes: "should never be stored",
      }),
    );
    expect(r).toEqual({ ok: false, error: "Client not found." });
    // The decisive assertion: no row for the foreign client, and no row at all.
    expect(currentBudget(FOREIGN_CLIENT)).toBeUndefined();
    expect(state.budget).toHaveLength(0);
  });

  it("a client id that does not exist at all is refused", async () => {
    const r = await updateClientBudgetContextAction(
      form({ client_id: "nope", budget_level: "", budget_notes: "x" }),
    );
    expect(r.ok).toBe(false);
    expect(state.budget).toHaveLength(0);
  });

  it("a missing client id is refused before any DB call", async () => {
    const r = await updateClientBudgetContextAction(
      form({ budget_level: "", budget_notes: "x" }),
    );
    expect(r).toEqual({ ok: false, error: "Missing client id." });
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("the studio is read from the SESSION, never from the form", async () => {
    const src = codeOnly(
      readFileSync(
        join(
          __dirname,
          "../../../app/(app)/clients/[id]/budget-context-actions.ts",
        ),
        "utf8",
      ),
    );
    expect(src).toContain("getCurrentPractitionerWithStudio()");
    // No admin/service-role escape hatch on this path.
    expect(src).not.toContain("createAdminClient");
    expect(src).not.toMatch(/formData\.get\(\s*["']studio_id["']\s*\)/);
    expect(src).not.toMatch(
      /formData\.get\(\s*["'](updated_by_)?practitioner_id["']\s*\)/,
    );
  });
});

describe("client budget context: input validation", () => {
  it("a tampered level is REFUSED, not silently downgraded to null", async () => {
    const r = await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "unlimited_platinum",
        budget_notes: "",
      }),
    );
    expect(r).toEqual({ ok: false, error: "Unrecognised budget level." });
    // A silent downgrade would have written a row and reported success.
    expect(state.budget).toHaveLength(0);
  });

  it("an over-length note is refused before the write", async () => {
    const r = await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "",
        budget_notes: "x".repeat(20001),
      }),
    );
    expect(r.ok).toBe(false);
    expect(state.budget).toHaveLength(0);
  });

  it("a note at exactly the ceiling is accepted", async () => {
    const r = await updateClientBudgetContextAction(
      form({
        client_id: CLIENT,
        budget_level: "",
        budget_notes: "x".repeat(20000),
      }),
    );
    expect(r).toEqual({ ok: true });
  });

  it("a failed write reports an error and does not claim success", async () => {
    state.failUpsertWith = { message: "boom" };
    const r = await updateClientBudgetContextAction(
      form({ client_id: CLIENT, budget_level: "", budget_notes: "x" }),
    );
    expect(r.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. SINGLE AUTHORITY + NO DATA LOSS on the treatment-plan side
// ---------------------------------------------------------------------------

const ROOT = join(__dirname, "../../..");
const PLAN_ACTIONS = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/treatment-plans-actions.ts"),
  "utf8",
);
const PLAN_CARD = readFileSync(
  join(ROOT, "components/treatment-plans-card.tsx"),
  "utf8",
);
const BUDGET_CARD = readFileSync(
  join(ROOT, "components/client-budget-card.tsx"),
  "utf8",
);
const CLIENT_PAGE = readFileSync(
  join(ROOT, "app/(app)/clients/[id]/page.tsx"),
  "utf8",
);

// Strip comments so these pins assert what the code DOES, not what a comment
// happens to mention. JSX comment blocks ({/* … */}) and /* … */ blocks are
// removed whole — a line-only filter leaves their continuation lines behind,
// which is exactly how a "the old control is gone" assertion can be fooled by
// the comment explaining that it is gone.
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const PLAN_ACTIONS_CODE = codeOnly(PLAN_ACTIONS);
const PLAN_CARD_CODE = codeOnly(PLAN_CARD);

describe("treatment plan: no longer a budget authority", () => {
  it("I. the plan editor sends NO budget_notes field", () => {
    expect(PLAN_CARD_CODE).not.toMatch(/fd\.set\(\s*["']budget_notes["']/);
    expect(PLAN_CARD_CODE).not.toContain("setBudget(");
  });

  it("I. the plan editor has no editable budget control", () => {
    expect(PLAN_CARD_CODE).not.toContain("Client budget notes");
    expect(PLAN_CARD_CODE).not.toMatch(/onChange=\{\(e\) => setBudget/);
  });

  it("the plan writer never writes budget_notes — the column is left ALONE", () => {
    // This is the data-loss tripwire. If budget_notes reappears in the update
    // object it resolves from an absent form field to null, and the next
    // unrelated plan edit silently erases a historical note.
    expect(PLAN_ACTIONS_CODE).not.toMatch(/budget_notes\s*:/);
    expect(PLAN_ACTIONS_CODE).not.toMatch(
      /formData\.get\(\s*["']budget_notes["']\s*\)/,
    );
  });

  it("J. a legacy non-empty plan budget note still renders, clearly labelled", () => {
    expect(PLAN_CARD).toContain("Legacy plan budget note");
    // Guarded on non-emptiness: no empty legacy section.
    expect(PLAN_CARD_CODE).toMatch(/\{plan\.budget_notes && \(/);
  });

  it("K. the legacy column is still typed and still exported", () => {
    const types = readFileSync(join(ROOT, "lib/types/database.ts"), "utf8");
    expect(types).toContain("budget_notes: string | null;");
    const exportSrc = readFileSync(
      join(ROOT, "app/(app)/settings/data/actions.ts"),
      "utf8",
    );
    // Still selected into, and still a column of, treatment_plans.csv.
    expect(exportSrc).toContain("treatment_goal_minutes_override, budget_notes");
    expect(exportSrc).toMatch(/"budget_notes",/);
  });

  it("there is exactly ONE writer of client budget context, repo-wide", () => {
    // A second writer anywhere is a competing storage authority, which is the
    // exact class of bug this whole change exists to remove. Grep the tree
    // rather than a hand-listed set of files, so a NEW file cannot introduce a
    // second authority without failing here.
    // Matches BOTH the string literal and the shared constant, so moving a
    // call site onto CLIENT_BUDGET_CONTEXT_RELATION cannot hide it from this
    // census.
    const touchers = require("node:child_process")
      .execSync(
        `grep -rlE 'from\\("client_budget_context"\\)|from\\(CLIENT_BUDGET_CONTEXT_RELATION\\)' app lib components 2>/dev/null || true`,
        { cwd: ROOT, encoding: "utf8" },
      )
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(touchers).toEqual([
      // the export (read-only)
      "app/(app)/settings/data/actions.ts",
      // the single writer
      "app/(app)/clients/[id]/budget-context-actions.ts",
      // the single reader for the UI
      "lib/budget/queries.ts",
    ].sort());

    // Of those, only the action mutates.
    const mutators = touchers.filter((f: string) => {
      const src = readFileSync(join(ROOT, f), "utf8");
      const idx = src.search(
        /from\("client_budget_context"\)|from\(CLIENT_BUDGET_CONTEXT_RELATION\)/,
      );
      return /\.(upsert|insert|update|delete)\(/.test(src.slice(idx, idx + 400));
    });
    expect(mutators).toEqual([
      "app/(app)/clients/[id]/budget-context-actions.ts",
    ]);
  });
});

describe("consultation surface", () => {
  it("L. the tab query value is still `consultation` (deep links unbroken)", () => {
    expect(CLIENT_PAGE).toContain('activeTab === "consultation"');
    expect(CLIENT_PAGE).toContain("?tab=consultation");
  });

  it("the Budget card renders on that existing tab, not a new one", () => {
    const idx = CLIENT_PAGE.indexOf("<ClientBudgetCard");
    expect(idx).toBeGreaterThan(-1);
    const preceding = CLIENT_PAGE.slice(0, idx);
    expect(preceding.lastIndexOf('activeTab === "consultation"')).toBeGreaterThan(
      preceding.lastIndexOf('activeTab === "personal"'),
    );
  });

  it("budget is NOT a client_clinical_notes kind", () => {
    const types = readFileSync(join(ROOT, "lib/types/database.ts"), "utf8");
    expect(types).toContain(
      'export type ClinicalNoteKind = "consultation" | "skin_hair_analysis";',
    );
  });

  it("the three chip labels render exactly as approved", () => {
    expect(Object.values(CLIENT_BUDGET_LEVEL_LABELS)).toEqual([
      "No stated limit",
      "Somewhat limited",
      "Severely limited",
    ]);
    for (const label of Object.values(CLIENT_BUDGET_LEVEL_LABELS)) {
      expect(BUDGET_CARD).toContain("CLIENT_BUDGET_LEVEL_LABELS");
      expect(label).not.toMatch(/unlimited/i);
    }
  });

  it("M. chips meet the 44px touch-target floor", () => {
    // min-h-11 == 2.75rem == 44px.
    const chipBlock = BUDGET_CARD.slice(
      BUDGET_CARD.indexOf("CLIENT_BUDGET_LEVELS.map"),
    );
    expect(chipBlock).toContain("min-h-11");
    // Chips wrap rather than overflow a 390px viewport.
    expect(BUDGET_CARD).toContain("flex flex-wrap gap-2");
  });

  it("M. chips are real buttons with an accessible pressed state", () => {
    expect(BUDGET_CARD).toContain('type="button"');
    expect(BUDGET_CARD).toContain("aria-pressed={selected}");
  });

  it("selecting a chip does NOT inject boilerplate into the textarea", () => {
    // The chip only sets state; the textarea stays uncontrolled on its own
    // defaultValue. Any setNotes(...) driven by a chip would be the bug.
    expect(BUDGET_CARD).toContain("onClick={() => setLevel(selected ? null : value)}");
    expect(BUDGET_CARD).not.toMatch(/setNotes\(/);
    expect(BUDGET_CARD).not.toMatch(/Budget classification/i);
  });
});

describe("N. budget context never reaches a client-facing surface", () => {
  it("no public/portal/email/sms/cron/stripe surface imports it", () => {
    // Mirrors the client_personal_notes import audit. The grep is over the
    // whole tree so a new importer anywhere fails this rather than only the
    // directories that existed when it was written.
    const out = require("node:child_process")
      .execSync(
        "grep -rln 'client-budget-card\\|budget-context-actions\\|client_budget_context\\|lib/budget/' " +
          "app/book app/portal app/intake app/cancel app/reschedule app/api/cron app/api/stripe " +
          "lib/email lib/sms 2>/dev/null || true",
        { cwd: ROOT, encoding: "utf8" },
      )
      .trim();
    expect(out).toBe("");
  });

  it("the card documents itself as practitioner-only", () => {
    expect(BUDGET_CARD).toContain("never shown to the client");
  });
});
