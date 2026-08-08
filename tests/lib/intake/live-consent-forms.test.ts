import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Live consent forms inside the intake — behavioural proof.
//
// The real resolution/validation module runs against an in-memory fake of
// consent_form_templates. A test that says "blocked" is asserting the gate
// returned ok:false and produced no record; a test that says "completed" is
// asserting the stored record's snapshot came from the DATABASE ROW.
//
// The load-bearing product distinction under test throughout: a photo consent
// DENIAL is a completed answer, not a failure. It must never block a submit.

type Row = Record<string, unknown>;

const state: { templates: Row[]; failWith: { code?: string; message: string } | null } = {
  templates: [],
  failWith: null,
};

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));

function makeFakeAdmin() {
  return {
    from(table: string) {
      if (table !== "consent_form_templates") {
        throw new Error(`unexpected table ${table}`);
      }
      const predicates: Array<(r: Row) => boolean> = [];
      const api = {
        select: () => api,
        eq(col: string, val: unknown) {
          predicates.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          predicates.push((r) => vals.includes(r[col]));
          return api;
        },
        order() {
          return api;
        },
        then(resolve: (v: { data: Row[] | null; error: unknown }) => void) {
          if (state.failWith) {
            const err = state.failWith;
            state.failWith = null;
            return Promise.resolve({ data: null, error: err }).then(resolve as never);
          }
          const matched = state.templates.filter((r) =>
            predicates.every((p) => p(r)),
          );
          return Promise.resolve({ data: matched, error: null }).then(
            resolve as never,
          );
        },
      };
      return api;
    },
  };
}

import {
  buildIntakeConsentDraftRecord,
  getIntakeConsentFormsForRender,
  INTAKE_CONSENT_STALE_MESSAGE,
  validateIntakeConsentResponses,
} from "@/lib/intake/consent-gate";
import {
  INTAKE_CONSENT_RESPONSES,
  intakeConsentResponseLabel,
  normalizeIntakeConsentClaims,
  readIntakeConsentResponses,
} from "@/lib/intake/consent-forms";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";
import {
  PHOTO_CONSENT_ACCEPT_LABEL,
  PHOTO_CONSENT_DENY_LABEL,
} from "@/lib/consent/sign-consent-form";
import { isClientOwnedResponseKey } from "@/lib/intake/questions";

const STUDIO = "studio-1";
const OTHER_STUDIO = "studio-2";
const TREATMENT = "tpl-treatment";
const PHOTO = "tpl-photo";
const AT = "2026-08-08T10:00:00.000Z";

function template(over: Partial<Row> = {}): Row {
  return {
    id: TREATMENT,
    studio_id: STUDIO,
    title: "Treatment Consent",
    description: null,
    body: "The studio's own treatment consent text.",
    form_type: "treatment_consent",
    version: 1,
    is_live: true,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function photoTemplate(over: Partial<Row> = {}): Row {
  return template({
    id: PHOTO,
    title: "Photo Consent",
    body: "The studio's own photo consent text.",
    form_type: "photo_consent",
    version: 2,
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

// Build the responses map a browser would send.
function claims(
  entries: Array<{ row: Row; response: "accepted" | "denied"; hash?: string }>,
): Record<string, unknown> {
  return {
    [INTAKE_CONSENT_RESPONSES.id]: {
      version: 1,
      forms: entries.map((e) => ({
        template_id: e.row.id,
        form_type: e.row.form_type,
        rendered_template_hash: e.hash ?? hashOf(e.row),
        response: e.response,
      })),
    },
  };
}

async function gate(responses: Record<string, unknown>, studioId = STUDIO) {
  return validateIntakeConsentResponses({
    studioId,
    responses,
    respondedAtIso: AT,
  });
}

beforeEach(() => {
  state.templates = [];
  state.failWith = null;
  createAdminClient.mockReset();
  createAdminClient.mockImplementation(() => makeFakeAdmin());
});

// ---------------------------------------------------------------------------
describe("1. which forms appear", () => {
  it("surfaces only the studio's live+active treatment and photo forms", async () => {
    state.templates = [template(), photoTemplate()];
    const forms = await getIntakeConsentFormsForRender(STUDIO);
    expect(forms.map((f) => f.formType).sort()).toEqual([
      "photo_consent",
      "treatment_consent",
    ]);
    // The text is the STUDIO'S, passed through verbatim.
    expect(forms.find((f) => f.formType === "treatment_consent")!.body).toBe(
      "The studio's own treatment consent text.",
    );
  });

  for (const [label, over] of [
    ["not live", { is_live: false }],
    ["draft status", { status: "draft" }],
    ["archived status", { status: "archived" }],
  ] as const) {
    it(`never surfaces a ${label} form`, async () => {
      state.templates = [template(over as Partial<Row>)];
      expect(await getIntakeConsentFormsForRender(STUDIO)).toEqual([]);
    });
  }

  for (const formType of [
    "card_authorization",
    "general",
    "policy_acknowledgement",
  ]) {
    it(`never surfaces a ${formType} form`, async () => {
      state.templates = [template({ id: `x-${formType}`, form_type: formType })];
      expect(await getIntakeConsentFormsForRender(STUDIO)).toEqual([]);
    });
  }

  it("never surfaces another studio's form", async () => {
    state.templates = [template({ studio_id: OTHER_STUDIO })];
    expect(await getIntakeConsentFormsForRender(STUDIO)).toEqual([]);
  });

  it("supports more than one live form of each type", async () => {
    state.templates = [
      template(),
      template({ id: "t2", created_at: "2026-01-03T00:00:00.000Z" }),
      photoTemplate(),
    ];
    const forms = await getIntakeConsentFormsForRender(STUDIO);
    expect(forms).toHaveLength(3);
  });

  it("attaches the canonical hash of the exact rendered text", async () => {
    state.templates = [template()];
    const [form] = await getIntakeConsentFormsForRender(STUDIO);
    expect(form.renderedTemplateHash).toBe(hashOf(template()));
  });
});

// ---------------------------------------------------------------------------
describe("2. treatment consent", () => {
  beforeEach(() => {
    state.templates = [template()];
  });

  it("an absent response blocks submission", async () => {
    const res = await gate({});
    expect(res.ok).toBe(false);
  });

  it("a 'denied' treatment response blocks submission", async () => {
    // A treatment consent has no valid denial: not agreeing means not
    // completing. This is the asymmetry with photo consent.
    const res = await gate(claims([{ row: template(), response: "denied" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("treatment_not_accepted");
  });

  it("an explicit acceptance completes it", async () => {
    const res = await gate(claims([{ row: template(), response: "accepted" }]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms).toHaveLength(1);
    expect(res.record!.forms[0].response).toBe("accepted");
    expect(res.record!.forms[0].response_label_snapshot).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("3. photo consent — Deny is a completed answer", () => {
  beforeEach(() => {
    state.templates = [photoTemplate()];
  });

  it("an unanswered photo form blocks submission", async () => {
    const res = await gate({});
    expect(res.ok).toBe(false);
  });

  it("Accept completes it", async () => {
    const res = await gate(
      claims([{ row: photoTemplate(), response: "accepted" }]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms[0].response).toBe("accepted");
    expect(res.record!.forms[0].response_label_snapshot).toBe(
      PHOTO_CONSENT_ACCEPT_LABEL,
    );
  });

  it("DENY ALSO completes it and does NOT block submission", async () => {
    // THE load-bearing requirement: the client must ANSWER the photo
    // question, not agree to it.
    const res = await gate(
      claims([{ row: photoTemplate(), response: "denied" }]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms[0].response).toBe("denied");
    expect(res.record!.forms[0].response_label_snapshot).toBe(
      PHOTO_CONSENT_DENY_LABEL,
    );
  });

  it("a denied photo form does not block an accepted treatment form", async () => {
    state.templates = [template(), photoTemplate()];
    const res = await gate(
      claims([
        { row: template(), response: "accepted" },
        { row: photoTemplate(), response: "denied" },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms.map((f) => f.response)).toEqual([
      "accepted",
      "denied",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("4. stale templates fail closed", () => {
  it("a hash for v1 does not satisfy a now-live v2", async () => {
    const v1 = template({ version: 1 });
    state.templates = [template({ version: 2, body: "Edited text." })];
    const res = await gate(claims([{ row: v1, response: "accepted" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("stale_template");
      expect(res.error).toBe(INTAKE_CONSENT_STALE_MESSAGE);
    }
  });

  it("an edited BODY at the same version is still stale", async () => {
    const rendered = template();
    state.templates = [template({ body: "Silently edited." })];
    const res = await gate(claims([{ row: rendered, response: "accepted" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale_template");
  });

  it("a form_type flipped between render and submit is stale", async () => {
    state.templates = [template({ form_type: "photo_consent" })];
    const res = await gate({
      [INTAKE_CONSENT_RESPONSES.id]: {
        version: 1,
        forms: [
          {
            template_id: TREATMENT,
            form_type: "treatment_consent",
            rendered_template_hash: hashOf(template({ form_type: "photo_consent" })),
            response: "accepted",
          },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("stale_template");
  });

  it("the stale message never claims anything was signed", () => {
    expect(INTAKE_CONSENT_STALE_MESSAGE).not.toMatch(/sign/i);
    expect(INTAKE_CONSENT_STALE_MESSAGE).toContain(
      "This form changed while you were reviewing it.",
    );
  });

  it("a form that went live AFTER the render is still required", async () => {
    const rendered = template();
    state.templates = [template(), photoTemplate()];
    // The browser only knows about the treatment form.
    const res = await gate(claims([{ row: rendered, response: "accepted" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_response");
  });
});

// ---------------------------------------------------------------------------
describe("5. the server owns what is stored", () => {
  it("snapshots come from the DB row, never the browser", async () => {
    state.templates = [template()];
    const res = await gate({
      [INTAKE_CONSENT_RESPONSES.id]: {
        version: 1,
        forms: [
          {
            template_id: TREATMENT,
            form_type: "treatment_consent",
            rendered_template_hash: hashOf(template()),
            response: "accepted",
            // All of these are ignored: they are not part of the claim shape.
            title_snapshot: "FORGED TITLE",
            body_snapshot: "FORGED BODY",
            template_version: 99,
            responded_at: "1999-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stored = res.record!.forms[0];
    expect(stored.title_snapshot).toBe("Treatment Consent");
    expect(stored.body_snapshot).toBe("The studio's own treatment consent text.");
    expect(stored.template_version).toBe(1);
    expect(stored.responded_at).toBe(AT);
    expect(JSON.stringify(stored)).not.toContain("FORGED");
    expect(JSON.stringify(stored)).not.toContain("1999");
  });

  it("a claim naming another studio's template id resolves nothing", async () => {
    // Studio A's live form is the authority; a claim for studio B's template
    // simply does not match any current live form, so the gate refuses.
    state.templates = [template({ studio_id: OTHER_STUDIO })];
    const res = await gate(claims([{ row: template(), response: "accepted" }]));
    // Zero live forms for THIS studio -> nothing required, nothing stored.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record).toBeNull();
  });

  it("no stored field is named like a signature", async () => {
    state.templates = [template(), photoTemplate()];
    const res = await gate(
      claims([
        { row: template(), response: "accepted" },
        { row: photoTemplate(), response: "denied" },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const json = JSON.stringify(res.record);
    expect(json).not.toMatch(/signature_name|signed_at|"signed"/);
    for (const form of res.record!.forms) {
      expect(Object.keys(form)).not.toContain("signature_name");
    }
  });

  it("a duplicate template_id cannot smuggle a second answer", () => {
    const normalized = normalizeIntakeConsentClaims({
      version: 1,
      forms: [
        {
          template_id: TREATMENT,
          form_type: "treatment_consent",
          rendered_template_hash: "h",
          response: "accepted",
        },
        {
          template_id: TREATMENT,
          form_type: "treatment_consent",
          rendered_template_hash: "h",
          response: "denied",
        },
      ],
    });
    expect(normalized!.forms).toHaveLength(1);
    expect(normalized!.forms[0].response).toBe("accepted");
  });

  it("a lookup failure refuses rather than passing", async () => {
    state.templates = [template()];
    state.failWith = { code: "42501", message: "permission denied" };
    const res = await gate(claims([{ row: template(), response: "accepted" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("lookup_failed");
      expect(res.error).not.toMatch(/permission denied|42501/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe("6. a studio with no live forms is not bricked", () => {
  it("submission passes and nothing is stored", async () => {
    state.templates = [];
    const res = await gate({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record).toBeNull();
  });

  it("card_authorization alone still counts as no live intake forms", async () => {
    state.templates = [template({ form_type: "card_authorization" })];
    const res = await gate({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("7. drafts", () => {
  it("a draft record carries no responded_at", async () => {
    state.templates = [template()];
    const rec = await buildIntakeConsentDraftRecord({
      studioId: STUDIO,
      responses: claims([{ row: template(), response: "accepted" }]),
    });
    expect(rec!.forms[0].responded_at).toBeUndefined();
    expect(rec!.forms[0].response).toBe("accepted");
  });

  it("a stale draft claim is dropped, not stored", async () => {
    state.templates = [template({ version: 2 })];
    const rec = await buildIntakeConsentDraftRecord({
      studioId: STUDIO,
      responses: claims([{ row: template({ version: 1 }), response: "accepted" }]),
    });
    expect(rec!.forms).toEqual([]);
  });

  it("a draft never stores browser-authored text", async () => {
    state.templates = [template()];
    const rec = await buildIntakeConsentDraftRecord({
      studioId: STUDIO,
      responses: {
        [INTAKE_CONSENT_RESPONSES.id]: {
          version: 1,
          forms: [
            {
              template_id: TREATMENT,
              form_type: "treatment_consent",
              rendered_template_hash: hashOf(template()),
              response: "accepted",
              body_snapshot: "FORGED",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(rec)).not.toContain("FORGED");
  });
});

// ---------------------------------------------------------------------------
describe("8. the practitioner cannot author these", () => {
  it("the consent responses key is client-owned", () => {
    expect(isClientOwnedResponseKey(INTAKE_CONSENT_RESPONSES.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("9. practitioner review reads the stored snapshot", () => {
  const stored = {
    [INTAKE_CONSENT_RESPONSES.id]: {
      version: 1,
      forms: [
        {
          template_id: TREATMENT,
          form_type: "treatment_consent",
          template_version: 3,
          title_snapshot: "Treatment Consent",
          body_snapshot: "The text the client actually read.",
          template_hash: "h1",
          response: "accepted",
          response_label_snapshot: null,
          responded_at: AT,
        },
        {
          template_id: PHOTO,
          form_type: "photo_consent",
          template_version: 2,
          title_snapshot: "Photo Consent",
          body_snapshot: "Photo text.",
          template_hash: "h2",
          response: "denied",
          response_label_snapshot: PHOTO_CONSENT_DENY_LABEL,
          responded_at: AT,
        },
      ],
    },
  };

  it("renders the HISTORICAL snapshot, not today's template", () => {
    const view = readIntakeConsentResponses(stored, "submitted");
    expect(view.state).toBe("recorded");
    if (view.state !== "recorded") return;
    expect(view.forms[0].bodySnapshot).toBe(
      "The text the client actually read.",
    );
    expect(view.forms[0].templateVersion).toBe(3);
  });

  it("labels treatment as Acknowledged and photo denial as Denied", () => {
    const view = readIntakeConsentResponses(stored, "submitted");
    if (view.state !== "recorded") throw new Error("expected recorded");
    expect(intakeConsentResponseLabel(view.forms[0])).toBe("Acknowledged");
    expect(intakeConsentResponseLabel(view.forms[1])).toBe("Denied");
  });

  it("never labels anything Signed / Approved / Cleared", () => {
    const view = readIntakeConsentResponses(stored, "submitted");
    if (view.state !== "recorded") throw new Error("expected recorded");
    for (const form of view.forms) {
      expect(intakeConsentResponseLabel(form)).not.toMatch(
        /signed|signature|approved|cleared/i,
      );
    }
  });

  it("distinguishes a draft with no record from a submitted one", () => {
    expect(readIntakeConsentResponses({}, "in_progress").state).toBe("no_record");
    expect(readIntakeConsentResponses({}, "submitted").state).toBe(
      "none_recorded",
    );
  });

  it("reports a malformed record rather than dressing it up", () => {
    expect(
      readIntakeConsentResponses(
        { [INTAKE_CONSENT_RESPONSES.id]: { version: 1, forms: "nope" } },
        "submitted",
      ).state,
    ).toBe("unreadable");
  });
});

// ---------------------------------------------------------------------------
// Source pins
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const FORMS_UI = read("app/intake/[token]/IntakeConsentForms.tsx");
const FORMS_UI_CODE = codeOnly(FORMS_UI);
const GATE_CODE = codeOnly(read("lib/intake/consent-gate.ts"));
const MODULE_CODE = codeOnly(read("lib/intake/consent-forms.ts"));

describe("10. no typed-name / signature fiction", () => {
  it("the consent UI collects no name and offers no Sign button", () => {
    expect(FORMS_UI_CODE).not.toMatch(/signature_name|signatureName|typedName/);
    expect(FORMS_UI_CODE).not.toMatch(/Sign form|>Sign</);
    expect(FORMS_UI_CODE).not.toMatch(/type="text"/);
  });

  it("nothing in this feature writes client_consent_signatures", () => {
    for (const code of [GATE_CODE, MODULE_CODE, FORMS_UI_CODE]) {
      expect(code).not.toContain("client_consent_signatures");
    }
    expect(GATE_CODE).not.toMatch(/\.insert\(/);
  });

  it("the consent UI hard-codes no consent wording — it renders form.body", () => {
    expect(FORMS_UI_CODE).toMatch(/\{form\.body\}/);
    // The only client-facing sentence is the agreement line itself.
    expect(FORMS_UI).toContain("I have read and agree to this form.");
  });

  it("the form body is never truncated or clamped", () => {
    expect(FORMS_UI_CODE).not.toMatch(/line-clamp|truncate|max-h-|slice\(0,/);
    expect(FORMS_UI_CODE).toMatch(/whitespace-pre-wrap/);
    expect(FORMS_UI_CODE).toMatch(/break-words/);
  });

  it("controls meet the touch target and labels wrap the input", () => {
    expect((FORMS_UI_CODE.match(/min-h-\[44px\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(FORMS_UI_CODE).toMatch(/<label[\s\S]{0,400}?<input/);
    expect(FORMS_UI_CODE).toMatch(/role="alert"/);
    expect(FORMS_UI_CODE).toMatch(/aria-describedby/);
  });

  it("the checkbox is never defaulted to checked", () => {
    expect(FORMS_UI_CODE).toMatch(
      /checked=\{answers\[form\.templateId\] === "accepted"\}/,
    );
    expect(FORMS_UI_CODE).not.toMatch(/defaultChecked/);
    expect(FORMS_UI_CODE).not.toMatch(/checked=\{true\}/);
  });

  it("the photo radios have no default selection", () => {
    expect(FORMS_UI_CODE).toMatch(/checked=\{answers\[form\.templateId\] === value\}/);
    expect(FORMS_UI_CODE).not.toMatch(/defaultValue/);
  });
});

describe("11. #518 and the DB step contract are untouched", () => {
  it("the electrolysis acknowledgement module is not referenced by this feature", () => {
    for (const code of [GATE_CODE, MODULE_CODE, FORMS_UI_CODE]) {
      expect(code).not.toMatch(/ELECTROLYSIS_ACKNOWLEDGEMENT|acknowledgements/);
    }
  });

  it("the wizard persists no step above TOTAL_STEPS", () => {
    const wizard = codeOnly(read("app/intake/[token]/IntakeWizard.tsx"));
    // The consent phase is local-only; every save clamps to TOTAL_STEPS.
    expect(wizard).toMatch(/const CONSENT_PHASE = TOTAL_STEPS \+ 1/);
    const saves = wizard.match(/step: Math\.min\([^)]*TOTAL_STEPS\)/g) ?? [];
    expect(saves.length).toBeGreaterThanOrEqual(2);
    expect(wizard).not.toMatch(/step: CONSENT_PHASE/);
  });

  it("no migration is required by this feature", () => {
    expect(GATE_CODE).not.toMatch(/alter table|create table|add column/i);
    expect(MODULE_CODE).not.toMatch(/alter table|create table|add column/i);
  });
});
