import { beforeEach, describe, expect, it, vi } from "vitest";

// Practitioner-assisted intake entry — behavioural proof.
//
// These are NOT source greps. The real server actions run against an in-memory
// fake implementing PostgREST filter semantics (.eq / .is / .maybeSingle /
// update+.select) over real rows. A test that says "denied" is asserting the
// stored row genuinely did not change and that zero rows came back.
//
// The boundary under test: a practitioner may record the questionnaire; the
// client's own acknowledgements and the submission are not reachable from
// here at all.

type Row = Record<string, unknown>;

type DbState = {
  clients: Row[];
  intakes: Row[];
  failIntakeUpdateWith?: { message: string; code?: string } | null;
  updates: Array<{ patch: Row; matched: number }>;
};

function matches(r: Row, predicates: Array<(r: Row) => boolean>): boolean {
  return predicates.every((p) => p(r));
}

function makeFakeSupabase(state: DbState) {
  function rowsFor(table: string): Row[] {
    if (table === "clients") return state.clients;
    if (table === "client_intake_forms") return state.intakes;
    throw new Error(`fake supabase: unexpected table ${table}`);
  }

  function selectChain(table: string, cols: string) {
    const predicates: Array<(r: Row) => boolean> = [];
    const chain = {
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      is(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      async maybeSingle() {
        const found = rowsFor(table).filter((r) => matches(r, predicates));
        if (found.length > 1) {
          return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
        }
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
  }

  function updateChain(table: string, patch: Row) {
    const predicates: Array<(r: Row) => boolean> = [];
    const chain = {
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      is(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      async select(cols: string) {
        if (table === "client_intake_forms" && state.failIntakeUpdateWith) {
          const err = state.failIntakeUpdateWith;
          state.failIntakeUpdateWith = null;
          return { data: null, error: err };
        }
        const matched = rowsFor(table).filter((r) => matches(r, predicates));
        for (const r of matched) {
          Object.assign(r, patch);
          // The 0015 trigger bumps updated_at on EVERY update. Modelling it is
          // what makes the optimistic-concurrency assertions real.
          r.updated_at = new Date(
            Date.parse(String(r.updated_at)) + 1000,
          ).toISOString();
        }
        state.updates.push({ patch, matched: matched.length });
        const projection = cols.split(",").map((c) => c.trim());
        return {
          data: matched.map((r) =>
            Object.fromEntries(projection.map((c) => [c, r[c]])),
          ),
          error: null,
        };
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      return {
        select: (cols: string) => selectChain(table, cols),
        update: (patch: Row) => updateChain(table, patch),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const STUDIO = "studio-1";
const CLIENT = "client-1";
const OTHER_CLIENT = "client-2";
const INTAKE = "intake-1";
const OTHER_INTAKE = "intake-2";
const PRAC_A = "prac-a";
const PRAC_B = "prac-b";
const T0 = "2026-08-07T10:00:00.000Z";

const state: DbState = {
  clients: [],
  intakes: [],
  failIntakeUpdateWith: null,
  updates: [],
};

const {
  createClientSpy,
  createAdminClientSpy,
  getCurrentPractitionerWithStudio,
  revalidatePath,
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
} = vi.hoisted(() => ({
  createClientSpy: vi.fn(),
  createAdminClientSpy: vi.fn(),
  getCurrentPractitionerWithStudio: vi.fn(),
  revalidatePath: vi.fn(),
  generateIntakeLinkUrl: vi.fn(),
  stampIntakeLinkIssued: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: createAdminClientSpy,
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio: vi.fn(),
}));
vi.mock("@/lib/intake/queries", () => ({
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
  createIntakeRequestForClient: vi.fn(),
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://app.example.test",
}));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPractitionerClientEmail: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendIntakeUpdateRequestToClient: vi.fn(),
}));

import {
  handOffAssistedIntakeAction,
  saveAssistedIntakeStepAction,
} from "@/app/(app)/clients/[id]/intake/actions";
import { PRACTITIONER_ASSISTED_ENTRY } from "@/lib/intake/entry-provenance";
import { ELECTROLYSIS_ACKNOWLEDGEMENT } from "@/lib/intake/acknowledgements";
import { TOTAL_STEPS } from "@/lib/intake/questions";

const KEY = PRACTITIONER_ASSISTED_ENTRY.id;

function intakeRow(over: Partial<Row> = {}): Row {
  return {
    id: INTAKE,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "in_progress",
    current_step: 1,
    responses: {},
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
    deleted_at: null,
    updated_at: T0,
    ...over,
  };
}

function currentIntake(id = INTAKE): Row {
  return state.intakes.find((r) => r.id === id)!;
}

function storedResponses(id = INTAKE): Record<string, unknown> {
  return currentIntake(id).responses as Record<string, unknown>;
}

function provenance(id = INTAKE): Record<string, unknown> | undefined {
  return storedResponses(id)[KEY] as Record<string, unknown> | undefined;
}

async function save(over: Partial<Parameters<typeof saveAssistedIntakeStepAction>[0]> = {}) {
  // The default concurrency token is read lazily: some cases deliberately
  // leave no row at all, and computing it eagerly would throw in the harness
  // instead of exercising the action.
  const fallbackToken = state.intakes.find((r) => r.id === INTAKE)?.updated_at;
  return saveAssistedIntakeStepAction({
    intakeId: INTAKE,
    clientId: CLIENT,
    step: 1,
    responses: { legal_name: "Dana Reyes" },
    expectedUpdatedAt: String(fallbackToken ?? T0),
    ...over,
  });
}

function handoffFd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("intake_id", INTAKE);
  f.set("client_id", CLIENT);
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

function asPractitioner(id: string, name: string, active = true) {
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: { id, active, display_name: name, email: `${id}@x.test` },
    studio: { id: STUDIO },
  });
}

beforeEach(() => {
  state.clients = [{ id: CLIENT, studio_id: STUDIO, name: "Dana", email: null }];
  state.intakes = [intakeRow()];
  state.failIntakeUpdateWith = null;
  state.updates = [];
  revalidatePath.mockClear();
  createAdminClientSpy.mockReset();
  createAdminClientSpy.mockReturnValue({});
  generateIntakeLinkUrl.mockReset();
  generateIntakeLinkUrl.mockReturnValue("https://app.example.test/intake/tok-abc");
  stampIntakeLinkIssued.mockReset();
  stampIntakeLinkIssued.mockResolvedValue(undefined);
  createClientSpy.mockReset();
  createClientSpy.mockImplementation(async () => makeFakeSupabase(state));
  getCurrentPractitionerWithStudio.mockReset();
  asPractitioner(PRAC_A, "Chloe Baca");
});

// ---------------------------------------------------------------------------
describe("1. recording the questionnaire", () => {
  it("an active practitioner records answers and provenance in one write", async () => {
    const res = await save({ responses: { legal_name: "Dana Reyes" } });
    expect(res.ok).toBe(true);
    expect(storedResponses().legal_name).toBe("Dana Reyes");
    expect(provenance()).toMatchObject({
      mode: "practitioner_assisted",
      version: "v1",
      started_by: { practitioner_id: PRAC_A, display_name: "Chloe Baca" },
      last_updated_by: { practitioner_id: PRAC_A, display_name: "Chloe Baca" },
    });
    // Exactly one statement touched the row.
    expect(state.updates).toHaveLength(1);
  });

  it("the actor is taken from the SESSION, never from the request", async () => {
    // A crafted payload naming another practitioner, a studio and a
    // ready-made provenance object.
    const res = await save({
      responses: {
        legal_name: "Dana Reyes",
        practitioner_id: "prac-evil",
        studio_id: "studio-evil",
        entered_by: "prac-evil",
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
    expect(res.ok).toBe(true);
    const stored = storedResponses();
    // None of the injected identity keys were persisted.
    expect(stored).not.toHaveProperty("practitioner_id");
    expect(stored).not.toHaveProperty("studio_id");
    expect(stored).not.toHaveProperty("entered_by");
    // And the provenance names the SESSION practitioner, not the payload's.
    expect(provenance()).toMatchObject({
      started_by: { practitioner_id: PRAC_A, display_name: "Chloe Baca" },
      last_updated_by: { practitioner_id: PRAC_A, display_name: "Chloe Baca" },
    });
    expect(JSON.stringify(provenance())).not.toContain("prac-evil");
    expect(JSON.stringify(provenance())).not.toContain("Mallory");
    expect(JSON.stringify(provenance())).not.toContain("1999");
  });

  it("timestamps are server-produced, not echoed from the request", async () => {
    const before = Date.now();
    await save();
    const p = provenance()!;
    const started = Date.parse(String(p.started_at));
    expect(Number.isNaN(started)).toBe(false);
    expect(started).toBeGreaterThanOrEqual(before - 5_000);
    expect(started).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("never uses the service role", async () => {
    await save();
    expect(createAdminClientSpy).not.toHaveBeenCalled();
  });

  it("unknown (non-question) keys are dropped", async () => {
    await save({ responses: { legal_name: "Dana", not_a_question: "x" } });
    expect(storedResponses()).not.toHaveProperty("not_a_question");
    expect(storedResponses().legal_name).toBe("Dana");
  });

  it("answers already given through the client's own link are preserved", async () => {
    currentIntake().responses = { pronouns: "they/them" };
    await save({ responses: { legal_name: "Dana" } });
    expect(storedResponses().pronouns).toBe("they/them");
    expect(storedResponses().legal_name).toBe("Dana");
  });
});

// ---------------------------------------------------------------------------
describe("2. the client-owned boundary", () => {
  const CLIENT_OWNED = [
    "ack_not_a_substitute",
    "ack_accurate",
    "ack_understands_risk",
    "ack_will_update",
    ELECTROLYSIS_ACKNOWLEDGEMENT.questionKey,
  ];

  for (const key of CLIENT_OWNED) {
    it(`refuses an assisted save carrying ${key}`, async () => {
      const res = await save({
        responses: { legal_name: "Dana", [key]: true },
      });
      expect(res.ok).toBe(false);
      // Nothing was written at all — not even the legitimate answer.
      expect(state.updates).toHaveLength(0);
      expect(storedResponses()).toEqual({});
    });
  }

  it("refuses an assisted save that would author the acknowledgement RECORD", async () => {
    const res = await save({
      responses: {
        legal_name: "Dana",
        [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: {
          id: ELECTROLYSIS_ACKNOWLEDGEMENT.id,
          version: "v1",
          wording: ELECTROLYSIS_ACKNOWLEDGEMENT.wording,
          accepted: true,
        },
      } as Record<string, unknown>,
    });
    // The record key is not a question key, so the whitelist would drop it
    // regardless — but it is also named client-owned, so an attempt to author
    // it is REFUSED rather than silently stripped. Nothing is written.
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
    expect(storedResponses()).not.toHaveProperty(
      ELECTROLYSIS_ACKNOWLEDGEMENT.id,
    );
  });

  it("does NOT refuse a payload that merely echoes the client's stored answers", async () => {
    // THE REGRESSION adversarial review found. The editor seeds its state from
    // the stored responses and posts the whole map, so an intake where the
    // client had already touched a step-5 checkbox through their own link made
    // EVERY assisted save fail — with copy blaming the practitioner and naming
    // a button that could never mount. Refusing on key presence rather than on
    // change was the bug.
    const clientRecord = {
      id: ELECTROLYSIS_ACKNOWLEDGEMENT.id,
      version: "v1",
      wording: ELECTROLYSIS_ACKNOWLEDGEMENT.wording,
      accepted: false,
    };
    currentIntake().responses = {
      ack_accurate: true,
      ack_will_update: false,
      [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: clientRecord,
    };
    const res = await save({
      responses: {
        // exactly what the editor would post back: stored map + a new answer
        ack_accurate: true,
        ack_will_update: false,
        [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: { ...clientRecord },
        legal_name: "Dana Reyes",
      } as Record<string, unknown>,
      expectedUpdatedAt: String(currentIntake().updated_at),
    });
    expect(res.ok).toBe(true);
    expect(storedResponses().legal_name).toBe("Dana Reyes");
    // The client's own answers are untouched, not re-written by the practitioner.
    expect(storedResponses().ack_accurate).toBe(true);
    expect(storedResponses().ack_will_update).toBe(false);
    expect(storedResponses()[ELECTROLYSIS_ACKNOWLEDGEMENT.id]).toEqual(clientRecord);
  });

  it("still refuses when the payload would FLIP a client answer", async () => {
    currentIntake().responses = { ack_accurate: false };
    const res = await save({
      responses: { legal_name: "Dana", ack_accurate: true } as Record<string, unknown>,
      expectedUpdatedAt: String(currentIntake().updated_at),
    });
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
    expect(storedResponses().ack_accurate).toBe(false);
  });

  it("cannot address the acknowledgements step at all", async () => {
    const res = await save({ step: TOTAL_STEPS });
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("never writes status or submitted_at", async () => {
    await save();
    for (const u of state.updates) {
      expect(u.patch).not.toHaveProperty("status");
      expect(u.patch).not.toHaveProperty("submitted_at");
      expect(u.patch).not.toHaveProperty("reviewed_by");
      expect(u.patch).not.toHaveProperty("reviewed_at");
    }
    expect(currentIntake().status).toBe("in_progress");
    expect(currentIntake().submitted_at).toBeNull();
  });

  it("an existing client acknowledgement survives an assisted save untouched", async () => {
    const record = {
      id: ELECTROLYSIS_ACKNOWLEDGEMENT.id,
      version: "v1",
      wording: ELECTROLYSIS_ACKNOWLEDGEMENT.wording,
      accepted: true,
      accepted_at: "2026-08-01T09:00:00.000Z",
    };
    currentIntake().responses = {
      [ELECTROLYSIS_ACKNOWLEDGEMENT.id]: record,
      ack_accurate: true,
    };
    const res = await save({ responses: { legal_name: "Dana" } });
    expect(res.ok).toBe(true);
    expect(storedResponses()[ELECTROLYSIS_ACKNOWLEDGEMENT.id]).toEqual(record);
    expect(storedResponses().ack_accurate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("3. authorization", () => {
  it("an inactive practitioner is denied", async () => {
    asPractitioner(PRAC_A, "Chloe Baca", false);
    const res = await save();
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("a practitioner from another studio is denied", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: PRAC_B, active: true, display_name: "Other", email: "o@x" },
      studio: { id: "studio-other" },
    });
    const res = await save();
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("a wrong client id is denied", async () => {
    state.clients.push({
      id: OTHER_CLIENT,
      studio_id: STUDIO,
      name: "Someone else",
      email: null,
    });
    const res = await save({ clientId: OTHER_CLIENT });
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("an intake belonging to another client is denied", async () => {
    state.clients.push({
      id: OTHER_CLIENT, studio_id: STUDIO, name: "Other", email: null,
    });
    state.intakes.push(intakeRow({ id: OTHER_INTAKE, client_id: OTHER_CLIENT }));
    const res = await save({ intakeId: OTHER_INTAKE });
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("a soft-deleted intake is denied", async () => {
    currentIntake().deleted_at = "2026-08-01T00:00:00.000Z";
    const res = await save();
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  for (const status of ["submitted", "reviewed"]) {
    it(`a ${status} intake cannot be rewritten`, async () => {
      currentIntake().status = status;
      currentIntake().responses = { legal_name: "Original" };
      const res = await save({ responses: { legal_name: "Rewritten" } });
      expect(res.ok).toBe(false);
      expect(state.updates).toHaveLength(0);
      expect(storedResponses().legal_name).toBe("Original");
    });
  }

  it("every refusal reads the same — no existence oracle", async () => {
    // Six distinguishable underlying causes must produce ONE message, so a
    // caller cannot use the response to learn whether an intake exists, who
    // it belongs to, or what state it is in.
    // Sequential, and the row is rebuilt before each case: these mutate one
    // shared in-memory database, so running them concurrently would have each
    // case observing another's mutation.
    async function refusalFor(mutate: (row: Row) => void): Promise<string> {
      state.intakes = [intakeRow()];
      // Capture the token BEFORE mutating, so the concurrency predicate is
      // satisfied and the refusal we observe is the one under test.
      const token = String(currentIntake().updated_at);
      mutate(currentIntake());
      const res = await save({ expectedUpdatedAt: token });
      expect(res.ok).toBe(false);
      return res.ok ? "" : res.error;
    }

    state.clients.push({
      id: OTHER_CLIENT, studio_id: STUDIO, name: "Other", email: null,
    });

    const causes: string[] = [];
    // soft-deleted
    causes.push(await refusalFor((r) => { r.deleted_at = "2026-08-01T00:00:00.000Z"; }));
    // already submitted
    causes.push(await refusalFor((r) => { r.status = "submitted"; }));
    // already reviewed
    causes.push(await refusalFor((r) => { r.status = "reviewed"; }));
    // belongs to a different client in the same studio
    causes.push(await refusalFor((r) => { r.client_id = OTHER_CLIENT; }));
    // belongs to a different studio
    causes.push(await refusalFor((r) => { r.studio_id = "studio-other"; }));
    // absent entirely
    state.intakes = [];
    const absent = await save({ expectedUpdatedAt: T0 });
    expect(absent.ok).toBe(false);
    causes.push(absent.ok ? "" : absent.error);

    expect(new Set(causes).size).toBe(1);
    // ...and that one message names nothing about the row.
    expect(causes[0]).not.toMatch(/deleted|submitted|reviewed|studio|client_id/i);
  });

  it("returns no raw provider text when the database errors", async () => {
    state.failIntakeUpdateWith = {
      message: 'permission denied for relation client_intake_forms',
      code: "42501",
    };
    const res = await save();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/permission denied|relation|42501/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe("4. more than one practitioner", () => {
  it("A starts, B continues: started_by stays A, last_updated_by becomes B", async () => {
    await save({ responses: { legal_name: "Dana" } });
    const first = provenance()!;
    expect(first.started_by).toMatchObject({ practitioner_id: PRAC_A });

    asPractitioner(PRAC_B, "Jane Doe");
    const res = await save({
      responses: { pronouns: "they/them" },
      expectedUpdatedAt: String(currentIntake().updated_at),
    });
    expect(res.ok).toBe(true);

    const second = provenance()!;
    expect(second.started_by).toMatchObject({
      practitioner_id: PRAC_A,
      display_name: "Chloe Baca",
    });
    expect(second.started_at).toBe(first.started_at);
    expect(second.last_updated_by).toMatchObject({
      practitioner_id: PRAC_B,
      display_name: "Jane Doe",
    });
  });

  it("B cannot erase or overwrite who started", async () => {
    await save();
    asPractitioner(PRAC_B, "Jane Doe");
    // B sends a payload claiming they started it.
    await save({
      responses: {
        pronouns: "she/her",
        [KEY]: {
          mode: "practitioner_assisted",
          version: "v1",
          started_at: "2030-01-01T00:00:00.000Z",
          started_by: { practitioner_id: PRAC_B, display_name: "Jane Doe" },
          last_updated_at: "2030-01-01T00:00:00.000Z",
          last_updated_by: { practitioner_id: PRAC_B, display_name: "Jane Doe" },
        },
      } as Record<string, unknown>,
      expectedUpdatedAt: String(currentIntake().updated_at),
    });
    expect(provenance()!.started_by).toMatchObject({
      practitioner_id: PRAC_A,
    });
  });
});

// ---------------------------------------------------------------------------
describe("5. optimistic concurrency", () => {
  it("a stale token is refused and the row is left alone", async () => {
    await save();
    const afterFirst = JSON.parse(JSON.stringify(storedResponses()));
    // Reuse the ORIGINAL token, now superseded by the write above.
    const res = await save({
      responses: { pronouns: "she/her" },
      expectedUpdatedAt: T0,
    });
    expect(res.ok).toBe(false);
    expect(storedResponses()).toEqual(afterFirst);
  });

  it("a fresh token from the previous save succeeds", async () => {
    const first = await save();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const res = await save({
      responses: { pronouns: "she/her" },
      expectedUpdatedAt: first.updatedAt,
    });
    expect(res.ok).toBe(true);
    expect(storedResponses().pronouns).toBe("she/her");
  });
});

// ---------------------------------------------------------------------------
describe("6. handoff", () => {
  it("stamps handoff and advances to the client's step", async () => {
    await save();
    const res = await handOffAssistedIntakeAction(handoffFd());
    expect(res.ok).toBe(true);
    const p = provenance()!;
    expect(p.handoff_by).toMatchObject({ practitioner_id: PRAC_A });
    expect(typeof p.handoff_at).toBe("string");
    expect(currentIntake().current_step).toBe(TOTAL_STEPS);
  });

  it("handoff does not move last_updated_by", async () => {
    await save();
    const before = provenance()!;
    asPractitioner(PRAC_B, "Jane Doe");
    await handOffAssistedIntakeAction(handoffFd());
    const after = provenance()!;
    expect(after.last_updated_by).toEqual(before.last_updated_by);
    expect(after.last_updated_at).toBe(before.last_updated_at);
    expect(after.handoff_by).toMatchObject({ practitioner_id: PRAC_B });
  });

  it("never submits and never stamps submitted_at", async () => {
    await save();
    await handOffAssistedIntakeAction(handoffFd());
    expect(currentIntake().status).toBe("in_progress");
    expect(currentIntake().submitted_at).toBeNull();
    for (const u of state.updates) {
      expect(u.patch).not.toHaveProperty("status");
      expect(u.patch).not.toHaveProperty("submitted_at");
    }
  });

  it("invents no provenance when nothing was recorded", async () => {
    const res = await handOffAssistedIntakeAction(handoffFd());
    expect(res.ok).toBe(true);
    expect(provenance()).toBeUndefined();
  });

  it("is denied for another studio's client", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: PRAC_B, active: true, display_name: "Other", email: "o@x" },
      studio: { id: "studio-other" },
    });
    const res = await handOffAssistedIntakeAction(handoffFd());
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("is denied for a submitted intake", async () => {
    currentIntake().status = "submitted";
    const res = await handOffAssistedIntakeAction(handoffFd());
    expect(res.ok).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it("mints the client link only after the write succeeded", async () => {
    currentIntake().status = "submitted";
    await handOffAssistedIntakeAction(handoffFd());
    expect(generateIntakeLinkUrl).not.toHaveBeenCalled();

    currentIntake().status = "in_progress";
    const res = await handOffAssistedIntakeAction(handoffFd());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.intakeUrl).toContain("/intake/");
    expect(generateIntakeLinkUrl).toHaveBeenCalledTimes(1);
  });
});
