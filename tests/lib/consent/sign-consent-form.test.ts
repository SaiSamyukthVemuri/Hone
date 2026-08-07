import { beforeEach, describe, expect, it } from "vitest";
import {
  recordConsentSignature,
  STALE_CONSENT_FORM_MESSAGE,
} from "@/lib/consent/sign-consent-form";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";

// Direct tests of the shared signing core.
//
// The portal wrapper is covered behaviourally by
// tests/app/portal/consent-stale-form-integrity.test.ts. This file exercises
// the core on its own, because it has one capability NO shipped caller uses
// yet: `allowedFormTypes`.
//
// That knob exists for the future intake surface, which must never be able to
// sign a card_authorization template through a forged template id. The
// four-clause lookup is deliberately form_type-AGNOSTIC (the portal signs
// every live type through one ceremony), so the narrowing has to live in the
// core. Testing it here means the control is proven BEFORE the caller that
// depends on it exists — a UI-level filter would not be a control at all,
// since template_id comes from the browser.

type Row = Record<string, unknown>;

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

const TITLE = "Card on file authorization";
const BODY = "The studio's own card authorization text.";

const db: {
  clients: Row[];
  consent_form_templates: Row[];
  client_consent_signatures: Row[];
} = { clients: [], consent_form_templates: [], client_consent_signatures: [] };

function makeBuilder(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: "select" | "insert" = "select";
  let inserted: Row | null = null;

  function run() {
    if (op === "insert") {
      const row = { id: `sig-${db[table].length + 1}`, ...inserted };
      db[table].push(row);
      return { data: [row], error: null };
    }
    return {
      data: db[table].filter((r) => filters.every((f) => f(r))),
      error: null,
    };
  }

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (p: Row) => {
      op = "insert";
      inserted = p;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return builder;
    },
    maybeSingle: () => {
      const res = run();
      const rows = (res.data ?? []) as Row[];
      return Promise.resolve({ data: rows[0] ?? null, error: res.error });
    },
    single: () => {
      const res = run();
      const rows = (res.data ?? []) as Row[];
      return Promise.resolve({ data: rows[0] ?? null, error: res.error });
    },
    then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onF, onR),
  };
  return builder;
}

// The core takes the real SupabaseClient type so a drift in the query shape
// is a compile error in production code. The fake implements only the narrow
// chain the ceremony actually uses, so it is cast at the boundary -- the cast
// lives here, in the test, and never in shipped code.
const admin = {
  from: (t: string) => makeBuilder(t as keyof typeof db),
} as unknown as Parameters<typeof recordConsentSignature>[0]["admin"];

function seed(formType: string) {
  db.consent_form_templates.push({
    id: TEMPLATE_ID,
    studio_id: STUDIO_ID,
    title: TITLE,
    body: BODY,
    version: 1,
    status: "active",
    is_live: true,
    form_type: formType,
  });
}

const goodHash = () =>
  buildConsentTemplateSnapshot({ title: TITLE, body: BODY, version: 1 })
    .templateHash;

function call(over: Record<string, unknown> = {}) {
  // `interaction` is merged field-by-field and deliberately pulled OUT of the
  // top-level spread: spreading it twice would silently replace the whole
  // object with the partial override and quietly change what each case tests.
  const { interaction: interactionOver, ...rest } = over;
  return recordConsentSignature({
    admin,
    identity: { studioId: STUDIO_ID, clientId: CLIENT_ID },
    ipHash: null,
    userAgentHash: null,
    ...(rest as object),
    interaction: {
      templateId: TEMPLATE_ID,
      typedName: "Jane Client",
      agreed: true,
      response: null,
      renderedTemplateHash: goodHash(),
      renderedFormType: db.consent_form_templates[0]?.form_type ?? "treatment_consent",
      ...(interactionOver as object),
    },
  } as Parameters<typeof recordConsentSignature>[0]);
}

beforeEach(() => {
  db.clients = [{ id: CLIENT_ID, studio_id: STUDIO_ID, archived_at: null }];
  db.consent_form_templates = [];
  db.client_consent_signatures = [];
});

describe("allowedFormTypes: omitted preserves the portal's behaviour", () => {
  it("signs a card_authorization template when unrestricted", async () => {
    seed("card_authorization");
    const res = await call();
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.formType).toBe("card_authorization");
    expect(db.client_consent_signatures).toHaveLength(1);
  });

  it("signs a treatment_consent template when unrestricted", async () => {
    seed("treatment_consent");
    const res = await call();
    expect(res.ok).toBe(true);
    expect(db.client_consent_signatures).toHaveLength(1);
  });
});

describe("allowedFormTypes: a restricted caller cannot reach other types", () => {
  const INTAKE_SCOPE = ["treatment_consent", "photo_consent"] as const;

  it("REJECTS a live card_authorization template for a restricted caller", async () => {
    seed("card_authorization");
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("form_type_not_allowed");
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS a 'general' template for a restricted caller", async () => {
    seed("general");
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS a 'policy_acknowledgement' template for a restricted caller", async () => {
    seed("policy_acknowledgement");
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("ALLOWS an in-scope treatment_consent template", async () => {
    seed("treatment_consent");
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(true);
    expect(db.client_consent_signatures).toHaveLength(1);
  });

  it("gives the restricted caller the same opaque refusal as a missing template", async () => {
    // A distinguishable error would tell a prober which form types a studio
    // has live. Both paths return the same generic string.
    seed("card_authorization");
    const restricted = await call({ allowedFormTypes: INTAKE_SCOPE });
    db.consent_form_templates = [];
    const missing = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(restricted.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(restricted.ok === false && restricted.error).toBe(
      missing.ok === false && missing.error,
    );
  });

  it("narrows AFTER the studio-scoped lookup, never instead of it", async () => {
    // An in-scope form type in ANOTHER studio must still be refused.
    seed("treatment_consent");
    db.consent_form_templates[0].studio_id = "99999999-9999-4999-8999-999999999999";
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("template_unavailable");
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("does not let a restricted caller bypass the stale check", async () => {
    seed("treatment_consent");
    db.consent_form_templates[0].version = 2;
    const res = await call({ allowedFormTypes: INTAKE_SCOPE });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("stale_template");
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});

describe("the core returns typed reasons the caller can branch on", () => {
  it("stale_template carries the approved product copy", async () => {
    seed("treatment_consent");
    db.consent_form_templates[0].body = "Rewritten.";
    const res = await call();
    expect(res.ok === false && res.reason).toBe("stale_template");
    expect(res.ok === false && res.error).toBe(STALE_CONSENT_FORM_MESSAGE);
  });

  it("a missing comparand is treated as stale, not as a shape error", async () => {
    seed("treatment_consent");
    const res = await call({ interaction: { renderedTemplateHash: "" } });
    expect(res.ok === false && res.reason).toBe("missing_rendered_hash");
    expect(res.ok === false && res.error).toBe(STALE_CONSENT_FORM_MESSAGE);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("reports the resolved template version on success", async () => {
    seed("treatment_consent");
    const res = await call();
    expect(res.ok === true && res.templateVersion).toBe(1);
  });
});
