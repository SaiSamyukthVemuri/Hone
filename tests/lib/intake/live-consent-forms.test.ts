import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Live consent forms inside the intake, behavioural proof.
//
// The real resolution/validation module runs against an in-memory fake of
// consent_form_templates. A test that says "blocked" is asserting the gate
// returned ok:false and produced no record; a test that says "completed" is
// asserting the stored record's snapshot came from the DATABASE ROW.
//
// The load-bearing product distinction under test throughout: a photo consent
// DENIAL is a completed answer, not a failure. It must never block a submit.

type Row = Record<string, unknown>;

const state: {
  templates: Row[];
  signatures: Row[];
  failWith: { code?: string; message: string } | null;
} = { templates: [], signatures: [], failWith: null };

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));

function makeFakeAdmin() {
  return {
    from(table: string) {
      if (
        table !== "consent_form_templates" &&
        table !== "client_consent_signatures"
      ) {
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
          if (state.failWith && table === "consent_form_templates") {
            const err = state.failWith;
            state.failWith = null;
            return Promise.resolve({ data: null, error: err }).then(resolve as never);
          }
          const source =
            table === "client_consent_signatures"
              ? state.signatures
              : state.templates;
          const matched = source.filter((r) => predicates.every((p) => p(r)));
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

const CLIENT = "client-1";
const OTHER_CLIENT = "client-2";

async function gate(responses: Record<string, unknown>, studioId = STUDIO) {
  return validateIntakeConsentResponses({
    studioId,
    clientId: CLIENT,
    responses,
    respondedAtIso: AT,
  });
}

// A portal signature row, matching the CURRENT text of `row` unless overridden.
function signature(row: Row, over: Partial<Row> = {}): Row {
  return {
    studio_id: STUDIO,
    client_id: CLIENT,
    template_id: row.id,
    template_hash: hashOf(row),
    template_version: row.version,
    response: "accepted",
    signed_at: "2026-07-01T09:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  state.templates = [];
  state.signatures = [];
  state.failWith = null;
  createAdminClient.mockReset();
  createAdminClient.mockImplementation(() => makeFakeAdmin());
});

// ---------------------------------------------------------------------------
describe("1. which forms appear", () => {
  it("surfaces the studio's live+active TREATMENT form", async () => {
    state.templates = [template()];
    const forms = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(forms.map((f) => f.formType)).toEqual(["treatment_consent"]);
    // The text is the STUDIO'S, passed through verbatim.
    expect(forms[0].body).toBe("The studio's own treatment consent text.");
  });

  // Chloe, 2026-08-09: photo consent left the intake. It is NOT retired, the
  // portal still collects it, but the intake must be structurally incapable
  // of asking, and must not even ship the photo text to the browser.
  it("NEVER surfaces a live photo form, and leaks none of its text", async () => {
    state.templates = [template(), photoTemplate()];
    const forms = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(forms.map((f) => f.formType)).toEqual(["treatment_consent"]);
    // Excluded server-side: the photo title/body are absent from the payload
    // entirely, not merely hidden by the wizard.
    const payload = JSON.stringify(forms);
    expect(payload).not.toContain("photo");
    expect(payload).not.toContain(photoTemplate().body as string);
  });

  it("a studio with ONLY a live photo form has no intake consent at all", async () => {
    state.templates = [photoTemplate()];
    expect(await getIntakeConsentFormsForRender(STUDIO, CLIENT)).toEqual([]);
  });

  for (const [label, over] of [
    ["not live", { is_live: false }],
    ["draft status", { status: "draft" }],
    ["archived status", { status: "archived" }],
  ] as const) {
    it(`never surfaces a ${label} form`, async () => {
      state.templates = [template(over as Partial<Row>)];
      expect(await getIntakeConsentFormsForRender(STUDIO, CLIENT)).toEqual([]);
    });
  }

  for (const formType of [
    "card_authorization",
    "general",
    "policy_acknowledgement",
  ]) {
    it(`never surfaces a ${formType} form`, async () => {
      state.templates = [template({ id: `x-${formType}`, form_type: formType })];
      expect(await getIntakeConsentFormsForRender(STUDIO, CLIENT)).toEqual([]);
    });
  }

  it("never surfaces another studio's form", async () => {
    state.templates = [template({ studio_id: OTHER_STUDIO })];
    expect(await getIntakeConsentFormsForRender(STUDIO, CLIENT)).toEqual([]);
  });

  it("supports more than one live treatment form", async () => {
    state.templates = [
      template(),
      template({ id: "t2", created_at: "2026-01-03T00:00:00.000Z" }),
      photoTemplate(),
    ];
    const forms = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    // Both treatment forms; the photo form is not one of them.
    expect(forms).toHaveLength(2);
    expect(new Set(forms.map((f) => f.formType))).toEqual(
      new Set(["treatment_consent"]),
    );
  });

  it("attaches the canonical hash of the exact rendered text", async () => {
    state.templates = [template()];
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
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
describe("3. photo consent is NOT collected by the intake", () => {
  // Chloe, 2026-08-09: "please remove photo consent from the intake form",
  // no photographs are taken at the consultation, and asking there made
  // clients fear they would be.
  //
  // Photo consent is NOT retired. Its Accept/Deny ceremony, and the rule that
  // a DENIAL is a completed answer, live on in the client portal and are
  // proven there, tests/lib/consent/signature-status.test.ts (denied is
  // complete, needs no attention), tests/lib/consent/signed-record.test.ts
  // (a denied record is valid, not malformed) and
  // e2e/portal-consent-signing-integrity.spec.ts (a real browser Deny writing
  // response='denied'). Those assertions moved surface, not existence.

  it("a live photo form does NOT block submission", async () => {
    state.templates = [photoTemplate()];
    const res = await gate({});
    expect(res.ok).toBe(true);
    // Nothing was completed in the intake, so nothing is stored.
    if (res.ok) expect(res.record).toBeNull();
  });

  it("a live photo form does not block an accepted treatment form", async () => {
    state.templates = [template(), photoTemplate()];
    const res = await gate(claims([{ row: template(), response: "accepted" }]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms.map((f) => f.form_type)).toEqual([
      "treatment_consent",
    ]);
  });

  it("a CRAFTED photo claim is ignored, never stored", async () => {
    // The wizard cannot produce this, the form is not rendered, so reaching
    // it means a hand-built payload. The server resolves live intake forms
    // itself and simply has no photo row to match, so the claim dies there
    // rather than writing a consent answer nobody was asked for.
    state.templates = [template(), photoTemplate()];
    const res = await gate(
      claims([
        { row: template(), response: "accepted" },
        { row: photoTemplate(), response: "accepted" },
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record!.forms).toHaveLength(1);
    expect(res.record!.forms[0].form_type).toBe("treatment_consent");
    expect(JSON.stringify(res.record)).not.toContain("photo_consent");
  });

  it("a studio with ONLY a live photo form submits with nothing stored", async () => {
    state.templates = [photoTemplate()];
    const res = await gate(claims([]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record).toBeNull();
  });

  it("a photo template edited mid-intake does NOT stale the submit", async () => {
    // It is not an intake form any more, so its version cannot fail the intake
    // closed. The treatment stale rule is unchanged and proven in section 4.
    state.templates = [template(), photoTemplate({ version: 9 })];
    const res = await gate(claims([{ row: template(), response: "accepted" }]));
    expect(res.ok).toBe(true);
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
    // The comparand is unchanged by photo consent leaving the intake: the
    // browser's claimed form_type must still match the row the server
    // resolved. Asserted from the other direction now, a claim asserting
    // photo_consent against the studio's live TREATMENT row, because only one
    // type is collected, so a collected-to-collected flip is unconstructible.
    state.templates = [template()];
    const res = await gate({
      [INTAKE_CONSENT_RESPONSES.id]: {
        version: 1,
        forms: [
          {
            template_id: TREATMENT,
            form_type: "photo_consent",
            rendered_template_hash: hashOf(template()),
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
    // A SECOND treatment form went live between render and submit. (It used to
    // be a photo form; that no longer proves anything, because a photo form is
    // not an intake form and correctly cannot make a submit incomplete.)
    state.templates = [
      template(),
      template({ id: "t-late", created_at: "2026-02-01T00:00:00.000Z" }),
    ];
    // The browser only knows about the first treatment form.
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
    // The gate now READS the signing table to credit an existing portal
    // completion, so a blanket "never mentions it" assertion would be wrong.
    // The contract is narrower and stronger: the isomorphic module and the
    // client component must not touch it at all, and the gate may only SELECT.
    // The write prohibition itself is pinned in section 15.
    for (const code of [MODULE_CODE, FORMS_UI_CODE]) {
      expect(code).not.toContain("client_consent_signatures");
    }
    expect(GATE_CODE).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  });

  it("the consent UI hard-codes no consent wording, it renders form.body", () => {
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

// ---------------------------------------------------------------------------
// EXISTING PORTAL COMPLETIONS
//
// A client who already completed the EXACT CURRENT form through the portal must
// not be asked for the identical answer again inside intake. The matching rule
// is the stored template_hash, which covers title + body + version, strictly
// tighter than a version comparison, so an edit at the same version also
// invalidates the old completion.
//
// READ-ONLY throughout: the intake never writes, alters or copies a signature.
// ---------------------------------------------------------------------------
describe("12. a current portal completion satisfies the intake form", () => {
  it("current portal TREATMENT acceptance satisfies it, no intake answer needed", async () => {
    state.templates = [template()];
    state.signatures = [signature(template())];
    const res = await gate({});
    expect(res.ok).toBe(true);
    // Nothing was completed during the intake, so nothing is recorded here.
    if (res.ok) expect(res.record).toBeNull();
  });

  it("current portal PHOTO acceptance satisfies it", async () => {
    state.templates = [photoTemplate()];
    state.signatures = [signature(photoTemplate(), { response: "accepted" })];
    const res = await gate({});
    expect(res.ok).toBe(true);
  });

  it("current portal photo DENY satisfies it, and never blocks the intake", async () => {
    state.templates = [photoTemplate()];
    state.signatures = [signature(photoTemplate(), { response: "denied" })];
    const res = await gate({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record).toBeNull();
  });

  it("a portal completion is surfaced with its stored response, verbatim", async () => {
    // Was asserted with a photo DENY. Photo forms no longer render in the
    // intake at all, so the intake render can no longer prove anything about
    // them, that property moved to the practitioner review (which shows
    // "Consent denied" from the portal signature) and to the portal's own
    // tests. What remains provable HERE is the general rule the photo case was
    // an instance of: a portal completion is passed through as-is.
    state.templates = [template()];
    state.signatures = [signature(template(), { response: "accepted" })];
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(form.portalCompletion).toMatchObject({ response: "accepted" });
  });

  it("a portal completion is NOT copied into the intake record", async () => {
    // Two live treatment forms: one already completed in the portal, the other
    // answered here. (Previously the intake-answered one was a photo form.)
    const second = template({ id: "t2", created_at: "2026-01-03T00:00:00.000Z" });
    state.templates = [template(), second];
    state.signatures = [signature(template())];
    const res = await gate(claims([{ row: second, response: "accepted" }]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Exactly ONE stored form: the intake one. The portal signature stays the
    // portal's evidence and is not converted into an intake response.
    expect(res.record!.forms).toHaveLength(1);
    expect(res.record!.forms[0].template_id).toBe("t2");
    expect(res.record!.forms.some((f) => f.template_id === TREATMENT)).toBe(
      false,
    );
  });

  it("mixed: portal treatment + intake treatment submits", async () => {
    const second = template({ id: "t2", created_at: "2026-01-03T00:00:00.000Z" });
    state.templates = [template(), second];
    state.signatures = [signature(template())];
    const res = await gate(claims([{ row: second, response: "accepted" }]));
    expect(res.ok).toBe(true);
  });

  it("mixed: portal treatment + intake photo submits", async () => {
    state.templates = [template(), photoTemplate()];
    state.signatures = [signature(template())];
    const res = await gate(
      claims([{ row: photoTemplate(), response: "accepted" }]),
    );
    expect(res.ok).toBe(true);
  });
});

describe("13. only the CURRENT version counts", () => {
  it("an OLD treatment signature does not satisfy a newly live version", async () => {
    const v1 = template({ version: 1 });
    state.templates = [template({ version: 2, body: "Revised v2 text." })];
    state.signatures = [signature(v1)]; // hash of v1
    const res = await gate({});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_response");
  });

  // (The photo-form variant of the rule above is gone: a photo form is no
  // longer an intake form, so no photo signature, current or stale, can make
  // an intake submit incomplete. The current-version rule itself is unchanged
  // and proven by the treatment case directly above; the portal enforces its
  // own version rule in tests/lib/consent/signature-status.test.ts.)

  it("an edited body at the SAME version also invalidates the completion", async () => {
    // A version comparison would miss this; the hash does not.
    const original = template();
    state.templates = [template({ body: "Silently edited, same version." })];
    state.signatures = [signature(original)];
    const res = await gate({});
    expect(res.ok).toBe(false);
  });

  it("an outdated completion still renders an INTERACTIVE control", async () => {
    const v1 = template({ version: 1 });
    state.templates = [template({ version: 2, body: "Revised v2 text." })];
    state.signatures = [signature(v1)];
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(form.portalCompletion).toBeNull();
  });

  it("the existing stale-template behaviour is unchanged by all this", async () => {
    // No portal signature at all; a stale intake claim still fails closed.
    state.templates = [template({ version: 2, body: "Edited." })];
    const res = await gate(
      claims([{ row: template({ version: 1 }), response: "accepted" }]),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("stale_template");
      expect(res.error).toBe(INTAKE_CONSENT_STALE_MESSAGE);
    }
  });
});

describe("14. portal completions cannot be borrowed", () => {
  it("no portal completion still requires an intake answer", async () => {
    state.templates = [template()];
    state.signatures = [];
    const res = await gate({});
    expect(res.ok).toBe(false);
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(form.portalCompletion).toBeNull();
  });

  it("ANOTHER CLIENT's signature does not satisfy this client's form", async () => {
    state.templates = [template()];
    state.signatures = [signature(template(), { client_id: OTHER_CLIENT })];
    const res = await gate({});
    expect(res.ok).toBe(false);
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    expect(form.portalCompletion).toBeNull();
  });

  it("ANOTHER STUDIO's signature does not satisfy this form", async () => {
    state.templates = [template()];
    state.signatures = [signature(template(), { studio_id: OTHER_STUDIO })];
    const res = await gate({});
    expect(res.ok).toBe(false);
  });

  it("a 'denied' TREATMENT signature does not complete a treatment form", async () => {
    state.templates = [template()];
    state.signatures = [signature(template(), { response: "denied" })];
    const res = await gate({});
    expect(res.ok).toBe(false);
  });

  it("the newest matching signature wins when several exist", async () => {
    // Same rule, asserted on the treatment form now that photo forms do not
    // render in the intake. Two signatures of the SAME live template: the
    // newest is the one surfaced.
    state.templates = [template()];
    state.signatures = [
      signature(template(), {
        response: "accepted",
        signed_at: "2026-07-05T09:00:00.000Z",
      }),
      signature(template(), {
        response: "accepted",
        signed_at: "2026-07-01T09:00:00.000Z",
      }),
    ];
    const [form] = await getIntakeConsentFormsForRender(STUDIO, CLIENT);
    // The fake returns rows in array order, mirroring `order signed_at desc`.
    expect(form.portalCompletion).toMatchObject({
      signedAtIso: "2026-07-05T09:00:00.000Z",
    });
  });
});

describe("15. the intake never writes to the signing system", () => {
  it("the gate module performs no signature INSERT / UPDATE / DELETE", () => {
    const code = codeOnly(read("lib/intake/consent-gate.ts"));
    // It reads the table...
    expect(code).toContain('.from("client_consent_signatures")');
    // ...and only ever selects from it.
    const sigSlice = code.slice(code.indexOf('.from("client_consent_signatures")'));
    const nextFrom = sigSlice.indexOf(".from(", 10);
    const scoped = nextFrom > -1 ? sigSlice.slice(0, nextFrom) : sigSlice;
    expect(scoped).toContain(".select(");
    expect(scoped).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    // And no typed name is ever produced.
    expect(code).not.toMatch(/signature_name\s*:/);
  });

  it("both signature queries are scoped to studio AND client", () => {
    const code = codeOnly(read("lib/intake/consent-gate.ts"));
    expect(code).toMatch(/\.eq\("studio_id", input\.studioId\)/);
    expect(code).toMatch(/\.eq\("client_id", input\.clientId\)/);
  });
});

describe("16. an empty consent record is not 'unreadable'", () => {
  // Found by the portal-precompletion browser journey. A draft save posts an
  // empty claim set when every live form is already completed in the portal,
  // so `{version:1, forms:[]}` can legitimately reach the row. Reporting that
  // as "unreadable" told the practitioner it "could not be read" and to treat
  // the forms as not completed, both false.
  const empty = { [INTAKE_CONSENT_RESPONSES.id]: { version: 1, forms: [] } };

  it("reads as none_recorded on a submitted intake", () => {
    expect(readIntakeConsentResponses(empty, "submitted").state).toBe(
      "none_recorded",
    );
  });

  it("reads as no_record on a draft", () => {
    expect(readIntakeConsentResponses(empty, "in_progress").state).toBe(
      "no_record",
    );
  });

  it("entries that are present but all malformed ARE unreadable", () => {
    const malformed = {
      [INTAKE_CONSENT_RESPONSES.id]: { version: 1, forms: [{ nope: true }] },
    };
    expect(readIntakeConsentResponses(malformed, "submitted").state).toBe(
      "unreadable",
    );
  });
});
