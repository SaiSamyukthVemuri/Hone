import { beforeEach, describe, expect, it, vi } from "vitest";

// THE CLIENT-FORGERY PROOF.
//
// Chloe's requirement, verbatim: "When the client later saves/submits through
// the public route, existing assisted metadata must survive unchanged. Prove
// this behaviorally."
//
// So this runs the REAL public saveIntakeStepAction / submitIntakeAction —
// the same functions the tokenized wizard calls — against an in-memory row
// that already carries practitioner-assisted provenance, and asserts:
//
//   * the client cannot CREATE the provenance key;
//   * the client cannot REPLACE it;
//   * the client cannot ERASE it;
//   * the client cannot re-attribute it to a different practitioner;
//   * it survives a submit byte-identically;
//   * none of this weakens the client's own answers or their acknowledgement.
//
// Nothing here is mocked at the sanitizer level — the real sanitizeResponses
// and the real merge are what is under test.

type Row = Record<string, unknown>;

type DbState = { rows: Row[]; updates: Array<{ patch: Row; matched: number }> };

function makeFakeAdmin(state: DbState) {
  function chain(table: string, patch?: Row) {
    const predicates: Array<(r: Row) => boolean> = [];
    let projection = "*";
    const api = {
      select(cols: string) {
        projection = cols;
        if (patch) return api; // UPDATE ... RETURNING
        return api;
      },
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return api;
      },
      async maybeSingle() {
        const found = state.rows.filter((r) => predicates.every((p) => p(r)));
        if (found.length === 0) return { data: null, error: null };
        const cols = projection.split(",").map((c) => c.trim());
        return {
          data: Object.fromEntries(cols.map((c) => [c, found[0][c]])) as Row,
          error: null,
        };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const matched = state.rows.filter((r) => predicates.every((p) => p(r)));
        if (patch) {
          for (const r of matched) Object.assign(r, patch);
          state.updates.push({ patch, matched: matched.length });
        }
        const cols = projection.split(",").map((c) => c.trim());
        return Promise.resolve({
          data: matched.map((r) =>
            Object.fromEntries(cols.map((c) => [c, r[c]])),
          ),
          error: null,
        }).then(resolve as never);
      },
    };
    return api;
  }

  return {
    from(table: string) {
      return {
        select: (cols: string) => chain(table).select(cols),
        update: (patch: Row) => chain(table, patch),
      };
    },
  };
}

const INTAKE = "intake-1";
const CLIENT = "client-1";
const STUDIO = "studio-1";
const state: DbState = { rows: [], updates: [] };

const { createAdminClient, verifyIntakeToken, limitTokenRoute, headers, recordPractitionerNotification } =
  vi.hoisted(() => ({
    createAdminClient: vi.fn(),
    verifyIntakeToken: vi.fn(),
    limitTokenRoute: vi.fn(),
    headers: vi.fn(),
    recordPractitionerNotification: vi.fn(),
  }));

vi.mock("next/headers", () => ({ headers }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));
vi.mock("@/lib/intake/tokens", () => ({ verifyIntakeToken }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute,
  RATE_LIMIT_MESSAGE: "too many",
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification,
}));

import {
  saveIntakeStepAction,
  submitIntakeAction,
} from "@/app/intake/[token]/actions";
import { PRACTITIONER_ASSISTED_ENTRY } from "@/lib/intake/entry-provenance";
import { ELECTROLYSIS_ACKNOWLEDGEMENT } from "@/lib/intake/acknowledgements";
import { INTAKE_STEPS, TOTAL_STEPS } from "@/lib/intake/questions";

const KEY = PRACTITIONER_ASSISTED_ENTRY.id;

const REAL_PROVENANCE = Object.freeze({
  mode: "practitioner_assisted",
  version: "v1",
  started_at: "2026-08-07T10:00:00.000Z",
  started_by: { practitioner_id: "prac-a", display_name: "Chloe Baca" },
  last_updated_at: "2026-08-07T10:20:00.000Z",
  last_updated_by: { practitioner_id: "prac-a", display_name: "Chloe Baca" },
  handoff_at: "2026-08-07T10:25:00.000Z",
  handoff_by: { practitioner_id: "prac-a", display_name: "Chloe Baca" },
});

function row(over: Partial<Row> = {}): Row {
  return {
    id: INTAKE,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "in_progress",
    current_step: TOTAL_STEPS,
    responses: { legal_name: "Dana Reyes", [KEY]: { ...REAL_PROVENANCE } },
    submitted_at: null,
    deleted_at: null,
    ...over,
  };
}

function stored(): Record<string, unknown> {
  return state.rows[0].responses as Record<string, unknown>;
}

// Every required, unconditional answer, generated from the catalogue so a
// future required question is picked up automatically.
function completeAnswers(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required || q.conditional) continue;
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "checkbox") out[q.key] = true;
      else if (q.type === "date") out[q.key] = "1990-04-02";
      else if (q.key === "email") out[q.key] = "dana@example.com";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else out[q.key] = "answer";
    }
  }
  out[ELECTROLYSIS_ACKNOWLEDGEMENT.id] = {
    id: ELECTROLYSIS_ACKNOWLEDGEMENT.id,
    version: ELECTROLYSIS_ACKNOWLEDGEMENT.version,
    wording: ELECTROLYSIS_ACKNOWLEDGEMENT.wording,
    accepted: true,
  };
  return out;
}

beforeEach(() => {
  state.rows = [row()];
  state.updates = [];
  headers.mockResolvedValue(new Headers());
  limitTokenRoute.mockResolvedValue({ allowed: true });
  verifyIntakeToken.mockReturnValue({ ok: true, intake_id: INTAKE });
  createAdminClient.mockReturnValue(makeFakeAdmin(state));
  recordPractitionerNotification.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
describe("the client's own save cannot disturb assisted provenance", () => {
  it("a normal client save leaves it byte-identical", async () => {
    const res = await saveIntakeStepAction({
      token: "tok",
      step: 2,
      responses: { pronouns: "they/them" },
    });
    expect(res.ok).toBe(true);
    expect(stored()[KEY]).toEqual(REAL_PROVENANCE);
    expect(stored().pronouns).toBe("they/them");
    // ...and the practitioner's recorded answer is still there.
    expect(stored().legal_name).toBe("Dana Reyes");
  });

  it("the client cannot REPLACE it", async () => {
    await saveIntakeStepAction({
      token: "tok",
      step: 2,
      responses: {
        [KEY]: {
          mode: "practitioner_assisted",
          version: "v1",
          started_at: "1999-01-01T00:00:00.000Z",
          started_by: { practitioner_id: "prac-evil", display_name: "Mallory" },
          last_updated_at: "1999-01-01T00:00:00.000Z",
          last_updated_by: { practitioner_id: "prac-evil", display_name: "Mallory" },
        },
      } as Record<string, unknown>,
    });
    expect(stored()[KEY]).toEqual(REAL_PROVENANCE);
  });

  it("the client cannot ERASE it — not with null, undefined or a scalar", async () => {
    for (const attack of [null, undefined, "", 0, false, {}, []]) {
      state.rows = [row()];
      await saveIntakeStepAction({
        token: "tok",
        step: 2,
        responses: { [KEY]: attack } as Record<string, unknown>,
      });
      expect(stored()[KEY]).toEqual(REAL_PROVENANCE);
    }
  });

  it("the client cannot re-attribute it to another practitioner", async () => {
    await saveIntakeStepAction({
      token: "tok",
      step: 2,
      responses: {
        [KEY]: { ...REAL_PROVENANCE, started_by: { practitioner_id: "prac-b", display_name: "Jane" } },
      } as Record<string, unknown>,
    });
    expect(
      (stored()[KEY] as Record<string, unknown>).started_by,
    ).toEqual({ practitioner_id: "prac-a", display_name: "Chloe Baca" });
  });

  it("the client cannot CREATE it on an intake that never had one", async () => {
    state.rows = [row({ responses: { legal_name: "Dana" } })];
    await saveIntakeStepAction({
      token: "tok",
      step: 2,
      responses: { [KEY]: { ...REAL_PROVENANCE } } as Record<string, unknown>,
    });
    expect(stored()).not.toHaveProperty(KEY);
  });

  it("no client save path ever writes the key", async () => {
    await saveIntakeStepAction({
      token: "tok",
      step: 2,
      responses: { [KEY]: "anything" } as Record<string, unknown>,
    });
    for (const u of state.updates) {
      const responses = u.patch.responses as Record<string, unknown> | undefined;
      if (!responses) continue;
      // The key may be PRESENT (carried through from the existing row) but it
      // must be exactly what was already stored — never client bytes.
      if (KEY in responses) expect(responses[KEY]).toEqual(REAL_PROVENANCE);
    }
  });
});

// ---------------------------------------------------------------------------
describe("the client's own SUBMIT preserves it and still works", () => {
  it("submitting carries the provenance through unchanged", async () => {
    state.rows = [
      row({ responses: { ...completeAnswers(), [KEY]: { ...REAL_PROVENANCE } } }),
    ];
    const res = await submitIntakeAction({
      token: "tok",
      responses: completeAnswers(),
    });
    expect(res.ok).toBe(true);
    expect(state.rows[0].status).toBe("submitted");
    expect(stored()[KEY]).toEqual(REAL_PROVENANCE);
  });

  it("the acknowledgement is still the client's own, server-rebuilt", async () => {
    state.rows = [
      row({ responses: { ...completeAnswers(), [KEY]: { ...REAL_PROVENANCE } } }),
    ];
    await submitIntakeAction({ token: "tok", responses: completeAnswers() });
    const ack = stored()[ELECTROLYSIS_ACKNOWLEDGEMENT.id] as Record<string, unknown>;
    expect(ack.accepted).toBe(true);
    // accepted_at is stamped by the server, never taken from the browser.
    expect(typeof ack.accepted_at).toBe("string");
    expect(ack.wording).toBe(ELECTROLYSIS_ACKNOWLEDGEMENT.wording);
  });

  it("a submit still REFUSES without the acknowledgement, provenance or not", async () => {
    const answers = completeAnswers();
    delete answers[ELECTROLYSIS_ACKNOWLEDGEMENT.questionKey];
    state.rows = [row({ responses: { [KEY]: { ...REAL_PROVENANCE } } })];
    const res = await submitIntakeAction({ token: "tok", responses: answers });
    expect(res.ok).toBe(false);
    expect(state.rows[0].status).toBe("in_progress");
    // Assisted provenance does not become a back door around the client's
    // own confirmation.
    expect(stored()[KEY]).toEqual(REAL_PROVENANCE);
  });
});
