import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ELECTROLYSIS_ACKNOWLEDGEMENT } from "@/lib/intake/acknowledgements";
import { INTAKE_CONSENT_RESPONSES } from "@/lib/intake/consent-forms";
import { INTAKE_STEPS } from "@/lib/intake/questions";

// Versioned electrolysis acknowledgement — RETIRED at the PUBLIC BOUNDARY.
//
// This file used to prove the COLLECTION wiring: that the real
// saveIntakeStepAction / submitIntakeAction built, validated and stored a
// versioned acknowledgement, and refused forged ones. #529 replaced the
// acknowledgement with the studio's own live consent forms, so collection is
// retired and those proofs are retired with it.
//
// What it proves now is the retirement itself, at the same real action
// boundary: a new intake submits with NO acknowledgement, neither key is
// created, and a forged payload for either key is not persisted — because the
// sanitizer carve-out that made the key browser-authorable is gone rather than
// merely unused. Historical rows are proven untouched.
//
// The source guards below are unchanged and still earn their place.
//
// Service-independent: no Supabase, no browser, no network.

const CANON = ELECTROLYSIS_ACKNOWLEDGEMENT;
const INTAKE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const STUDIO_ID = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

// consent_form_templates is present but EMPTY, which is the "studio has no
// live consent forms" case. submitIntakeAction now re-resolves that table on
// every submit, and an empty result must leave submission behaving exactly as
// it did before live consent forms existed — which is precisely what every
// assertion in this file continues to prove.
const db: {
  client_intake_forms: Row[];
  clients: Row[];
  consent_form_templates: Row[];
} = {
  client_intake_forms: [],
  clients: [],
  consent_form_templates: [],
};
const failNextUpdateWith: { value: { code: string; message: string } | null } = {
  value: null,
};

// Minimal chainable PostgREST fake. Executes on await (`then`) or on
// `maybeSingle()`, so a filtered-out row genuinely does not change — the
// same "blocked means the row did not move" property the existing intake
// review tests rely on.
function makeBuilder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "update" = "select";
  let patch: Row | null = null;

  function run() {
    const rows = db[table].filter((r) => filters.every((f) => f(r)));
    if (op === "update") {
      if (failNextUpdateWith.value) {
        const err = failNextUpdateWith.value;
        failNextUpdateWith.value = null;
        return { data: null, error: err };
      }
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
    t === "good" ? { ok: true, intake_id: INTAKE_ID } : { ok: false, error: "malformed" },
}));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => {},
}));

const { saveIntakeStepAction, submitIntakeAction } = await import(
  "@/app/intake/[token]/actions"
);

// Every required answer, so the tests isolate the acknowledgement.
function completeAnswers(): Record<string, unknown> {
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
  // RETIRED: this used to attach the acknowledgement claim. A complete set of
  // answers no longer includes it, which is the point of the tests below.
  return out;
}

function seed(overrides: Row = {}) {
  db.client_intake_forms = [
    {
      id: INTAKE_ID,
      status: "in_progress",
      responses: {},
      studio_id: STUDIO_ID,
      client_id: CLIENT_ID,
      deleted_at: null,
      current_step: 5,
      submitted_at: null,
      ...overrides,
    },
  ];
  db.clients = [
    {
      id: CLIENT_ID,
      studio_id: STUDIO_ID,
      name: "Test Client",
      emergency_contact_name: "x",
      emergency_contact_phone: "x",
      date_of_birth: "1990-01-01",
      pronouns: "they/them",
      address: "x",
      allergies: "x",
    },
  ];
}

const row = () => db.client_intake_forms[0];
const storedResponses = () => row().responses as Record<string, unknown>;
const storedAck = () => storedResponses()[CANON.id] as Record<string, unknown>;

beforeEach(() => {
  failNextUpdateWith.value = null;
  seed();
});

// Source-guard helpers (unchanged).
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Strip // line comments and {/* jsx */} blocks so negative greps target
// real code, not prose that legitimately names a forbidden symbol.
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const MODULE = "lib/intake/acknowledgements.ts";
const ACTIONS = "app/intake/[token]/actions.ts";
const WIZARD = "app/intake/[token]/IntakeWizard.tsx";
const REVIEW = "app/(app)/clients/[id]/intake/page.tsx";
const QUESTIONS = "lib/intake/questions.ts";
// The question control renderer moved out of the wizard when the
// practitioner-assisted editor was added, so both surfaces render one
// implementation. The "nothing auto-checks a checkbox" guarantee below
// follows the code to its new home rather than being weakened.
const FIELD = "components/intake/intake-question-field.tsx";


describe("16. the wording lives in exactly one source", () => {
  // A distinctive fragment of the wording. If it appears in more than one
  // shipped file, the client and practitioner surfaces have drifted apart.
  const FRAGMENT = "permanent results build over a series of sessions";

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx|sql|md)$/.test(e.name)) out.push(rel);
    }
    return out;
  }

  it("the wording string appears in one shipped file only", () => {
    const files = [
      ...walk("app"),
      ...walk("lib"),
      ...walk("components"),
      ...walk("supabase"),
    ];
    const hits = files.filter((f) => read(f).includes(FRAGMENT));
    expect(hits).toEqual([MODULE]);
  });

  it("the question label and the review card both READ the shared constant", () => {
    // RETIRED: the questionnaire no longer renders a label or help text from
    // the constant, because there is no question. What remains is the review
    // card, which reads the STORED historical snapshot through the legacy
    // reader — the only surviving consumer.
    expect(read(QUESTIONS)).not.toMatch(/label: ELECTROLYSIS_ACKNOWLEDGEMENT\.wording/);
    expect(read(REVIEW)).toMatch(/readElectrolysisAcknowledgement/);
    // The card renders the STORED snapshot, not the current constant.
    expect(codeOnly(read(REVIEW))).toMatch(/\{view\.wording\}/);
  });
});

describe("13. no typed signature anywhere in this feature", () => {
  for (const rel of [MODULE, ACTIONS, WIZARD, REVIEW, FIELD]) {
    it(`${rel} collects no signature`, () => {
      const code = codeOnly(read(rel));
      expect(code).not.toMatch(/signature_name|signatureName|typedName|signedName/);
      expect(code).not.toMatch(/createConsentSignatureAction|client_consent_signatures/);
    });
  }

  it("the acknowledgement never touches the consent-signature system", () => {
    expect(codeOnly(read(MODULE))).not.toMatch(/consent_form_templates|template_hash/);
  });
});

describe("18. no migration, and no schema change", () => {
  it("no migration file mentions the acknowledgement", () => {
    const dir = "supabase/migrations";
    const offenders = readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => read(`${dir}/${f}`).includes(CANON.id));
    expect(offenders).toEqual([]);
  });

  it("retirement writes nothing, and still adds no column or table", () => {
    // Retiring the collection removed both write paths. What matters for this
    // guard is unchanged: no column, table or type was ever added, and none is
    // added by removing it either. Historical records stay in the `responses`
    // map migration 0015 already provides.
    const src = read(ACTIONS);
    expect(src).not.toMatch(/merged\[ELECTROLYSIS_ACKNOWLEDGEMENT\.id\]/);
    expect(src).not.toMatch(/acknowledgement_version|acknowledged_at:/);
  });
});

describe("17. Session 1D surfaces are not involved", () => {
  const OWNED_BY_1D = [
    "app/(app)/calendar/[id]/page.tsx",
    "scripts/browser-groups.mjs",
    "tests/ci/browser-selection.test.ts",
    "e2e/helpers/seed.ts",
  ];

  for (const rel of OWNED_BY_1D) {
    it(`${rel} does not reference the acknowledgement`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/ELECTROLYSIS_ACKNOWLEDGEMENT|electrolysis_acknowledgement|ack_electrolysis_nature/);
    });
  }

  it("the acknowledgement is confined to the intake surface", () => {
    const importers = [MODULE, QUESTIONS, ACTIONS, WIZARD, REVIEW];
    for (const rel of importers) {
      expect(read(rel)).toMatch(/acknowledgement|ELECTROLYSIS_ACKNOWLEDGEMENT/i);
    }
  });
});

// ---------------------------------------------------------------------------
// RETIREMENT — proven at the REAL action boundary
// ---------------------------------------------------------------------------
describe("retirement — a new intake collects no acknowledgement", () => {
  it("submits with NO acknowledgement, and creates neither legacy key", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers(),
    });
    expect(res).toEqual({ ok: true });
    expect(row().status).toBe("submitted");
    expect(storedResponses()).not.toHaveProperty(CANON.id);
    expect(storedResponses()).not.toHaveProperty(CANON.questionKey);
  });

  it("a forged acknowledgement RECORD is not persisted", async () => {
    // The sanitizer carve-out that used to admit this key is gone, so the
    // value never reaches storage — there is no gate left to validate it.
    await submitIntakeAction({
      token: "good",
      responses: {
        ...completeAnswers(),
        [CANON.id]: {
          id: CANON.id,
          version: "v99",
          wording: "FORGED WORDING",
          accepted: true,
          accepted_at: "1999-01-01T00:00:00.000Z",
        },
      },
    });
    expect(storedResponses()).not.toHaveProperty(CANON.id);
    expect(JSON.stringify(storedResponses())).not.toContain("FORGED");
  });

  it("a forged checkbox answer cannot re-enable legacy collection", async () => {
    await submitIntakeAction({
      token: "good",
      responses: { ...completeAnswers(), [CANON.questionKey]: true },
    });
    // Not a question any more, so the whitelist drops it.
    expect(storedResponses()).not.toHaveProperty(CANON.questionKey);
  });

  it("a DRAFT save also refuses to author either key", async () => {
    await saveIntakeStepAction({
      token: "good",
      step: 1,
      responses: {
        legal_name: "Dana",
        [CANON.questionKey]: true,
        [CANON.id]: { id: CANON.id, version: "v1", wording: "x", accepted: true },
      },
    });
    expect(storedResponses().legal_name).toBe("Dana");
    expect(storedResponses()).not.toHaveProperty(CANON.id);
    expect(storedResponses()).not.toHaveProperty(CANON.questionKey);
  });

  it("a HISTORICAL acknowledgement survives a later save untouched", async () => {
    // The merge is {...stored, ...incoming} and the key is stripped on the way
    // in, so what a client recorded before retirement stays exactly as it was.
    const historical = {
      id: CANON.id,
      version: CANON.version,
      wording: CANON.wording,
      accepted: true,
      accepted_at: "2026-08-01T09:00:00.000Z",
    };
    storedResponses()[CANON.id] = historical;
    storedResponses()[CANON.questionKey] = true;

    await saveIntakeStepAction({
      token: "good",
      step: 2,
      responses: {
        pronouns: "they/them",
        // A crafted attempt to overwrite the historical record.
        [CANON.id]: { id: CANON.id, version: "v1", wording: "OVERWRITTEN", accepted: false },
        [CANON.questionKey]: false,
      },
    });
    expect(storedResponses()[CANON.id]).toEqual(historical);
    expect(storedResponses()[CANON.questionKey]).toBe(true);
    expect(JSON.stringify(storedResponses())).not.toContain("OVERWRITTEN");
  });

  it("a pre-retirement draft left UNTICKED can now submit, unticked record intact", async () => {
    // The behavioural half of the copy fix in lib/intake/acknowledgements.ts.
    // While #518 gated submission, an unticked record was draft-only. It is
    // now reachable on a SUBMITTED row, so the review copy must not claim
    // submission is blocked.
    const unticked = {
      id: CANON.id,
      version: CANON.version,
      wording: CANON.wording,
      accepted: false,
    };
    seed({ responses: { [CANON.id]: unticked, [CANON.questionKey]: false } });

    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers(),
    });
    expect(res).toEqual({ ok: true });
    expect(row().status).toBe("submitted");
    // The historical record is neither rewritten nor promoted to accepted.
    expect(storedAck()).toEqual(unticked);
    expect(storedResponses()[CANON.questionKey]).toBe(false);
  });

  it("the public sanitizer no longer names the retired key at all", () => {
    const src = read("app/intake/[token]/actions.ts");
    const fn = src.slice(
      src.indexOf("function sanitizeResponses"),
      src.indexOf("export async function saveIntakeStepAction"),
    );
    const code = fn
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(code).not.toContain("ELECTROLYSIS_ACKNOWLEDGEMENT");
    expect(code).toContain("INTAKE_CONSENT_RESPONSES.id");
  });

  it("#529's consent response is what a new intake records instead", async () => {
    // Sanity: the replacement is the active flow. With no live forms seeded
    // the studio has nothing to complete, which is the pre-existing
    // no-live-forms behaviour and must remain unblocked.
    const res = await submitIntakeAction({
      token: "good",
      responses: completeAnswers(),
    });
    expect(res).toEqual({ ok: true });
    expect(INTAKE_CONSENT_RESPONSES.id).toBe("intake_consent_responses");
  });
});
