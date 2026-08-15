import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR B (R-01 + R-18 + R-19).
//
// BEHAVIOURAL, not source-grep. The existing
// tests/lib/consent/charge-ready-card-authorization.test.ts pins the SHAPE of
// this helper by reading its text; that cannot see what the helper RETURNS when
// a read fails, which is the whole finding.
//
// The three reads in lib/consent/current-card-authorization.ts each captured
// `data` and discarded `error`, so a database failure was indistinguishable
// from a clean empty result and silently became a business fact:
//
//   template read fails    -> template null    -> "no_live_template"
//   signature read fails   -> signature null   -> "unsigned"
//   active-card read fails -> card null        -> `return base` = signed_current
//
// The third is the P1: a DATABASE FAILURE BECAME A SUCCESSFUL AUTHORIZATION.
//
// THE HARNESS MUST DISTINGUISH QUERY ERROR FROM ZERO ROWS. If a fake returned
// `data: null` for both, every assertion below would be vacuous - it would pass
// against the broken code and the fixed code alike. So responses carry `data`
// and `error` independently, and each case sets exactly one of them. The three
// reads hit three DIFFERENT tables, so statement identity is unambiguous.
//
// Filters are recorded so the mode/tenant scoping assertions inspect what the
// query actually asked for rather than trusting the chain.

type Stmt = {
  table: string;
  filters: Array<[string, unknown]>;
};

const h = vi.hoisted(() => ({
  livemode: true,
  // table -> { data, error }. Absent entry = clean zero row.
  responses: {} as Record<string, { data: unknown; error: unknown }>,
  stmts: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => h.livemode,
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const st: Stmt = { table, filters: [] };
      const q: Record<string, unknown> = {};
      const settle = () => {
        h.stmts.push({ table: st.table, filters: [...st.filters] });
        // Absent entry is a CLEAN zero-row read: data null, error null.
        return h.responses[table] ?? { data: null, error: null };
      };
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        st.filters.push([col, val]);
        return q;
      };
      q.is = (col: string, val: unknown) => {
        st.filters.push([col, val]);
        return q;
      };
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      return q;
    },
  }),
}));

const {
  getCardAuthorizationStatus,
  getChargeReadyCardAuthorizationStatus,
} = await import("@/lib/consent/current-card-authorization");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const TEMPLATE = { id: "tpl-1", version: 3 };
const SIGNATURE = {
  id: "sig-1",
  template_version: 3,
  signed_at: "2026-08-01T00:00:00.000Z",
};

const DB_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

function args() {
  return { studioId: STUDIO, clientId: CLIENT };
}

beforeEach(() => {
  h.responses = {};
  h.stmts = [];
  h.livemode = true;
});

// A read that SUCCEEDS and returns a row.
function rowFor(table: string, data: unknown) {
  h.responses[table] = { data, error: null };
}
// A read that FAILS. `data` stays null exactly as PostgREST would leave it -
// which is precisely why discarding `error` was indistinguishable from absence.
function errorFor(table: string) {
  h.responses[table] = { data: null, error: DB_ERROR };
}

describe("R-18: a live-template READ FAILURE is not 'no live template'", () => {
  it("template query error -> authorization_unverified, NOT no_live_template", async () => {
    errorFor("consent_form_templates");
    const status = await getCardAuthorizationStatus(args());
    expect(status.kind).not.toBe("no_live_template");
    expect(status.kind).toBe("authorization_unverified");
  });

  it("template clean ZERO ROW still means no_live_template", async () => {
    // No response registered = clean zero row. Unchanged semantics.
    const status = await getCardAuthorizationStatus(args());
    expect(status.kind).toBe("no_live_template");
  });
});

describe("R-19: a signature READ FAILURE is not 'unsigned'", () => {
  it("signature query error -> authorization_unverified, NOT unsigned", async () => {
    rowFor("consent_form_templates", TEMPLATE);
    errorFor("client_consent_signatures");
    const status = await getCardAuthorizationStatus(args());
    expect(status.kind).not.toBe("unsigned");
    expect(status.kind).toBe("authorization_unverified");
  });

  it("signature clean ZERO ROW still means unsigned", async () => {
    rowFor("consent_form_templates", TEMPLATE);
    const status = await getCardAuthorizationStatus(args());
    expect(status.kind).toBe("unsigned");
  });
});

describe("R-01 (P1): an active-card READ FAILURE can never pass as authorized", () => {
  beforeEach(() => {
    // Base authorization is genuinely signed_current in every case here, so the
    // only variable is what the active-card read does.
    rowFor("consent_form_templates", TEMPLATE);
    rowFor("client_consent_signatures", SIGNATURE);
  });

  it("base signed_current + card query error -> authorization_unverified, NEVER signed_current", async () => {
    errorFor("client_payment_methods");
    const status = await getChargeReadyCardAuthorizationStatus(args());
    expect(status.kind).not.toBe("signed_current");
    expect(status.kind).toBe("authorization_unverified");
  });

  it("base signed_current + clean ZERO card row keeps the legitimate no-card behaviour", async () => {
    // Deliberate existing semantics: with no active card row the base
    // signed_current passes through so an Add Card flow can verify base
    // authorization. A read ERROR must not borrow this branch.
    const status = await getChargeReadyCardAuthorizationStatus(args());
    expect(status.kind).toBe("signed_current");
  });

  it("base signed_current + matching card pointer -> signed_current unchanged", async () => {
    rowFor("client_payment_methods", {
      id: "card-1",
      card_authorization_signature_id: SIGNATURE.id,
    });
    const status = await getChargeReadyCardAuthorizationStatus(args());
    expect(status.kind).toBe("signed_current");
  });

  it("base signed_current + stale card pointer -> signed_current_but_card_pointer_stale unchanged", async () => {
    rowFor("client_payment_methods", {
      id: "card-1",
      card_authorization_signature_id: "sig-OLD",
    });
    const status = await getChargeReadyCardAuthorizationStatus(args());
    expect(status.kind).toBe("signed_current_but_card_pointer_stale");
  });
});

describe("the harness itself distinguishes failure from absence", () => {
  // Guards the assertions above from being vacuous. If these two produced the
  // same observable input, every "error ->" case would also pass against the
  // unfixed code.
  it("an errored read and a zero-row read are not the same input", () => {
    errorFor("consent_form_templates");
    const errored = h.responses["consent_form_templates"];
    const absent = h.responses["client_consent_signatures"];
    expect(errored).toEqual({ data: null, error: DB_ERROR });
    expect(absent).toBeUndefined();
    expect(errored.error).toBeTruthy();
  });
});

describe("scoping is preserved", () => {
  it("the active-card read still filters the CURRENT stripe_livemode", async () => {
    h.livemode = false;
    rowFor("consent_form_templates", TEMPLATE);
    rowFor("client_consent_signatures", SIGNATURE);
    rowFor("client_payment_methods", {
      id: "card-1",
      card_authorization_signature_id: SIGNATURE.id,
    });
    await getChargeReadyCardAuthorizationStatus(args());
    const cardStmt = h.stmts.find((s) => s.table === "client_payment_methods");
    expect(cardStmt?.filters).toContainEqual(["stripe_livemode", false]);
    expect(cardStmt?.filters).toContainEqual(["status", "active"]);
    expect(cardStmt?.filters).toContainEqual(["removed_at", null]);
  });

  it("every read stays scoped to the studio, and row reads to the client", async () => {
    rowFor("consent_form_templates", TEMPLATE);
    rowFor("client_consent_signatures", SIGNATURE);
    rowFor("client_payment_methods", {
      id: "card-1",
      card_authorization_signature_id: SIGNATURE.id,
    });
    await getChargeReadyCardAuthorizationStatus(args());
    for (const s of h.stmts) {
      expect(s.filters).toContainEqual(["studio_id", STUDIO]);
    }
    for (const table of ["client_consent_signatures", "client_payment_methods"]) {
      const stmt = h.stmts.find((s) => s.table === table);
      expect(stmt?.filters).toContainEqual(["client_id", CLIENT]);
    }
  });
});
