import { beforeEach, describe, expect, it, vi } from "vitest";

// THE SERVER-SIDE FINAL SUBMIT GATE, driven through the real
// submitIntakeAction — not through the gate helper in isolation.
//
// WHY THIS FILE EXISTS. tests/lib/intake/live-consent-forms.test.ts proves
// validateIntakeConsentResponses refuses the right things. That is NOT the
// same as proving the submit action calls it and honours the refusal: a
// negative control that changed the action to
//
//     if (consent.ok && consent.record) { ...store... }
//
// — i.e. dropped the `if (!consent.ok) return` — left every test in that file
// green while a client with no consent response could submit. This file closes
// that gap. The oracle is the STORED ROW: "blocked" means status is still
// in_progress and the row did not move.
//
// Nothing here depends on the disabled Submit button, on client-side React
// state, or on a hidden input. The browser is not involved at all.

type Row = Record<string, unknown>;

const INTAKE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const STUDIO_ID = "33333333-3333-4333-8333-333333333333";
const TREATMENT_ID = "44444444-4444-4444-8444-444444444444";
const PHOTO_ID = "55555555-5555-4555-8555-555555555555";

const db: {
  client_intake_forms: Row[];
  clients: Row[];
  consent_form_templates: Row[];
} = { client_intake_forms: [], clients: [], consent_form_templates: [] };

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
import { INTAKE_CONSENT_RESPONSES } from "@/lib/intake/consent-forms";
import {
  buildElectrolysisAcknowledgementClaim,
  ELECTROLYSIS_ACKNOWLEDGEMENT as CANON,
} from "@/lib/intake/acknowledgements";
import { INTAKE_STEPS } from "@/lib/intake/questions";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";

// Every required, unconditional answer plus the #518 acknowledgement, so the
// ONLY thing that can block a submit in these tests is consent.
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

function treatmentTemplate(over: Partial<Row> = {}): Row {
  return {
    id: TREATMENT_ID,
    studio_id: STUDIO_ID,
    title: "Treatment Consent",
    description: null,
    body: "Studio treatment consent text.",
    form_type: "treatment_consent",
    version: 1,
    is_live: true,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function photoTemplate(over: Partial<Row> = {}): Row {
  return treatmentTemplate({
    id: PHOTO_ID,
    title: "Photo Consent",
    body: "Studio photo consent text.",
    form_type: "photo_consent",
    created_at: "2026-01-02T00:00:00.000Z",
    ...over,
  });
}

function hashOf(row: Row): string {
  return buildConsentTemplateSnapshot({
    title: row.title as string,
    body: row.body as string,
    version: row.version as number,
  }).templateHash;
}

function consentClaim(
  entries: Array<{ row: Row; response: "accepted" | "denied" }>,
): Record<string, unknown> {
  return {
    [INTAKE_CONSENT_RESPONSES.id]: {
      version: 1,
      forms: entries.map((e) => ({
        template_id: e.row.id,
        form_type: e.row.form_type,
        rendered_template_hash: hashOf(e.row),
        response: e.response,
      })),
    },
  };
}

function currentRow(): Row {
  return db.client_intake_forms.find((r) => r.id === INTAKE_ID)!;
}

async function submit(extra: Record<string, unknown> = {}) {
  return submitIntakeAction({
    token: "good",
    responses: { ...completeAnswers(), ...extra },
  });
}

beforeEach(() => {
  db.client_intake_forms = [
    {
      id: INTAKE_ID,
      studio_id: STUDIO_ID,
      client_id: CLIENT_ID,
      status: "in_progress",
      current_step: 5,
      responses: {},
      submitted_at: null,
      deleted_at: null,
    },
  ];
  db.clients = [{ id: CLIENT_ID, studio_id: STUDIO_ID, name: "Dana" }];
  db.consent_form_templates = [];
});

// ---------------------------------------------------------------------------
describe("the server refuses a submit that skips live consent", () => {
  it("a missing treatment consent BLOCKS the submit and the row does not move", async () => {
    db.consent_form_templates = [treatmentTemplate()];
    const res = await submit();
    expect(res.ok).toBe(false);
    // THE ORACLE: the stored row genuinely did not transition.
    expect(currentRow().status).toBe("in_progress");
    expect(currentRow().submitted_at).toBeNull();
  });

  it("a treatment consent answered 'denied' also BLOCKS", async () => {
    db.consent_form_templates = [treatmentTemplate()];
    const res = await submit(
      consentClaim([{ row: treatmentTemplate(), response: "denied" }]),
    );
    expect(res.ok).toBe(false);
    expect(currentRow().status).toBe("in_progress");
  });

  it("an unanswered photo consent BLOCKS", async () => {
    db.consent_form_templates = [photoTemplate()];
    const res = await submit();
    expect(res.ok).toBe(false);
    expect(currentRow().status).toBe("in_progress");
  });

  it("a STALE rendered hash BLOCKS and stores no acknowledgement of the new text", async () => {
    // The client rendered v1; the studio published v2 before they submitted.
    db.consent_form_templates = [
      treatmentTemplate({ version: 2, body: "Revised text." }),
    ];
    const res = await submit(
      consentClaim([{ row: treatmentTemplate({ version: 1 }), response: "accepted" }]),
    );
    expect(res.ok).toBe(false);
    expect(currentRow().status).toBe("in_progress");
    // Nothing was written at all — the refusal happens above the UPDATE.
    expect(currentRow().responses).toEqual({});
  });

  it("no refusal leaks provider or template detail", async () => {
    db.consent_form_templates = [treatmentTemplate()];
    const res = await submit();
    if (res.ok) throw new Error("expected refusal");
    expect(res.error).not.toMatch(/consent_form_templates|studio_id|hash|sql/i);
  });
});

describe("the server accepts a complete submit", () => {
  it("treatment accepted + photo DENIED submits, and the denial is recorded", async () => {
    db.consent_form_templates = [treatmentTemplate(), photoTemplate()];
    const res = await submit(
      consentClaim([
        { row: treatmentTemplate(), response: "accepted" },
        { row: photoTemplate(), response: "denied" },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(currentRow().status).toBe("submitted");
    const stored = (currentRow().responses as Record<string, unknown>)[
      INTAKE_CONSENT_RESPONSES.id
    ] as { forms: Array<Record<string, unknown>> };
    expect(stored.forms).toHaveLength(2);
    expect(
      stored.forms.find((f) => f.form_type === "photo_consent")!.response,
    ).toBe("denied");
    // Server-derived snapshot, server-stamped time.
    const treatment = stored.forms.find(
      (f) => f.form_type === "treatment_consent",
    )!;
    expect(treatment.body_snapshot).toBe("Studio treatment consent text.");
    expect(typeof treatment.responded_at).toBe("string");
  });

  it("a studio with NO live forms submits exactly as before", async () => {
    db.consent_form_templates = [];
    const res = await submit();
    expect(res.ok).toBe(true);
    expect(currentRow().status).toBe("submitted");
    // Nothing consent-shaped was invented for a studio that has no forms.
    expect(
      (currentRow().responses as Record<string, unknown>)[
        INTAKE_CONSENT_RESPONSES.id
      ],
    ).toBeUndefined();
  });

  it("a card_authorization form is not required to submit", async () => {
    db.consent_form_templates = [
      treatmentTemplate({ id: "card", form_type: "card_authorization" }),
    ];
    const res = await submit();
    expect(res.ok).toBe(true);
    expect(currentRow().status).toBe("submitted");
  });

  it("another studio's live form is not required to submit", async () => {
    db.consent_form_templates = [treatmentTemplate({ studio_id: "other" })];
    const res = await submit();
    expect(res.ok).toBe(true);
    expect(currentRow().status).toBe("submitted");
  });

  it("an already-submitted intake is never re-validated against new forms", async () => {
    // A studio that publishes its first consent form must not retroactively
    // invalidate intakes submitted before it existed.
    currentRow().status = "submitted";
    db.consent_form_templates = [treatmentTemplate()];
    const res = await submit();
    expect(res.ok).toBe(true);
    // Untouched: no rewrite, no consent record grafted on.
    expect(
      (currentRow().responses as Record<string, unknown>)[
        INTAKE_CONSENT_RESPONSES.id
      ],
    ).toBeUndefined();
  });
});
