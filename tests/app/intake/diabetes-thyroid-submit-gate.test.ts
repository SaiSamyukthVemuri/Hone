import { beforeEach, describe, expect, it, vi } from "vitest";

// THE SERVER-SIDE GATE for the diabetes / thyroid subtype, driven through the
// real submitIntakeAction — never through the predicate in isolation.
//
// WHY THAT DISTINCTION MATTERS HERE. lib/intake tests prove
// findMissingRequiredAnswers and findInvalidChoiceAnswers return the right
// lists. That is NOT the same as proving the submit action calls them and
// honours the refusal — the sibling live-consent file exists because exactly
// that gap once shipped. So the oracle in this file is always the STORED ROW:
// "blocked" means the row is still in_progress and nothing about it moved.
//
// Nothing here involves a browser. The whole point of the gate is that hiding a
// control client-side is not validation.

type Row = Record<string, unknown>;

const INTAKE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const STUDIO_ID = "33333333-3333-4333-8333-333333333333";

const db: {
  client_intake_forms: Row[];
  clients: Row[];
  consent_form_templates: Row[];
  client_consent_signatures: Row[];
} = {
  client_intake_forms: [],
  clients: [],
  consent_form_templates: [],
  client_consent_signatures: [],
};

function makeBuilder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" = "select";
  let patch: Row | null = null;

  function run() {
    const rows = db[table].filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      for (const r of rows) Object.assign(r, patch);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    return { data: rows, error: null };
  }

  const builder: Record<string, unknown> = {
    select: () => builder,
    update: (p: Row) => {
      op = "update";
      patch = p;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    is: (col: string, val: unknown) => {
      filters.push((r) => (r[col] ?? null) === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return builder;
    },
    order: () => builder,
    maybeSingle: () => {
      const res = run();
      const rows = (res.data ?? []) as Row[];
      return Promise.resolve({ data: rows[0] ?? null, error: res.error });
    },
    then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onF, onR),
  };
  return builder;
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: (t: keyof typeof db) => makeBuilder(t) }),
}));
vi.mock("@/lib/intake/tokens", () => ({
  verifyIntakeToken: (t: string) =>
    t === "good"
      ? { ok: true, intake_id: INTAKE_ID }
      : { ok: false, error: "malformed" },
}));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: vi.fn(),
}));

import { submitIntakeAction } from "@/app/intake/[token]/actions";
import { INTAKE_STEPS } from "@/lib/intake/questions";

// Every required, UNCONDITIONAL answer. Conditional questions are skipped on
// purpose — that is what lets each test below choose its own medical_conditions
// and have the subtype requirement be the only thing in play.
function completeAnswers(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required || q.conditional) continue;
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "checkbox") out[q.key] = true;
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "date") out[q.key] = "1990-01-01";
      else out[q.key] = "provided";
    }
  }
  return { ...out, ...overrides };
}

function seedIntake(over: Partial<Row> = {}) {
  db.client_intake_forms = [
    {
      id: INTAKE_ID,
      client_id: CLIENT_ID,
      studio_id: STUDIO_ID,
      status: "in_progress",
      responses: {},
      current_step: 1,
      submitted_at: null,
      deleted_at: null,
      ...over,
    },
  ];
}

function storedRow(): Row {
  return db.client_intake_forms[0];
}

function storedResponses(): Record<string, unknown> {
  return storedRow().responses as Record<string, unknown>;
}

beforeEach(() => {
  db.client_intake_forms = [];
  db.clients = [{ id: CLIENT_ID, studio_id: STUDIO_ID }];
  // No live consent templates: the consent gate yields null and submission
  // proceeds exactly as it did before that feature, so the ONLY thing that can
  // block a submit in this file is the subtype.
  db.consent_form_templates = [];
  db.client_consent_signatures = [];
  seedIntake();
});

describe("1. a new intake reporting the condition must state the type", () => {
  it("refuses diabetes with no type, and writes nothing", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });

    expect(res.ok).toBe(false);
    // The stored row is the oracle: still in progress, never submitted.
    expect(storedRow().status).toBe("in_progress");
    expect(storedRow().submitted_at).toBeNull();
  });

  it("refuses a thyroid condition with no type, and writes nothing", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["thyroid"] }),
    });

    expect(res.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");
  });

  it("accepts each canonical diabetes type", async () => {
    for (const value of ["type_1", "type_2"]) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good",
        responses: completeAnswers({
          medical_conditions: ["diabetes"],
          diabetes_type: value,
        }),
      });

      expect(res.ok, value).toBe(true);
      expect(storedRow().status).toBe("submitted");
      expect(storedResponses().diabetes_type).toBe(value);
    }
  });

  it("accepts each canonical thyroid type", async () => {
    for (const value of ["hypothyroidism", "hyperthyroidism"]) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good",
        responses: completeAnswers({
          medical_conditions: ["thyroid"],
          thyroid_type: value,
        }),
      });

      expect(res.ok, value).toBe(true);
      expect(storedRow().status).toBe("submitted");
      expect(storedResponses().thyroid_type).toBe(value);
    }
  });

  it("requires BOTH types when both conditions are reported", async () => {
    const half = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["diabetes", "thyroid"],
        diabetes_type: "type_2",
      }),
    });
    expect(half.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");

    const whole = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["diabetes", "thyroid"],
        diabetes_type: "type_2",
        thyroid_type: "hypothyroidism",
      }),
    });
    expect(whole.ok).toBe(true);
    expect(storedRow().status).toBe("submitted");
  });

  it("asks for no type when neither condition is reported", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["pcos"] }),
    });

    expect(res.ok).toBe(true);
    expect(storedRow().status).toBe("submitted");
    expect(storedResponses().diabetes_type).toBeUndefined();
  });
});

describe("2. the browser does not decide what is a valid type", () => {
  it("refuses a value that is not one of the offered options", async () => {
    for (const bad of ["gestational", "Type 1", "type_3", "<script>"]) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good",
        responses: completeAnswers({
          medical_conditions: ["diabetes"],
          diabetes_type: bad,
        }),
      });

      expect(res.ok, bad).toBe(false);
      expect(storedRow().status, bad).toBe("in_progress");
    }
  });

  it("refuses a non-string value", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["diabetes"],
        diabetes_type: { value: "type_1" },
      }),
    });

    expect(res.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");
  });

  it("catches a bad value planted by an earlier draft save", async () => {
    // Draft saves stay permissive by design. That is only safe because the
    // submit gate re-checks the MERGED map rather than just this request's
    // payload — so a value smuggled in earlier is caught at the gate, not
    // waved through because this particular request looks clean.
    seedIntake({
      responses: { medical_conditions: ["diabetes"], diabetes_type: "forged" },
    });

    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });

    expect(res.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");
  });

  it("does not block on a stale value the client can no longer see", async () => {
    // Type picked, then the condition unchecked. The stale value is still in
    // the map (nothing deletes it), the question no longer applies, and the
    // client must not be trapped behind a field the wizard will not render.
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["pcos"],
        diabetes_type: "type_1",
      }),
    });

    expect(res.ok).toBe(true);
    expect(storedRow().status).toBe("submitted");
  });
});

describe("3. intakes that predate the subtype are untouched", () => {
  it("does not re-validate — or rewrite — an already-submitted intake", async () => {
    // The legacy shape: submitted with a generic "diabetes" and no type. Under
    // today's rules that map would be refused; a submitted intake is terminal
    // and must never be re-judged by rules written after it.
    const legacy = { medical_conditions: ["diabetes"], legal_name: "Dana" };
    seedIntake({
      status: "submitted",
      responses: legacy,
      submitted_at: "2026-01-01T00:00:00.000Z",
    });
    const before = JSON.parse(JSON.stringify(storedRow()));

    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });

    expect(res.ok).toBe(true);
    expect(storedRow()).toEqual(before);
    expect(storedResponses().diabetes_type).toBeUndefined();
  });

  it("does not re-validate — or rewrite — a reviewed intake", async () => {
    const legacy = { medical_conditions: ["thyroid"] };
    seedIntake({
      status: "reviewed",
      responses: legacy,
      submitted_at: "2026-01-01T00:00:00.000Z",
    });
    const before = JSON.parse(JSON.stringify(storedRow()));

    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["thyroid"],
        thyroid_type: "hypothyroidism",
      }),
    });

    // Accepted as a no-op, and — the part that matters — no type was grafted
    // onto a record the client completed before the question existed.
    expect(res.ok).toBe(true);
    expect(storedRow()).toEqual(before);
    expect(storedResponses().thyroid_type).toBeUndefined();
  });

  it("lets a legacy IN-PROGRESS intake finish, once the type is given", async () => {
    // Started before the change, resumed after it. The client is asked the new
    // question on the step they are on; nothing about their saved answers is
    // lost, and no migration or backfill was involved.
    seedIntake({ responses: { medical_conditions: ["diabetes"] } });

    const blocked = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });
    expect(blocked.ok).toBe(false);

    const done = await submitIntakeAction({
      token: "good",
      responses: completeAnswers({
        medical_conditions: ["diabetes"],
        diabetes_type: "type_2",
      }),
    });
    expect(done.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("type_2");
  });
});
