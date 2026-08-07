import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";

// Consent signing integrity: the stale-form race.
//
// THE BUG THIS FILE EXISTS FOR.
// The portal renders a live consent template at version N. The client reads
// that exact title/body, types their name, and submits. Between render and
// submit the studio edits the template: updateConsentTemplateAction
// (app/(app)/settings/consent/actions.ts) rewrites title/body and bumps
// version to N+1 while touching NEITHER `status` NOR `is_live` — so the row
// stays active + live and the signing action's four-clause lookup still
// resolves it. The action then snapshots the CURRENT row.
//
// Result before the fix: a client_consent_signatures row whose
// template_body_snapshot / template_version is text the client never saw,
// attached to the name they typed against different text. The row is
// internally self-consistent, so nothing downstream can detect it.
//
// These tests assert the CORRECTED behaviour: the browser carries back the
// hash of what it actually rendered, purely as a COMPARAND, and the server
// re-derives the canonical hash of the row it just resolved. Any difference
// writes NOTHING and returns the approved stale-form message.
//
// The oracle here is behavioural, never a source grep: every case drives the
// real action against an in-memory PostgREST fake and asserts on the rows
// that did (or did not) land in client_consent_signatures.

type Row = Record<string, unknown>;

const STUDIO_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO_ID = "99999999-9999-4999-8999-999999999999";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

const TITLE_V1 = "Treatment consent";
const BODY_V1 = "The studio's own treatment consent text, version one.";

const db: {
  clients: Row[];
  consent_form_templates: Row[];
  client_consent_signatures: Row[];
} = { clients: [], consent_form_templates: [], client_consent_signatures: [] };

// Minimal chainable PostgREST fake. Executes on await (`then`), on
// `maybeSingle()` and on `single()`. Mirrors the shape used by
// tests/app/intake/electrolysis-acknowledgement-wiring.test.ts.
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

const session: { value: { studioId: string; clientId: string } | null } = {
  value: { studioId: STUDIO_ID, clientId: CLIENT_ID },
};

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ from: (t: keyof typeof db) => makeBuilder(t) }),
}));
vi.mock("@/lib/portal/session", () => ({
  getCurrentPortalSession: async () => session.value,
}));
vi.mock("@/lib/portal/tokens", () => ({ hashFingerprint: () => null }));
vi.mock("@/lib/payment-methods/refresh-card-authorization-pointer", () => ({
  refreshActiveCardAuthorizationPointersForSignature: async () => ({
    ok: true,
  }),
}));

const { signConsentFormAction } = await import("@/app/portal/consent-actions");

// The exact product-approved refusal copy. Pinned as a literal so an edit to
// the shipped string has to be a deliberate act.
const STALE_MESSAGE =
  "This form changed while you were reviewing it. Please refresh and review the current version before signing.";

function seedTemplate(over: Row = {}) {
  db.consent_form_templates.push({
    id: TEMPLATE_ID,
    studio_id: STUDIO_ID,
    title: TITLE_V1,
    body: BODY_V1,
    version: 1,
    status: "active",
    is_live: true,
    form_type: "treatment_consent",
    ...over,
  });
}

// The hash the RENDER surface would have produced for the seeded v1 row.
function renderedHashV1(over: Partial<{ title: string; body: string; version: number }> = {}) {
  return buildConsentTemplateSnapshot({
    title: over.title ?? TITLE_V1,
    body: over.body ?? BODY_V1,
    version: over.version ?? 1,
  }).templateHash;
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function signPayload(over: Record<string, string> = {}) {
  return form({
    template_id: TEMPLATE_ID,
    signature_name: "Jane Client",
    agreed: "true",
    rendered_template_hash: renderedHashV1(),
    ...over,
  });
}

/** Simulates updateConsentTemplateAction: rewrites content, bumps version,
 *  and deliberately leaves status/is_live alone — which is what makes the
 *  race reachable at all. */
function studioEditsTemplate(patch: Row) {
  const row = db.consent_form_templates.find((r) => r.id === TEMPLATE_ID)!;
  Object.assign(row, patch);
}

beforeEach(() => {
  db.clients = [{ id: CLIENT_ID, studio_id: STUDIO_ID, archived_at: null }];
  db.consent_form_templates = [];
  db.client_consent_signatures = [];
  session.value = { studioId: STUDIO_ID, clientId: CLIENT_ID };
});

describe("1. the unchanged template still signs", () => {
  it("accepts a signature when the rendered hash matches the current row", async () => {
    seedTemplate();
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(true);
    expect(db.client_consent_signatures).toHaveLength(1);
  });

  it("stores the server-derived snapshot, not anything the browser sent", async () => {
    seedTemplate();
    await signConsentFormAction(signPayload());
    const row = db.client_consent_signatures[0];
    expect(row.template_title_snapshot).toBe(TITLE_V1);
    expect(row.template_body_snapshot).toBe(BODY_V1);
    expect(row.template_version).toBe(1);
    expect(row.template_hash).toBe(renderedHashV1());
    expect(row.studio_id).toBe(STUDIO_ID);
    expect(row.client_id).toBe(CLIENT_ID);
  });
});

describe("2. the stale-render race fails closed", () => {
  it("REJECTS when the title changed after render", async () => {
    seedTemplate();
    studioEditsTemplate({ title: "Treatment consent (revised)", version: 2 });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe(STALE_MESSAGE);
  });

  it("REJECTS when the body changed after render", async () => {
    seedTemplate();
    studioEditsTemplate({ body: "Materially different terms.", version: 2 });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe(STALE_MESSAGE);
  });

  it("REJECTS when only the version changed after render", async () => {
    seedTemplate();
    studioEditsTemplate({ version: 2 });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe(STALE_MESSAGE);
  });

  it("writes ZERO signature rows on a stale refusal", async () => {
    seedTemplate();
    studioEditsTemplate({ body: "Materially different terms.", version: 2 });
    await signConsentFormAction(signPayload());
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("leaves historical signatures untouched on a stale refusal", async () => {
    seedTemplate();
    const historical: Row = {
      id: "historical-1",
      studio_id: STUDIO_ID,
      client_id: CLIENT_ID,
      template_id: TEMPLATE_ID,
      template_title_snapshot: TITLE_V1,
      template_body_snapshot: BODY_V1,
      template_version: 1,
      template_hash: renderedHashV1(),
      signature_name: "Jane Client",
      response: "accepted",
    };
    db.client_consent_signatures.push(historical);
    const before = JSON.stringify(historical);
    studioEditsTemplate({ body: "Materially different terms.", version: 2 });
    await signConsentFormAction(signPayload());
    expect(db.client_consent_signatures).toHaveLength(1);
    expect(JSON.stringify(db.client_consent_signatures[0])).toBe(before);
  });

  it("REJECTS a forged hash that matches no version of the template", async () => {
    seedTemplate();
    const res = await signConsentFormAction(
      signPayload({ rendered_template_hash: "f".repeat(64) }),
    );
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS when the comparand is absent entirely", async () => {
    seedTemplate();
    const fd = signPayload();
    fd.delete("rendered_template_hash");
    const res = await signConsentFormAction(fd);
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});

describe("3. whitespace is canonical, not cosmetic", () => {
  it("treats a trailing-whitespace body edit as a real change", async () => {
    // buildConsentTemplateSnapshot deliberately does NOT trim: the snapshot
    // must capture exactly what the client saw. So a whitespace-only edit
    // genuinely changes the hash and must fail closed like any other edit.
    seedTemplate();
    studioEditsTemplate({ body: `${BODY_V1} ` });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe(STALE_MESSAGE);
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});

describe("4. the pre-existing four-clause lookup still governs", () => {
  it("REJECTS after the studio toggles is_live off", async () => {
    seedTemplate();
    studioEditsTemplate({ is_live: false });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS after the template moves back to draft", async () => {
    seedTemplate();
    studioEditsTemplate({ status: "draft", is_live: false });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS a cross-studio template id", async () => {
    seedTemplate({ studio_id: OTHER_STUDIO_ID });
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("REJECTS when the client row is archived", async () => {
    seedTemplate();
    db.clients[0].archived_at = "2026-01-01T00:00:00.000Z";
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});

describe("5. identity is never browser-supplied", () => {
  it("ignores studio_id / client_id posted by the browser", async () => {
    seedTemplate();
    await signConsentFormAction(
      signPayload({ studio_id: OTHER_STUDIO_ID, client_id: "attacker" }),
    );
    const row = db.client_consent_signatures[0];
    expect(row.studio_id).toBe(STUDIO_ID);
    expect(row.client_id).toBe(CLIENT_ID);
  });

  it("ignores snapshot fields posted by the browser", async () => {
    seedTemplate();
    await signConsentFormAction(
      signPayload({
        template_title_snapshot: "Forged title",
        template_body_snapshot: "Forged body",
        template_version: "99",
        template_hash: "0".repeat(64),
      }),
    );
    const row = db.client_consent_signatures[0];
    expect(row.template_title_snapshot).toBe(TITLE_V1);
    expect(row.template_body_snapshot).toBe(BODY_V1);
    expect(row.template_version).toBe(1);
    expect(row.template_hash).toBe(renderedHashV1());
  });
});

describe("6. photo consent keeps its server-owned labels", () => {
  const PHOTO_TITLE = "Photo consent";
  const PHOTO_BODY = "The studio's own photo consent text.";

  function seedPhoto() {
    db.consent_form_templates.push({
      id: TEMPLATE_ID,
      studio_id: STUDIO_ID,
      title: PHOTO_TITLE,
      body: PHOTO_BODY,
      version: 1,
      status: "active",
      is_live: true,
      form_type: "photo_consent",
    });
  }
  const photoHash = () =>
    buildConsentTemplateSnapshot({
      title: PHOTO_TITLE,
      body: PHOTO_BODY,
      version: 1,
    }).templateHash;

  it("stores the canonical ACCEPTED label", async () => {
    seedPhoto();
    const res = await signConsentFormAction(
      signPayload({ response: "accepted", rendered_template_hash: photoHash() }),
    );
    expect(res.ok).toBe(true);
    const row = db.client_consent_signatures[0];
    expect(row.response).toBe("accepted");
    expect(row.response_label_snapshot).toBe(
      "I consent to photo use as described above.",
    );
  });

  it("stores the canonical DENIED label", async () => {
    seedPhoto();
    const res = await signConsentFormAction(
      signPayload({ response: "denied", rendered_template_hash: photoHash() }),
    );
    expect(res.ok).toBe(true);
    const row = db.client_consent_signatures[0];
    expect(row.response).toBe("denied");
    expect(row.response_label_snapshot).toBe("I do not consent to photo use.");
  });

  it("never takes the label text from the browser", async () => {
    seedPhoto();
    await signConsentFormAction(
      signPayload({
        response: "denied",
        response_label_snapshot: "I consent to photo use as described above.",
        rendered_template_hash: photoHash(),
      }),
    );
    expect(db.client_consent_signatures[0].response_label_snapshot).toBe(
      "I do not consent to photo use.",
    );
  });

  it("still requires an explicit accept/deny choice", async () => {
    seedPhoto();
    const res = await signConsentFormAction(
      signPayload({ rendered_template_hash: photoHash() }),
    );
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("a stale photo template cannot flip a denial into an acceptance", async () => {
    seedPhoto();
    studioEditsTemplate({ body: "Rewritten photo terms.", version: 2 });
    const res = await signConsentFormAction(
      signPayload({ response: "denied", rendered_template_hash: photoHash() }),
    );
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});

describe("7. the pre-existing shape validations are unchanged", () => {
  it("rejects an empty typed name", async () => {
    seedTemplate();
    const res = await signConsentFormAction(signPayload({ signature_name: "  " }));
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("rejects a name over 200 characters", async () => {
    seedTemplate();
    const res = await signConsentFormAction(
      signPayload({ signature_name: "a".repeat(201) }),
    );
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("rejects an unticked agreement", async () => {
    seedTemplate();
    const res = await signConsentFormAction(signPayload({ agreed: "false" }));
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });

  it("rejects when there is no portal session", async () => {
    seedTemplate();
    session.value = null;
    const res = await signConsentFormAction(signPayload());
    expect(res.ok).toBe(false);
    expect(db.client_consent_signatures).toHaveLength(0);
  });
});
