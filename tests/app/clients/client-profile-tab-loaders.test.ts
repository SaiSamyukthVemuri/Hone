import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// PERF2 — BEHAVIOUR-LEVEL proof of Client Profile tab gating.
//
// This answers the only question that matters, by asking the page rather than
// by modelling it:
//
//     "When the practitioner opens tab X, which server reads actually run?"
//
// WHY THIS REPLACES THE SOURCE INTERPRETER
// ----------------------------------------
// Four generations of source-level proof were written for this behaviour and
// six review findings walked through them in turn: an identifier's presence,
// then a resolved substring, then an evaluated predicate that still could not
// see branch position, enclosing scope, or binding provenance. Each fix closed
// the demonstrated instance and left an adjacent one, because a partial
// interpreter over TypeScript is a model of the page, and the model is not the
// page.
//
// Here the real component is invoked, once per tab, against a faked loader
// boundary. Every read records its own invocation. Nesting, branch position,
// aliasing and binding provenance are answered by execution, not by analysis.
//
// The fakes return minimal values matching each loader's real contract and do
// nothing to help a tab pass; none of them inspects the tab.
// ===========================================================================

const invoked = vi.hoisted(() => ({ log: [] as string[] }));

/** A fake loader that records its own name and returns a contract-shaped value. */
const loader =
  (name: string, value: unknown) =>
  (..._args: unknown[]) => {
    invoked.log.push(name);
    return Promise.resolve(value);
  };

const STUDIO = {
  id: "studio-1",
  timezone: "America/Toronto",
  slug: "willow",
  name: "Willow Electrolysis",
};
const PRACTITIONER = {
  id: "prac-1",
  role: "owner",
  display_name: "Chloe",
  email: "chloe@example.com",
};
const SESSION = {
  id: "sess-1",
  client_id: "client-1",
  studio_id: STUDIO.id,
  started_at: "2026-08-01T10:00:00.000Z",
  modality: "electrolysis",
  price_paid_cents: null,
  performed_by: PRACTITIONER.id,
  aftercare_and_risks_explained_at: null,
  deleted_at: null,
  electrolysis_entries: [],
  laser_entries: [],
};
const CLIENT = {
  id: "client-1",
  name: "Test Client",
  email: null,
  phone: null,
  date_of_birth: null,
  address: null,
  fitzpatrick_type: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  pronouns: null,
  archived_at: null,
};

/** Flips to null so getClientById returns "no such client" for one test. */
const clientState = vi.hoisted(() => ({ exists: true }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    const e = new Error("NEXT_NOT_FOUND");
    (e as Error & { digest?: string }).digest = "NEXT_NOT_FOUND";
    throw e;
  },
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://hone.care",
}));

// The two session_blocks reads go through the Supabase server client directly
// rather than a named helper, so the client factory itself is the observable.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    invoked.log.push("sessionBlocksRead");
    const chain: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(chain, {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return () => proxy;
      },
    });
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => ({
              is: () => ({
                order: () => ({ limit: async () => ({ data: [] }) }),
              }),
            }),
          }),
        }),
      }),
    };
  },
}));

vi.mock("@/lib/supabase/queries", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getCurrentPractitionerWithStudio: loader("identity", {
    studio: STUDIO,
    practitioner: PRACTITIONER,
  }),
  getClientById: (..._a: unknown[]) => {
    invoked.log.push("getClientById");
    return Promise.resolve(
      clientState.exists
        ? { client: CLIENT, pricing: [], sessions: [SESSION], practitioners: [PRACTITIONER] }
        : null,
    );
  },
  getAppointmentsForClientProfile: loader("getAppointmentsForClientProfile", []),
  attachStructuredAreas: loader("attachStructuredAreas", undefined),
}));
vi.mock("@/lib/booking/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getActiveServices: loader("getActiveServices", []),
}));
vi.mock("@/lib/intake/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getLatestIntakeForClient: loader("getLatestIntakeForClient", null),
  getLatestSubmittedOrReviewedIntakeForClient: loader(
    "getLatestSubmittedOrReviewedIntakeForClient",
    null,
  ),
}));
vi.mock("@/lib/portal/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getPortalAccessSummary: loader("getPortalAccessSummary", {
    lastLinkSentAt: null,
    lastSeenAt: null,
  }),
  getRecentPortalAccessEvents: loader("getRecentPortalAccessEvents", []),
}));
vi.mock("@/lib/client-pinned-notes/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getPinnedNotesForClient: loader("getPinnedNotesForClient", []),
}));
vi.mock("@/lib/treatment-plans/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getTreatmentPlansForClient: loader("getTreatmentPlansForClient", []),
}));
vi.mock("@/lib/portal-messages/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getPortalMessagesForPractitionerView: loader("getPortalMessagesForPractitionerView", []),
}));
vi.mock("@/lib/portal-messages/replies-queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getPortalMessageRepliesForPractitionerView: loader(
    "getPortalMessageRepliesForPractitionerView",
    [],
  ),
}));
vi.mock("@/lib/consent/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getConsentTemplatesForStudio: loader("getConsentTemplatesForStudio", []),
  getLatestSignaturesForPractitionerView: loader("getLatestSignaturesForPractitionerView", []),
}));
vi.mock("@/lib/payment-methods/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getActiveCardForStudioClient: loader("getActiveCardForStudioClient", null),
}));
vi.mock("@/lib/imported-treatment-memory", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getImportedTreatmentMemoriesForClient: loader("getImportedTreatmentMemoriesForClient", {
    items: [],
    hasItems: false,
    totalFound: 0,
  }),
}));
vi.mock("@/lib/treatment-time/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getTotalTreatmentTime: loader("getTotalTreatmentTime", {
    totalMinutes: 0,
    sessionCount: 0,
    lastSessionAt: null,
  }),
  getTreatmentTimeByArea: loader("getTreatmentTimeByArea", []),
  getTreatmentGoal: loader("getTreatmentGoal", null),
}));
vi.mock("@/lib/clients/personal-notes-queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getClientPersonalNotes: loader("getClientPersonalNotes", null),
}));
vi.mock("@/lib/clinical-notes/section-data", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  buildClinicalNoteSections: loader("buildClinicalNoteSections", {
    consultation: { entries: [], total: 0 },
    skinHair: { entries: [], total: 0 },
  }),
}));
vi.mock("@/lib/clinical-notes/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getClinicalNotesSummary: loader("getClinicalNotesSummary", null),
}));
vi.mock("@/lib/budget/queries", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  getClientBudgetContext: loader("getClientBudgetContext", null),
}));

const ClientProfilePage = (await import("@/app/(app)/clients/[id]/page"))
  .default as (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

/** Render the real page for one tab and return the loaders it actually ran. */
async function loadersFor(tab: string): Promise<string[]> {
  invoked.log.length = 0;
  await ClientProfilePage({
    params: Promise.resolve({ id: CLIENT.id }),
    searchParams: Promise.resolve({ tab }),
  });
  return [...new Set(invoked.log)].sort();
}

// ---------------------------------------------------------------------------
// The tab vocabulary, derived mechanically from the product contract.
// ---------------------------------------------------------------------------

const ALL_TABS: string[] = (() => {
  const file = path.resolve(__dirname, "../../../components/profile-tab.ts");
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let alias: ts.TypeAliasDeclaration | undefined;
  const walk = (n: ts.Node) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === "ProfileTab") alias = n;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error("ProfileTab union not found");
  return alias.type.types.map((m) => {
    if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) {
      throw new Error("ProfileTab member is not a string literal");
    }
    return m.literal.text;
  });
})();

/** Loaders every tab must run: identity, the client itself, and services. */
const ALWAYS = ["getActiveServices", "getClientById", "identity"];

const EXPECTED: Record<string, string[]> = {
  overview: [
    ...ALWAYS,
    "getActiveCardForStudioClient",
    "getClinicalNotesSummary",
    "getConsentTemplatesForStudio",
    "getImportedTreatmentMemoriesForClient",
    "getLatestIntakeForClient",
    "getLatestSignaturesForPractitionerView",
    "getLatestSubmittedOrReviewedIntakeForClient",
    "getPinnedNotesForClient",
    "getPortalAccessSummary",
    "getPortalMessagesForPractitionerView",
    "getRecentPortalAccessEvents",
    // Both session_blocks reads: last treatment AND treatment intelligence.
    "attachStructuredAreas",
    "sessionBlocksRead",
  ],
  sessions: [
    ...ALWAYS,
    "getAppointmentsForClientProfile",
    "getTotalTreatmentTime",
    "getTreatmentTimeByArea",
    "getTreatmentGoal",
    // Last treatment only — intelligence is Overview-exclusive.
    "attachStructuredAreas",
    "sessionBlocksRead",
  ],
  treatment: [...ALWAYS, "getTreatmentPlansForClient"],
  personal: [...ALWAYS, "getClientPersonalNotes"],
  messages: [
    ...ALWAYS,
    "getPortalMessagesForPractitionerView",
    "getPortalMessageRepliesForPractitionerView",
  ],
  health: [...ALWAYS, "getLatestIntakeForClient"],
  consultation: [...ALWAYS, "buildClinicalNoteSections", "getClientBudgetContext"],
};

beforeEach(() => {
  clientState.exists = true;
  invoked.log.length = 0;
});

describe("the tab vocabulary is covered", () => {
  it("every product tab has an explicit loader contract", () => {
    // A tab added to ProfileTab without an entry here fails, rather than
    // silently going unproven.
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_TABS].sort());
  });
});

describe("which server reads actually run, per tab", () => {
  for (const tab of Object.keys(EXPECTED)) {
    it(`${tab} runs exactly its expected loaders`, async () => {
      const actual = await loadersFor(tab);
      // Set equality: a missing loader AND an unnecessary one both fail.
      expect(actual).toEqual([...EXPECTED[tab]].sort());
    });
  }

  it("tab-exclusive reads stay dormant everywhere else", async () => {
    const EXCLUSIVE: Record<string, string> = {
      getAppointmentsForClientProfile: "sessions",
      getTotalTreatmentTime: "sessions",
      getTreatmentPlansForClient: "treatment",
      getClientPersonalNotes: "personal",
      getPortalMessageRepliesForPractitionerView: "messages",
      buildClinicalNoteSections: "consultation",
      getPinnedNotesForClient: "overview",
      getImportedTreatmentMemoriesForClient: "overview",
    };
    for (const tab of ALL_TABS) {
      const actual = await loadersFor(tab);
      for (const [read, owner] of Object.entries(EXCLUSIVE)) {
        if (owner !== tab) {
          expect(actual, `${read} leaked onto ${tab}`).not.toContain(read);
        }
      }
    }
  });

  it("keeps the Overview pending-task inputs on Overview", async () => {
    // intake and portal messages each render on their own tab AND feed
    // computePortalPendingTasks, an Overview card. Narrowing either to a single
    // tab empties that card — a product regression, not an optimisation.
    const overview = await loadersFor("overview");
    expect(overview).toContain("getLatestIntakeForClient");
    expect(overview).toContain("getPortalMessagesForPractitionerView");
    expect(await loadersFor("health")).toContain("getLatestIntakeForClient");
    expect(await loadersFor("messages")).toContain("getPortalMessagesForPractitionerView");
  });

  it("runs the treatment-intelligence session_blocks read on Overview only", async () => {
    // Overview performs two session_blocks reads (last treatment + intelligence);
    // Sessions performs one; every other tab performs none.
    const count = async (tab: string) => {
      invoked.log.length = 0;
      await ClientProfilePage({
        params: Promise.resolve({ id: CLIENT.id }),
        searchParams: Promise.resolve({ tab }),
      });
      return invoked.log.filter((n) => n === "sessionBlocksRead").length;
    };
    expect(await count("overview")).toBe(2);
    expect(await count("sessions")).toBe(1);
    for (const tab of ALL_TABS.filter((t) => t !== "overview" && t !== "sessions")) {
      expect(await count(tab), `${tab} performed a session_blocks read`).toBe(0);
    }
  });
});

describe("the notFound boundary holds", () => {
  it("runs no profile loader when the client does not resolve", async () => {
    clientState.exists = false;
    invoked.log.length = 0;
    await expect(
      ClientProfilePage({
        params: Promise.resolve({ id: "missing" }),
        searchParams: Promise.resolve({ tab: "overview" }),
      }),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);

    // Observed from invocation, not source position: identity and the client
    // lookup itself may run; nothing downstream may.
    const ran = [...new Set(invoked.log)].sort();
    expect(ran).toEqual(["getClientById", "identity"]);
  });
});
