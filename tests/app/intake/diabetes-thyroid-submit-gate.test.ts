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

let profileRace: (() => void) | null = null;
let profileFailure = false;

function makeBuilder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" = "select";
  let projection = "";
  let patch: Row | null = null;

  function run() {
    const rows = db[table].filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      if (table === "clients" && profileFailure) return { data: [], error: { message: "Synthetic profile failure" } };
      for (const r of rows) Object.assign(r, patch);
      return { data: rows.map((r) => ({ id: r.id })), error: null };
    }
    return { data: rows, error: null };
  }

  const builder: Record<string, unknown> = {
    select: (columns: string) => { projection = columns; return builder; },
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
      const snapshot = rows[0] ? { ...rows[0] } : null;
      if (table === "clients" && projection.includes("allergies") && profileRace) {
        const edit = profileRace; profileRace = null; edit();
      }
      return Promise.resolve({ data: snapshot, error: res.error });
    },
    then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onF, onR),
  };
  return builder;
}

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (t: keyof typeof db) => makeBuilder(t),
    // Unit facade for the one governed command. Real locking/profile rollback
    // and ACLs are separately prepared in the existing DB suite, not proved here.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "write_intake_revision") throw new Error("unexpected writer");
      const row = db.client_intake_forms.find((r) => r.id === args.p_intake_id && r.studio_id === args.p_studio_id && r.client_id === args.p_client_id && !r.deleted_at);
      if (!row) return { data: [{ outcome: "not_available", new_revision: null }], error: null };
      if (row.status !== "in_progress") return { data: [{ outcome: "terminal", new_revision: null }], error: null };
      if (String(row.revision) !== args.p_expected_revision) return { data: [{ outcome: "conflict", new_revision: null }], error: null };
      if (args.p_operation === "submit") {
        if (profileFailure) return { data: null, error: { message: "Synthetic profile failure" } };
        if (profileRace) { const edit = profileRace; profileRace = null; edit(); }
        const client = db.clients.find((c) => c.id === row.client_id && c.studio_id === row.studio_id)!;
        const contribution = args.p_profile as Record<string, string | null>;
        // 0243 casts date_of_birth with ::date inside the transaction; a value
        // the cast rejects raises and rolls the whole submission back.
        const dob = contribution.date_of_birth;
        if (!db.clients.find((c) => c.id === row.client_id)?.date_of_birth && dob
            && (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))) {
          return { data: null, error: { code: "22007", message: "invalid input syntax for type date" } };
        }
        for (const key of ["emergency_contact_name", "emergency_contact_phone", "date_of_birth", "pronouns", "address"]) {
          if (!client[key] && contribution[key]) client[key] = contribution[key];
        }
        if (contribution.allergy_text) client.allergies = [client.allergies, contribution.allergy_text].filter(Boolean).join("\n");
      }
      row.responses = args.p_responses; row.current_step = args.p_step; row.revision = Number(row.revision) + 1;
      if (args.p_operation === "submit") { row.status = "submitted"; row.submitted_at = new Date().toISOString(); }
      return { data: [{ outcome: args.p_operation === "submit" ? "submitted" : "saved", new_revision: String(row.revision) }], error: null };
    },
  }),
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

import { saveIntakeStepAction, submitIntakeAction } from "@/app/intake/[token]/actions";
import { getQuestionByKey, INTAKE_STEPS } from "@/lib/intake/questions";

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
      revision: 0,
    questionnaire_snapshot: null,
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
  profileRace = null; profileFailure = false;
  db.client_intake_forms = [];
  db.clients = [{ id: CLIENT_ID, studio_id: STUDIO_ID }];
  // No live consent templates: the consent gate yields null and submission
  // proceeds exactly as it did before that feature, so the ONLY thing that can
  // block a submit in this file is the subtype.
  db.consent_form_templates = [];
  db.client_consent_signatures = [];
  seedIntake();
});

describe("CLN-004 yes/no values on the real public write actions", () => {
  it.each(["maybe", "YES", false, {}])("rejects malformed %j on draft save without writing", async (value) => {
    seedIntake({ responses: { has_allergies: "yes", has_allergies_notes: "synthetic note" } });
    const before = JSON.stringify(storedRow());
    const result = await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 3, responses: { has_allergies: value } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
  });

  it.each(["maybe", "YES", false, {}])("rejects malformed %j on submit without changing the draft", async (value) => {
    const before = JSON.stringify(storedRow());
    const result = await submitIntakeAction({ token: "good", expectedRevision: String(storedRow().revision), responses: completeAnswers({ has_allergies: value }) });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
  });

  it("allows incomplete drafts and preserves untouched historic values until explicitly corrected", async () => {
    seedIntake({ responses: { has_allergies: "historic-unknown" } });
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 1, responses: { preferred_name: "Demo" } })).ok).toBe(true);
    expect(storedResponses().has_allergies).toBe("historic-unknown");
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 3, responses: { has_allergies: "" } })).ok).toBe(true);
    expect(storedResponses().has_allergies).toBe("");
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 3, responses: { has_allergies: "no" } })).ok).toBe(true);
    expect(storedResponses().has_allergies).toBe("no");
  });
});

describe("1. a new intake reporting the condition must state the type", () => {
  it("refuses diabetes with no type, and writes nothing", async () => {
    const res = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });

    expect(res.ok).toBe(false);
    // The stored row is the oracle: still in progress, never submitted.
    expect(storedRow().status).toBe("in_progress");
    expect(storedRow().submitted_at).toBeNull();
  });

  it("refuses a thyroid condition with no type, and writes nothing", async () => {
    const res = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({ medical_conditions: ["thyroid"] }),
    });

    expect(res.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");
  });

  it("accepts EVERY canonical diabetes type, catch-alls included", async () => {
    // Driven off the option list, so a newly offered value cannot ship without
    // a proof that a real client can actually submit with it.
    const options = getQuestionByKey("diabetes_type")?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good", expectedRevision: String(storedRow().revision),
        responses: completeAnswers({
          medical_conditions: ["diabetes"],
          diabetes_type: opt.value,
        }),
      });

      expect(res.ok, opt.value).toBe(true);
      expect(storedRow().status, opt.value).toBe("submitted");
      expect(storedResponses().diabetes_type).toBe(opt.value);
    }
  });

  it("accepts EVERY canonical thyroid type, catch-all included", async () => {
    const options = getQuestionByKey("thyroid_type")?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const opt of options) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good", expectedRevision: String(storedRow().revision),
        responses: completeAnswers({
          medical_conditions: ["thyroid"],
          thyroid_type: opt.value,
        }),
      });

      expect(res.ok, opt.value).toBe(true);
      expect(storedRow().status, opt.value).toBe("submitted");
      expect(storedResponses().thyroid_type).toBe(opt.value);
    }
  });

  it("lets a gestational or unsure client through — the point of the change", async () => {
    // The first draft made this client choose between a wrong answer and an
    // unfinished intake. Both must now submit cleanly and store what they said.
    seedIntake();
    const gestational = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({
        medical_conditions: ["diabetes"],
        diabetes_type: "gestational",
      }),
    });
    expect(gestational.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("gestational");

    seedIntake();
    const unsure = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({
        medical_conditions: ["diabetes", "thyroid"],
        diabetes_type: "other_or_unsure",
        thyroid_type: "other_or_unsure",
      }),
    });
    expect(unsure.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("other_or_unsure");
    expect(storedResponses().thyroid_type).toBe("other_or_unsure");
  });

  it("requires BOTH types when both conditions are reported", async () => {
    const half = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({
        medical_conditions: ["diabetes", "thyroid"],
        diabetes_type: "type_2",
      }),
    });
    expect(half.ok).toBe(false);
    expect(storedRow().status).toBe("in_progress");

    const whole = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
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
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({ medical_conditions: ["pcos"] }),
    });

    expect(res.ok).toBe(true);
    expect(storedRow().status).toBe("submitted");
    expect(storedResponses().diabetes_type).toBeUndefined();
  });
});

describe("2. the browser does not decide what is a valid type", () => {
  it("refuses a value that is not one of the offered options", async () => {
    for (const bad of ["Type 1", "type_3", "gestational_diabetes", "other", "<script>"]) {
      seedIntake();
      const res = await submitIntakeAction({
        token: "good", expectedRevision: String(storedRow().revision),
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
    // Refused by the REQUIRED check rather than the choice check — a
    // single_select answer that is not a string is not a provided answer at
    // all, so it never reaches the membership test. Verified by negative
    // control: disabling the choice gate leaves this case still refused.
    // Recorded here because a reader would otherwise assume this proves the
    // choice gate, and it does not.
    const res = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
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
      token: "good", expectedRevision: String(storedRow().revision),
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
      token: "good", expectedRevision: String(storedRow().revision),
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
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("terminal");
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
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({
        medical_conditions: ["thyroid"],
        thyroid_type: "hypothyroidism",
      }),
    });

    // Accepted as a no-op, and — the part that matters — no type was grafted
    // onto a record the client completed before the question existed.
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("terminal");
    expect(storedRow()).toEqual(before);
    expect(storedResponses().thyroid_type).toBeUndefined();
  });

  it("lets a legacy IN-PROGRESS intake finish, once the type is given", async () => {
    // Started before the change, resumed after it. The client is asked the new
    // question on the step they are on; nothing about their saved answers is
    // lost, and no migration or backfill was involved.
    seedIntake({ responses: { medical_conditions: ["diabetes"] } });

    const blocked = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({ medical_conditions: ["diabetes"] }),
    });
    expect(blocked.ok).toBe(false);

    const done = await submitIntakeAction({
      token: "good", expectedRevision: String(storedRow().revision),
      responses: completeAnswers({
        medical_conditions: ["diabetes"],
        diabetes_type: "type_2",
      }),
    });
    expect(done.ok).toBe(true);
    expect(storedResponses().diabetes_type).toBe("type_2");
  });
});


describe("4332229852 whole-map draft navigation", () => {
  it.each(["historic-unknown", false, { legacy: "unknown" }])("preserves unchanged legacy %j posted with the whole public map", async (legacy) => {
    seedIntake({ responses: { has_allergies: legacy, preferred_name: "Before" } });
    const wholeMap = JSON.parse(JSON.stringify(storedResponses()));
    const result = await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 1, responses: { ...wholeMap, preferred_name: "After" } });
    expect(result.ok).toBe(true);
    expect(storedResponses().preferred_name).toBe("After");
    expect(storedResponses().has_allergies).toEqual(legacy);
    const before = JSON.stringify(storedRow());
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 3, responses: { ...storedResponses(), has_allergies: "new-invalid" } })).ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
    expect((await submitIntakeAction({ token: "good", expectedRevision: String(storedRow().revision), responses: completeAnswers({ has_allergies: legacy }) })).ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: String(storedRow().revision), step: 3, responses: { ...storedResponses(), has_allergies: "no" } })).ok).toBe(true);
  });
});


describe("0243 public snapshot conflicts through real actions", () => {
  it("two editors with the same snapshot cannot overwrite the first save", async () => {
    const snapshot = String(storedRow().revision);
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: snapshot, step: 1, responses: { preferred_name: "First" } })).ok).toBe(true);
    const persisted = JSON.stringify(storedRow());
    const second = await saveIntakeStepAction({ token: "good", expectedRevision: snapshot, step: 1, responses: { preferred_name: "Second" } });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("conflict");
    expect(JSON.stringify(storedRow())).toBe(persisted);
  });
  it("never assumes a missing browser revision means legacy zero", async () => {
    const before = JSON.stringify(storedRow());
    const result = await saveIntakeStepAction({ token: "good", step: 1, responses: { preferred_name: "Missing counter" } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
  });
});


describe("0243 profile synchronization through the real submit action", () => {
  it("preserves a practitioner edit interleaved with the old profile read/write window", async () => {
    db.clients[0].allergies = "Prior allergies";
    db.clients[0].emergency_contact_phone = null;
    profileRace = () => { db.clients[0].allergies = "Concurrent practitioner"; db.clients[0].emergency_contact_phone = "Latest emergency"; };
    const result = await submitIntakeAction({ token: "good", expectedRevision: "0", responses: completeAnswers({ has_allergies: "yes", has_allergies_notes: "Synthetic intake contribution", requires_epipen: "no", emergency_contact_phone: "+14165550123" }) });
    expect(result.ok).toBe(true);
    expect(db.clients[0].allergies).toContain("Concurrent practitioner");
    expect(db.clients[0].allergies).toContain("Synthetic intake contribution");
    expect(db.clients[0].emergency_contact_phone).toBe("Latest emergency");
  });
  it.each(["not-a-date", "05/04/1990", "1990-13-01", "1850-01-01", "2999-01-01"])(
    "an unusable birth date %j still submits and leaves the profile birth date untouched", async (dob) => {
      const result = await submitIntakeAction({ token: "good", expectedRevision: "0", responses: completeAnswers({ date_of_birth: dob }) });
      expect(result.ok).toBe(true);
      expect(storedRow().status).toBe("submitted");
      expect(storedResponses().date_of_birth).toBe(dob);
      expect(db.clients[0].date_of_birth).toBeUndefined();
    });
  it("a valid birth date still fills an empty profile field", async () => {
    const result = await submitIntakeAction({ token: "good", expectedRevision: "0", responses: completeAnswers({ date_of_birth: "1990-04-02" }) });
    expect(result.ok).toBe(true);
    expect(db.clients[0].date_of_birth).toBe("1990-04-02");
  });
  it("does not report a successful submitted intake when the atomic profile write fails", async () => {
    profileFailure = true;
    const before = JSON.stringify(storedRow());
    const result = await submitIntakeAction({ token: "good", expectedRevision: "0", responses: completeAnswers({ pronouns: "they/them" }) });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(storedRow())).toBe(before);
  });
});

describe("0246 real public action snapshot boundary", () => {
  it("uses issued required rules after current catalogue changes and never accepts caller catalogue text", async () => {
    const { ISSUED_QUESTIONNAIRE } = await import("@/lib/intake/questionnaire");
    seedIntake({ questionnaire_snapshot: structuredClone(ISSUED_QUESTIONNAIRE) });
    const current = getQuestionByKey("has_allergies")!;
    const required = current.required;
    try {
      current.required = false;
      const responses = completeAnswers(); delete responses.has_allergies;
      responses.questionnaire_snapshot = { arbitrary: "caller" };
      const before = JSON.stringify(storedRow());
      expect((await submitIntakeAction({ token: "good", expectedRevision: "0", responses })).ok).toBe(false);
      expect(JSON.stringify(storedRow())).toBe(before);
      expect((await saveIntakeStepAction({ token: "good", expectedRevision: "0", step: 1, responses: { preferred_name: "Saved", questionnaire_snapshot: { arbitrary: "caller" } } })).ok).toBe(true);
      expect(storedResponses()).not.toHaveProperty("questionnaire_snapshot");
      expect(storedRow().questionnaire_snapshot).toEqual(ISSUED_QUESTIONNAIRE);
    } finally { current.required = required; }
  });
  it.each([{}, { schema_version: 99 }, undefined])("refuses unsupported/missing known snapshot %j without changing the draft or profile", async (snapshot) => {
    seedIntake({ questionnaire_snapshot: snapshot });
    const before = JSON.stringify(db);
    expect((await saveIntakeStepAction({ token: "good", expectedRevision: "0", step: 1, responses: { preferred_name: "Unsaved" } })).ok).toBe(false);
    expect((await submitIntakeAction({ token: "good", expectedRevision: "0", responses: completeAnswers() })).ok).toBe(false);
    expect(JSON.stringify(db)).toBe(before);
  });
});
