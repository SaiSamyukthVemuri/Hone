import { beforeEach, describe, expect, it, vi } from "vitest";

// getPortalPhotoConsentsForPractitionerView: BEHAVIOUR, against an in-memory
// fake of the two tables it reads.
//
// The sibling source-grep file pins that the query carries is_live and no
// limit(1). That cannot prove what the function RETURNS: that two live forms
// both survive, that each resolves its own granted/denied/outdated state, and
// that one template's signature never satisfies another's. Those are the
// properties a practitioner's consent decision actually rests on, so they are
// asserted through the real function here.

type Row = Record<string, unknown>;

const state: { templates: Row[]; signatures: Row[] } = {
  templates: [],
  signatures: [],
};

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));

// Mirrors PostgREST closely enough for these assertions: eq/in predicates
// compose, and `order` sorts so "latest per template" is genuinely exercised
// rather than being an artefact of insertion order.
function makeFakeAdmin() {
  return {
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      let sort: { col: string; asc: boolean } | null = null;
      let cap: number | null = null;
      const rows = (): Row[] => {
        const src =
          table === "consent_form_templates" ? state.templates : state.signatures;
        let out = src.filter((r) => preds.every((p) => p(r)));
        if (sort) {
          const { col, asc } = sort;
          out = [...out].sort((a, b) =>
            String(a[col]) < String(b[col])
              ? asc
                ? -1
                : 1
              : String(a[col]) > String(b[col])
                ? asc
                  ? 1
                  : -1
                : 0,
          );
        }
        return cap === null ? out : out.slice(0, cap);
      };
      const api = {
        select: () => api,
        eq(col: string, val: unknown) {
          preds.push((r) => r[col] === val);
          return api;
        },
        in(col: string, vals: unknown[]) {
          preds.push((r) => vals.includes(r[col]));
          return api;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          sort = { col, asc: opts?.ascending !== false };
          return api;
        },
        limit(n: number) {
          cap = n;
          return api;
        },
        // getPhotoConsentStateForClient (the Treatment Images helper) resolves
        // a single row rather than a list, so the fake supports both shapes.
        maybeSingle() {
          return Promise.resolve(rows()).then((r) => ({
            data: r[0] ?? null,
            error: null,
          }));
        },
        then(resolve: (v: { data: Row[] | null; error: unknown }) => void) {
          return Promise.resolve({ data: rows(), error: null }).then(
            resolve as never,
          );
        },
      };
      return api;
    },
  };
}

const STUDIO = "studio-1";
const CLIENT = "client-1";

function photoTemplate(over: Partial<Row> = {}): Row {
  return {
    id: "photo-a",
    studio_id: STUDIO,
    title: "Photo use consent",
    form_type: "photo_consent",
    version: 1,
    status: "active",
    is_live: true,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function signature(over: Partial<Row> = {}): Row {
  return {
    id: `sig-${String(over.template_id ?? "photo-a")}-${String(over.signed_at ?? "x")}`,
    studio_id: STUDIO,
    client_id: CLIENT,
    template_id: "photo-a",
    template_title_snapshot: "Photo use consent",
    template_version: 1,
    signature_name: "Dana Reyes",
    signed_at: "2026-07-01T09:00:00.000Z",
    response: "accepted",
    template_body_snapshot: "body",
    response_label_snapshot: null,
    template_hash: "hash",
    created_at: "2026-07-01T09:00:00.000Z",
    ...over,
  };
}

async function view() {
  const { getPortalPhotoConsentsForPractitionerView } = await import(
    "@/lib/consent/queries"
  );
  return getPortalPhotoConsentsForPractitionerView(STUDIO, CLIENT);
}

beforeEach(() => {
  state.templates = [];
  state.signatures = [];
  createAdminClient.mockReset();
  createAdminClient.mockImplementation(() => makeFakeAdmin());
});

describe("only forms the client can actually reach are reported", () => {
  it("a live + active form is reported", async () => {
    state.templates = [photoTemplate()];
    const rows = await view();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("not_answered");
  });

  it("an ACTIVE but NOT LIVE form is reported as nothing at all", async () => {
    // THE load-bearing case. The owner activated it and kept it hidden, so the
    // client has no way to answer. Reporting "Not completed" would send the
    // practitioner chasing an answer nobody can give.
    state.templates = [photoTemplate({ is_live: false })];
    expect(await view()).toEqual([]);
  });

  it("a live but non-active form is not reported either", async () => {
    state.templates = [photoTemplate({ status: "draft" })];
    expect(await view()).toEqual([]);
  });

  it("another studio's live form is never reported", async () => {
    state.templates = [photoTemplate({ studio_id: "other-studio" })];
    expect(await view()).toEqual([]);
  });

  it("a hidden form is excluded even when a signature for it exists", async () => {
    // A form can be signed and LATER hidden. The signature is history; the
    // form is no longer a current portal requirement, so it is not reported
    // as current status.
    state.templates = [photoTemplate({ is_live: false })];
    state.signatures = [signature({ response: "denied" })];
    expect(await view()).toEqual([]);
  });
});

describe("every live photo form survives independently", () => {
  const A = photoTemplate({ id: "photo-a", title: "Photo use consent" });
  const B = photoTemplate({
    id: "photo-b",
    title: "Treatment photography authorization",
    version: 3,
    created_at: "2026-02-01T00:00:00.000Z",
  });

  it("TWO live forms produce TWO rows, neither dropped", async () => {
    state.templates = [A, B];
    const rows = await view();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.templateId)).toEqual(["photo-a", "photo-b"]);
    // Ordered like the portal: created_at ascending.
    expect(rows.map((r) => r.templateTitle)).toEqual([
      "Photo use consent",
      "Treatment photography authorization",
    ]);
  });

  it("a higher VERSION on one template does not outrank the other", async () => {
    // Version is a template's own history, not a ranking between templates.
    // B is v3 and A is v1; both must still appear.
    state.templates = [A, B];
    expect((await view()).map((r) => r.templateId).sort()).toEqual([
      "photo-a",
      "photo-b",
    ]);
  });

  it("each form resolves its OWN response, denied and granted side by side", async () => {
    state.templates = [A, B];
    state.signatures = [
      signature({ template_id: "photo-a", response: "denied" }),
      signature({ template_id: "photo-b", response: "accepted", template_version: 3 }),
    ];
    const rows = await view();
    expect(rows.find((r) => r.templateId === "photo-a")!.state).toBe("denied");
    expect(rows.find((r) => r.templateId === "photo-b")!.state).toBe("granted");
  });

  it("one template's signature NEVER satisfies another template", async () => {
    // Only A is signed. B must read as unanswered, not borrow A's answer.
    state.templates = [A, B];
    state.signatures = [signature({ template_id: "photo-a", response: "accepted" })];
    const rows = await view();
    expect(rows.find((r) => r.templateId === "photo-a")!.state).toBe("granted");
    expect(rows.find((r) => r.templateId === "photo-b")!.state).toBe(
      "not_answered",
    );
    expect(rows.find((r) => r.templateId === "photo-b")!.record).toBeNull();
  });

  it("outdated is computed PER TEMPLATE against that template's version", async () => {
    state.templates = [A, B];
    state.signatures = [
      // A: signed at its current version -> granted.
      signature({ template_id: "photo-a", template_version: 1 }),
      // B: signed v1 while B is live at v3 -> outdated, not granted.
      signature({ template_id: "photo-b", template_version: 1 }),
    ];
    const rows = await view();
    expect(rows.find((r) => r.templateId === "photo-a")!.state).toBe("granted");
    expect(rows.find((r) => r.templateId === "photo-b")!.state).toBe("outdated");
  });

  it("the LATEST signature per template wins, and only for that template", async () => {
    state.templates = [A, B];
    state.signatures = [
      signature({
        template_id: "photo-a",
        response: "accepted",
        signed_at: "2026-07-01T09:00:00.000Z",
      }),
      signature({
        template_id: "photo-a",
        response: "denied",
        signed_at: "2026-07-09T09:00:00.000Z",
      }),
      signature({
        template_id: "photo-b",
        response: "accepted",
        template_version: 3,
        signed_at: "2026-07-02T09:00:00.000Z",
      }),
    ];
    const rows = await view();
    // A's newest answer is the denial.
    const a = rows.find((r) => r.templateId === "photo-a")!;
    expect(a.state).toBe("denied");
    expect(a.record!.signed_at).toBe("2026-07-09T09:00:00.000Z");
    // B is untouched by A's two signatures.
    expect(rows.find((r) => r.templateId === "photo-b")!.state).toBe("granted");
  });

  it("carries the full signed record so the existing viewer can open it", async () => {
    state.templates = [A];
    state.signatures = [signature({ response: "denied" })];
    const [row] = await view();
    expect(row.record).toMatchObject({
      template_body_snapshot: "body",
      template_hash: "hash",
      signature_name: "Dana Reyes",
    });
    expect(row.currentVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The Treatment Images banner reads its own helper. Now that photo consent is
// collected in the PORTAL, that helper is a portal-eligibility claim too, and
// it must not report a hidden form as an outstanding requirement.
describe("Treatment Images photo status uses the same boundary", () => {
  async function imagesState() {
    const { getPhotoConsentStateForClient } = await import(
      "@/lib/consent/queries"
    );
    return getPhotoConsentStateForClient(STUDIO, CLIENT);
  }

  it("a live form yields a real state", async () => {
    state.templates = [photoTemplate()];
    state.signatures = [signature({ response: "denied" })];
    expect(await imagesState()).toBe("denied");
  });

  it("an ACTIVE but NOT LIVE form yields null, no banner, no false chase", async () => {
    // Previously this returned "not_answered", so Treatment Images told the
    // practitioner photo consent was not completed for a form the client
    // could not open.
    state.templates = [photoTemplate({ is_live: false })];
    expect(await imagesState()).toBeNull();
  });

  it("null still means 'photo consent is not in use here'", async () => {
    state.templates = [];
    expect(await imagesState()).toBeNull();
  });
});
