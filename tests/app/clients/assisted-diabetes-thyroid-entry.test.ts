import { beforeEach, describe, expect, it, vi } from "vitest";

// The diabetes / thyroid subtype on the PRACTITIONER-ASSISTED path (#525/#527).
//
// A practitioner sitting with the client may record what the client tells them
// about their health history — the subtype is health history, so it belongs to
// them. What must NOT change is the boundary that work established: the
// client's own first-person confirmations stay the client's, provenance is
// still derived on the server from the session, and nothing a practitioner does
// here is presented as the client's consent.
//
// The real server action runs against an in-memory fake with PostgREST filter
// semantics, so "stored" means the row genuinely changed and "refused" means it
// genuinely did not.

type Row = Record<string, unknown>;

type DbState = {
  clients: Row[];
  intakes: Row[];
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
        const matched = rowsFor(table).filter((r) => matches(r, predicates));
        for (const r of matched) {
          Object.assign(r, patch);
          // The 0015 trigger bumps updated_at on every update; modelling it is
          // what makes the optimistic-concurrency token real.
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

const STUDIO = "studio-1";
const CLIENT = "client-1";
const INTAKE = "intake-1";
const PRAC_A = "prac-a";
const T0 = "2026-08-08T10:00:00.000Z";
const MEDICAL_STEP = 3;

const state: DbState = { clients: [], intakes: [], updates: [] };

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

import { saveAssistedIntakeStepAction } from "@/app/(app)/clients/[id]/intake/actions";
import { PRACTITIONER_ASSISTED_ENTRY } from "@/lib/intake/entry-provenance";
import {
  CLIENT_OWNED_RESPONSE_KEYS,
  getQuestionByKey,
} from "@/lib/intake/questions";

const PROV = PRACTITIONER_ASSISTED_ENTRY.id;

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

function currentIntake(): Row {
  return state.intakes.find((r) => r.id === INTAKE)!;
}

function storedResponses(): Record<string, unknown> {
  return currentIntake().responses as Record<string, unknown>;
}

async function save(responses: Record<string, unknown>) {
  return saveAssistedIntakeStepAction({
    intakeId: INTAKE,
    clientId: CLIENT,
    step: MEDICAL_STEP,
    responses,
    expectedUpdatedAt: String(currentIntake().updated_at),
  });
}

beforeEach(() => {
  state.clients = [{ id: CLIENT, studio_id: STUDIO, name: "Dana", email: null }];
  state.intakes = [intakeRow()];
  state.updates = [];
  revalidatePath.mockClear();
  createAdminClientSpy.mockReset();
  createAdminClientSpy.mockReturnValue({});
  createClientSpy.mockReset();
  createClientSpy.mockResolvedValue(makeFakeSupabase(state));
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: {
      id: PRAC_A,
      active: true,
      display_name: "Chloe",
      email: "chloe@x.test",
    },
    studio: { id: STUDIO },
  });
});

describe("1. a practitioner can record the subtype", () => {
  it("persists the diabetes type alongside the parent condition", async () => {
    const res = await save({
      medical_conditions: ["diabetes"],
      diabetes_type: "type_1",
    });

    expect(res.ok).toBe(true);
    expect(storedResponses().medical_conditions).toEqual(["diabetes"]);
    expect(storedResponses().diabetes_type).toBe("type_1");
  });

  it("persists the thyroid type", async () => {
    const res = await save({
      medical_conditions: ["thyroid"],
      thyroid_type: "hyperthyroidism",
    });

    expect(res.ok).toBe(true);
    expect(storedResponses().thyroid_type).toBe("hyperthyroidism");
  });

  it("survives a later save that does not resend it", async () => {
    // The merge is existing-first, so an answer recorded on one step is not
    // lost when a subsequent step saves.
    await save({ medical_conditions: ["diabetes"], diabetes_type: "type_2" });
    const second = await save({ legal_name: "Dana Reyes" });

    expect(second.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("type_2");
    expect(storedResponses().legal_name).toBe("Dana Reyes");
  });

  it("persists EVERY canonical value, catch-alls included", async () => {
    // The assisted editor renders the same option list, so every value a client
    // can choose must also be recordable by a practitioner sitting with them.
    for (const [key, condition] of [
      ["diabetes_type", "diabetes"],
      ["thyroid_type", "thyroid"],
    ] as const) {
      const options = getQuestionByKey(key)?.options ?? [];
      expect(options.length).toBeGreaterThan(0);
      for (const opt of options) {
        state.intakes = [intakeRow()];
        const res = await save({
          medical_conditions: [condition],
          [key]: opt.value,
        });

        expect(res.ok, `${key}=${opt.value}`).toBe(true);
        expect(storedResponses()[key], `${key}=${opt.value}`).toBe(opt.value);
      }
    }
  });

  it("records gestational and 'not sure' without complaint", async () => {
    const res = await save({
      medical_conditions: ["diabetes", "thyroid"],
      diabetes_type: "gestational",
      thyroid_type: "other_or_unsure",
    });

    expect(res.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("gestational");
    expect(storedResponses().thyroid_type).toBe("other_or_unsure");
  });

  it("lets the practitioner correct a type they mis-recorded", async () => {
    await save({ medical_conditions: ["diabetes"], diabetes_type: "type_1" });
    const fix = await save({
      medical_conditions: ["diabetes"],
      diabetes_type: "type_2",
    });

    expect(fix.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("type_2");
  });
});

describe("2. the assisted path is not the soft way in", () => {
  it("refuses a value that is not one of the offered options", async () => {
    const res = await save({
      medical_conditions: ["diabetes"],
      diabetes_type: "gestational_diabetes",
    });

    expect(res.ok).toBe(false);
    // Nothing landed — not the bad value, and not the parent answer alongside it.
    expect(storedResponses().diabetes_type).toBeUndefined();
    expect(storedResponses().medical_conditions).toBeUndefined();
    expect(currentIntake().updated_at).toBe(T0);
  });

  it("refuses a bad value even when the rest of the payload is fine", async () => {
    const res = await save({
      legal_name: "Dana Reyes",
      medical_conditions: ["thyroid"],
      thyroid_type: "not-an-option",
    });

    expect(res.ok).toBe(false);
    expect(storedResponses().legal_name).toBeUndefined();
  });

  it("still allows an incomplete save — a work in progress is normal", async () => {
    // Recording the condition now and the type in a moment must not be refused;
    // only a PRESENT value that is not on the list is.
    const res = await save({ medical_conditions: ["diabetes"] });

    expect(res.ok).toBe(true);
    expect(storedResponses().medical_conditions).toEqual(["diabetes"]);
    expect(storedResponses().diabetes_type).toBeUndefined();
  });
});

describe("3. the client-owned boundary is exactly where it was", () => {
  it("records server-derived provenance for the subtype answer", async () => {
    const res = await save({
      medical_conditions: ["diabetes"],
      diabetes_type: "type_1",
    });

    expect(res.ok).toBe(true);
    const prov = storedResponses()[PROV] as Record<string, unknown>;
    expect(prov).toBeDefined();
    // Attribution comes from the session, never from the payload.
    expect(JSON.stringify(prov)).toContain(PRAC_A);
  });

  it("does not let the practitioner tick a client confirmation", async () => {
    const res = await save({
      medical_conditions: ["diabetes"],
      diabetes_type: "type_1",
      ack_accurate: true,
    });

    // The save itself is refused, because it would CHANGE a client-owned
    // answer. Either way the confirmation must not be stored.
    expect(res.ok).toBe(false);
    expect(storedResponses().ack_accurate).toBeUndefined();
  });

  it("keeps the subtype out of the client-owned set", async () => {
    // Two-way: the subtype is practitioner-recordable, the confirmations are
    // not. If this ever inverts, the tests above stop meaning what they say.
    expect(CLIENT_OWNED_RESPONSE_KEYS.has("diabetes_type")).toBe(false);
    expect(CLIENT_OWNED_RESPONSE_KEYS.has("thyroid_type")).toBe(false);
    expect(CLIENT_OWNED_RESPONSE_KEYS.has("ack_accurate")).toBe(true);
  });

  it("never marks the intake submitted", async () => {
    await save({ medical_conditions: ["diabetes"], diabetes_type: "type_1" });

    expect(currentIntake().status).toBe("in_progress");
    expect(currentIntake().submitted_at).toBeNull();
  });
});
