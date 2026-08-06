import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  buildElectrolysisAcknowledgementClaim,
  ELECTROLYSIS_ACKNOWLEDGEMENT,
} from "@/lib/intake/acknowledgements";
import { INTAKE_STEPS } from "@/lib/intake/questions";

// Versioned electrolysis acknowledgement — the PUBLIC BOUNDARY.
//
// The first half drives the REAL saveIntakeStepAction / submitIntakeAction
// against an in-memory admin client, so the forgery cases are proven at the
// action boundary and not merely against the pure validator. The second
// half is source guards for the properties a behavioural test cannot reach
// (no typed signature anywhere, one shared wording source, no migration,
// no Session 1D surface touched).
//
// Service-independent: no Supabase, no browser, no network.

const CANON = ELECTROLYSIS_ACKNOWLEDGEMENT;
const INTAKE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const STUDIO_ID = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, unknown>;

const db: { client_intake_forms: Row[]; clients: Row[] } = {
  client_intake_forms: [],
  clients: [],
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
  out[CANON.id] = buildElectrolysisAcknowledgementClaim(true);
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

describe("submit boundary — a valid acknowledgement is recorded", () => {
  it("submits, and persists a server-authored versioned record", async () => {
    const before = Date.now();
    const res = await submitIntakeAction({ token: "good", responses: completeAnswers() });
    expect(res).toEqual({ ok: true });
    expect(row().status).toBe("submitted");

    const ack = storedAck();
    expect(ack.id).toBe(CANON.id);
    expect(ack.version).toBe(CANON.version);
    expect(ack.wording).toBe(CANON.wording);
    expect(ack.accepted).toBe(true);
    // accepted_at is stamped from the SERVER clock.
    const at = Date.parse(String(ack.accepted_at));
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    // The plain checkbox answer is stored alongside, under its own key.
    expect(storedResponses()[CANON.questionKey]).toBe(true);
  });

  it("stores exactly the five contract fields — nothing the client injected", async () => {
    await submitIntakeAction({
      token: "good",
      responses: {
        ...completeAnswers(),
        [CANON.id]: {
          ...buildElectrolysisAcknowledgementClaim(true),
          accepted_at: "1999-01-01T00:00:00.000Z",
          signature_name: "Ada Lovelace",
          studio_id: "attacker-studio",
        },
      },
    });
    expect(row().status).toBe("submitted");
    expect(Object.keys(storedAck()).sort()).toEqual([
      "accepted",
      "accepted_at",
      "id",
      "version",
      "wording",
    ]);
    expect(storedAck().accepted_at).not.toBe("1999-01-01T00:00:00.000Z");
  });
});

describe("submit boundary — forged payloads do not submit", () => {
  const forgeries: Array<[string, Record<string, unknown>]> = [
    ["missing acknowledgement record", { [CANON.id]: undefined }],
    ["accepted: false", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), accepted: false } }],
    ["accepted: 'true' (string)", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), accepted: "true" } }],
    ["wrong id", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), id: "marketing_consent" } }],
    ["unknown version", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), version: "v99" } }],
    ["downgraded version", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), version: "v0" } }],
    ["altered wording", { [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), wording: "I agree to anything." } }],
    ["record present but checkbox false", { [CANON.questionKey]: false }],
    ["record present but checkbox absent", { [CANON.questionKey]: undefined }],
    ["record is a bare true", { [CANON.id]: true }],
  ];

  for (const [name, override] of forgeries) {
    it(`refuses: ${name}`, async () => {
      const responses = { ...completeAnswers(), ...override };
      const res = await submitIntakeAction({ token: "good", responses });
      expect(res.ok).toBe(false);
      // The row never transitions and never gains an acceptance.
      expect(row().status).toBe("in_progress");
      expect(row().submitted_at ?? null).toBeNull();
      const ack = storedResponses()[CANON.id] as Record<string, unknown> | undefined;
      expect(ack?.accepted ?? false).not.toBe(true);
    });
  }

  it("names no key, version, table or database detail in any refusal", async () => {
    for (const [, override] of forgeries) {
      seed();
      const res = await submitIntakeAction({
        token: "good",
        responses: { ...completeAnswers(), ...override },
      });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.error).not.toMatch(/electrolysis_acknowledgement|ack_electrolysis_nature/);
      expect(res.error).not.toMatch(/client_intake_forms|jsonb|postgres|constraint|null value/i);
      expect(res.error).not.toMatch(/\bv1\b/);
      expect(res.error.length).toBeLessThan(200);
    }
  });

  it("tells a client with stale wording to refresh, without leaking internals", async () => {
    const res = await submitIntakeAction({
      token: "good",
      responses: {
        ...completeAnswers(),
        [CANON.id]: { ...buildElectrolysisAcknowledgementClaim(true), version: "v0" },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/refresh/i);
  });

  it("returns the generic error — never the raw DB message — when the write fails", async () => {
    failNextUpdateWith.value = {
      code: "23514",
      message: 'new row violates check constraint "client_intake_forms_status_check"',
    };
    const res = await submitIntakeAction({ token: "good", responses: completeAnswers() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/constraint|23514|client_intake_forms/);
    expect(res.error).toBe(
      "We couldn't save your intake. Please refresh and try again.",
    );
  });
});

describe("legacy compatibility", () => {
  it("an already-submitted intake is returned ok and never rewritten", async () => {
    const legacy = { legal_name: "Old Client", has_allergies: "no" };
    seed({ status: "submitted", responses: legacy, submitted_at: "2026-01-01T00:00:00.000Z" });
    const res = await submitIntakeAction({ token: "good", responses: completeAnswers() });
    expect(res).toEqual({ ok: true });
    // Untouched: no acknowledgement injected, no answers changed, no
    // retroactive corruption of a record the client already signed off.
    expect(storedResponses()).toEqual(legacy);
    expect(storedResponses()[CANON.id]).toBeUndefined();
    expect(row().submitted_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a reviewed intake is likewise untouched", async () => {
    const legacy = { legal_name: "Reviewed Client" };
    seed({ status: "reviewed", responses: legacy });
    await submitIntakeAction({ token: "good", responses: completeAnswers() });
    expect(storedResponses()).toEqual(legacy);
  });

  it("a legacy draft can still be saved and is not bricked", async () => {
    seed({ responses: { legal_name: "Half-done" } });
    const res = await saveIntakeStepAction({
      token: "good",
      step: 3,
      responses: { preferred_name: "Sam" },
    });
    expect(res).toEqual({ ok: true });
    expect(storedResponses().legal_name).toBe("Half-done");
    expect(storedResponses().preferred_name).toBe("Sam");
    // No acknowledgement is invented for a client who has not seen it.
    expect(storedResponses()[CANON.id]).toBeUndefined();
  });
});

describe("draft save — serialization, restoration, and no forged wording", () => {
  it("persists the acknowledgement so a resumed draft restores it", async () => {
    await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: {
        [CANON.questionKey]: true,
        [CANON.id]: buildElectrolysisAcknowledgementClaim(true),
      },
    });
    expect(storedResponses()[CANON.questionKey]).toBe(true);
    expect(storedAck().accepted).toBe(true);
    expect(storedAck().wording).toBe(CANON.wording);
    // A draft is not an acceptance: no timestamp until submit.
    expect(storedAck().accepted_at).toBeUndefined();
  });

  it("a draft save NEVER persists client-supplied wording, id or version", async () => {
    await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: {
        [CANON.questionKey]: true,
        [CANON.id]: {
          id: "totally_different",
          version: "v99",
          wording: "I agree to unlimited charges and waive all rights.",
          accepted: true,
        },
      },
    });
    expect(storedAck().id).toBe(CANON.id);
    expect(storedAck().version).toBe(CANON.version);
    expect(storedAck().wording).toBe(CANON.wording);
  });

  it("unticking overwrites the stored acceptance rather than leaving it stale", async () => {
    await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: {
        [CANON.questionKey]: true,
        [CANON.id]: buildElectrolysisAcknowledgementClaim(true),
      },
    });
    expect(storedAck().accepted).toBe(true);
    await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: {
        [CANON.questionKey]: false,
        [CANON.id]: buildElectrolysisAcknowledgementClaim(false),
      },
    });
    expect(storedAck().accepted).toBe(false);
    // And that stale-free state genuinely blocks submission.
    const res = await submitIntakeAction({
      token: "good",
      responses: { ...completeAnswers(), [CANON.questionKey]: false, [CANON.id]: buildElectrolysisAcknowledgementClaim(false) },
    });
    expect(res.ok).toBe(false);
    expect(row().status).toBe("in_progress");
  });

  it("changing an unrelated answer does not clear the acknowledgement", async () => {
    await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: {
        [CANON.questionKey]: true,
        [CANON.id]: buildElectrolysisAcknowledgementClaim(true),
      },
    });
    await saveIntakeStepAction({
      token: "good",
      step: 2,
      responses: { outcome_hoped: "Clear upper lip" },
    });
    expect(storedResponses()[CANON.questionKey]).toBe(true);
    expect(storedAck().accepted).toBe(true);
    expect(storedResponses().outcome_hoped).toBe("Clear upper lip");
  });

  it("a draft save is never refused for an unticked acknowledgement", async () => {
    const res = await saveIntakeStepAction({
      token: "good",
      step: 5,
      responses: { [CANON.questionKey]: false, legal_name: "Partial" },
    });
    expect(res).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

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
    expect(read(QUESTIONS)).toMatch(/label: ELECTROLYSIS_ACKNOWLEDGEMENT\.wording/);
    expect(read(QUESTIONS)).toMatch(/helpText: ELECTROLYSIS_ACKNOWLEDGEMENT\.helpText/);
    expect(read(REVIEW)).toMatch(/readElectrolysisAcknowledgement/);
    // The card renders the STORED snapshot, not the current constant.
    expect(codeOnly(read(REVIEW))).toMatch(/\{view\.wording\}/);
  });
});

describe("13. no typed signature anywhere in this feature", () => {
  for (const rel of [MODULE, ACTIONS, WIZARD, REVIEW]) {
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

describe("14. nothing auto-checks the acknowledgement", () => {
  const code = codeOnly(read(WIZARD));

  it("the checkbox is checked only when the stored answer is exactly true", () => {
    expect(code).toMatch(/const checked = value === true;/);
    expect(code).not.toMatch(/defaultChecked/);
    expect(code).not.toMatch(/checked=\{true\}/);
  });

  it("the claim mirrors the answer and is never hard-coded to accepted", () => {
    expect(code).toMatch(
      /buildElectrolysisAcknowledgementClaim\(answer === true\)/,
    );
    expect(code).not.toMatch(/buildElectrolysisAcknowledgementClaim\(true\)/);
  });

  it("no record is attached before the client has touched the checkbox", () => {
    expect(code).toMatch(/if \(answer === undefined\) return responses;/);
  });

  it("the wizard keeps validate-on-continue and does not gate on a disabled button", () => {
    // The server must not be able to rely on a disabled submit button, and
    // the wizard deliberately validates on click instead of disabling.
    expect(code).toMatch(/disabled=\{isPending\}/);
    expect(code).not.toMatch(/disabled=\{[^}]*acknowledg/i);
  });
});

describe("server enforcement is independent and correctly placed", () => {
  const src = read(ACTIONS);
  const submitBody = (() => {
    const start = src.indexOf("export async function submitIntakeAction");
    const end = src.indexOf("\nasync function syncIntakeToClient", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  it("validates the acknowledgement inside the submit action", () => {
    expect(submitBody).toMatch(/validateElectrolysisAcknowledgement\(/);
  });

  it("validates AFTER the already-submitted early return", () => {
    const earlyReturn = submitBody.indexOf('existing.status === "submitted"');
    const validate = submitBody.indexOf("validateElectrolysisAcknowledgement(");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(earlyReturn);
  });

  it("validates BEFORE the row is updated, so a rejection writes nothing", () => {
    const validate = submitBody.indexOf("validateElectrolysisAcknowledgement(");
    const update = submitBody.indexOf('status: "submitted"');
    expect(update).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(update);
  });

  it("keeps the atomic in_progress guard on the update", () => {
    expect(submitBody).toMatch(/\.eq\("status", "in_progress"\)/);
  });

  it("stores the SERVER-built record, not the client's claim", () => {
    expect(submitBody).toMatch(
      /merged\[ELECTROLYSIS_ACKNOWLEDGEMENT\.id\] = ack\.record;/,
    );
  });

  it("15. returns no raw database message from any acknowledgement path", () => {
    const code = codeOnly(src);
    expect(code).not.toMatch(/error: [a-zA-Z]*[eE]rr\.message/);
    expect(code).not.toMatch(/error: JSON\.stringify/);
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

  it("the acknowledgement is stored inside the existing responses jsonb", () => {
    // Both write paths put the record into the `responses` map that
    // migration 0015 already provides; no column, table or type is added.
    const src = read(ACTIONS);
    expect(src).toMatch(/merged\[ELECTROLYSIS_ACKNOWLEDGEMENT\.id\]/);
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
