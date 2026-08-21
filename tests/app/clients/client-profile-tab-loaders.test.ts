import { existsSync, readFileSync } from "node:fs";
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
//
// WHAT THIS FILE MEASURES, AND WHAT MAKES THAT COMPLETE
// -----------------------------------------------------
// It runs the real page function for a tab and records the loaders THE PAGE
// BODY invokes. It does not render anything. Completeness comes from a separate,
// structural fact proved at the bottom of this file: the child graph the page
// returns is data-passive, so the page body is the only place a read can start.
//
// That is an inversion. Earlier revisions tried to observe child reads by
// EXECUTING the returned tree, which meant reimplementing React's render
// semantics by hand — and every correction traded one divergence for another:
// async-only execution missed sync wrappers, a global visited-set under-counted
// reused elements, fixing that over-counted passthrough wrappers, and each call
// form (memo, lazy, element access, Reflect.apply) needed its own rule. Proving
// children CANNOT read is bounded; simulating what they WOULD do is not.
//
// Two supporting properties:
//
// 1. MULTIPLICITY IS KEPT. Expectations are call COUNTS, not a set of names.
//    `attachStructuredAreas` runs twice on Overview, under two separate gates;
//    with a deduplicated set, deleting one of them stayed green.
// 2. EVERY QUERY IS RECORDED, BY TABLE. Both Supabase factories are faked; the
//    server factory records each `.from(table)` and records any other surface
//    the instant it is touched, so a read through an already-built client, or
//    through rpc/storage/schema, still shows up in the counts.
//
// KNOWN LIMITATIONS, STATED RATHER THAN IMPLIED
// ---------------------------------------------
// Two things this file does NOT prove. Both are written down because a proof
// whose edges are undocumented gets read as proving more than it does.
//
// 1. ARGUMENTS. Invocation recording proves WHICH reads run and HOW OFTEN, not
//    that a call got the right arguments: `attachStructuredAreas([], …)` keeps
//    Overview's count at two while enriching nothing. Argument-level
//    correctness belongs to the tests that own those helpers.
//
// 2. BRANCH COVERAGE. Every read is observed for ONE client shape — the fixture
//    below, whose lists are empty and whose session carries no blocks. A read
//    added inside a branch this fixture never enters (`if (lastTreatment) {…}`,
//    for instance) runs in production and is invisible here. Verified, not
//    assumed: such a mutation survives green today. Closing it means running
//    each tab against a second, populated fixture and asserting an exact map
//    for that one too — worth doing, and deliberately not smuggled into this
//    change.
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

/**
 * A query builder that accepts any chain and resolves to an empty result.
 *
 * Every method returns the same proxy, so `.select().eq().in().is().order()
 * .limit()` — or any other shape a future read uses — works without this fake
 * having to know it in advance.
 */
const queryBuilder = (): unknown => {
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        }
        return () => proxy;
      },
    },
  );
  return proxy;
};

// The two session_blocks reads go through the Supabase server client directly
// rather than a named helper, so the client is the observable.
//
// Recording happens at `.from(table)`, NOT at createClient(). Counting client
// CONSTRUCTION missed any read issued through a client that already existed:
// adding `supabaseForSummary.from("sessions").select(…)` left the factory count
// unchanged, escaped the session_blocks projection scan because it names another
// table, and kept every per-tab map green. Recording each query by its table
// makes any read of anything observable, whoever issued it.
/**
 * A stand-in for any Supabase surface that is not `from`.
 *
 * It records AT THE MOMENT OF PROPERTY ACCESS and then keeps answering, rather
 * than recording when called and throwing. Recording on call missed the normal
 * nested shape `supabase.storage.from(bucket).list(…)`: reading `storage`
 * returned a function without invoking it, so nothing was recorded, and the
 * `.from` on that function then threw a TypeError which callComponent swallowed.
 * Refusing loudly is the wrong instinct here — a throw can be caught, whereas a
 * log entry cannot be un-written.
 */
const refusedSurface = (path: string): unknown =>
  new Proxy(() => refusedSurface(path), {
    get: (_t, prop) => {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return refusedSurface(`${path}.${String(prop)}`);
    },
    apply: () => refusedSurface(path),
  });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "from") {
            return (table: string) => {
              invoked.log.push(`query:${table}`);
              return queryBuilder();
            };
          }
          if (prop === "then" || typeof prop === "symbol") return undefined;
          // Every other route to the database through this client — rpc,
          // storage, schema, and anything nested under them — is recorded the
          // instant it is touched, so the tab map fails whether or not the call
          // that follows succeeds, throws, or is swallowed.
          invoked.log.push(`unrecordedSupabaseSurface:${String(prop)}`);
          return refusedSurface(String(prop));
        },
      },
    ),
}));

// Every remaining query helper reaches Supabase through one of two factories.
// Faking BOTH means an unaccounted read cannot slip past the per-tab counts:
// admin-client reads must never be constructed here, because every loader that
// uses one is itself stubbed below.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    invoked.log.push("adminClientRead");
    throw new Error("unexpected admin-client read from the Client Profile page");
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

/**
 * Render the real page for one tab and return how many times each loader ran.
 *
 * COUNTS, not a set. Deduplicating loses real regressions: `attachStructuredAreas`
 * runs twice on Overview — once for the last-treatment rows and once for the
 * treatment-intelligence rows — so with a set, deleting the intelligence call
 * left the name present via the other call site and every assertion stayed
 * green while the intelligence card silently lost its structured areas.
 */
async function invocationsFor(tab: string): Promise<Record<string, number>> {
  invoked.log.length = 0;
  await ClientProfilePage({
    params: Promise.resolve({ id: CLIENT.id }),
    searchParams: Promise.resolve({ tab }),
  });
  const counts: Record<string, number> = {};
  for (const name of invoked.log) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

/** The element tree the page returns for a tab. Never executed — only inspected. */
async function treeFor(tab: string): Promise<unknown> {
  return ClientProfilePage({
    params: Promise.resolve({ id: CLIENT.id }),
    searchParams: Promise.resolve({ tab }),
  });
}

/** The names of the loaders that ran, for leak checks that ignore multiplicity. */
async function loadersFor(tab: string): Promise<string[]> {
  return Object.keys(await invocationsFor(tab)).sort();
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

/**
 * Every component module the page imports, as lazy loaders.
 *
 * Used to give the components in the returned tree a MODULE IDENTITY without
 * calling any of them. Anything in the tree that is not one of these is a
 * component this proof has never audited, and that fails.
 */
const PAGE_COMPONENT_MODULES: Array<[string, () => Promise<Record<string, unknown>>]> = [
  ["./BookAppointment", () => import("@/app/(app)/clients/[id]/BookAppointment")],
  ["./PortalAccessCard", () => import("@/app/(app)/clients/[id]/PortalAccessCard")],
  ["./intake/IntakeResendCard", () => import("@/app/(app)/clients/[id]/intake/IntakeResendCard")],
  ["./intake/StartAssistedIntakeButton", () => import("@/app/(app)/clients/[id]/intake/StartAssistedIntakeButton")],
  ["@/components/add-pricing-form", () => import("@/components/add-pricing-form")],
  ["@/components/before-today-card", () => import("@/components/before-today-card")],
  ["@/components/client-appointment-timeline", () => import("@/components/client-appointment-timeline")],
  ["@/components/client-birthday-card", () => import("@/components/client-birthday-card")],
  ["@/components/client-budget-card", () => import("@/components/client-budget-card")],
  ["@/components/client-personal-notes-editor", () => import("@/components/client-personal-notes-editor")],
  ["@/components/client-pinned-notes-card", () => import("@/components/client-pinned-notes-card")],
  ["@/components/clinical-notes-section", () => import("@/components/clinical-notes-section")],
  ["@/components/clinical-notes-summary", () => import("@/components/clinical-notes-summary")],
  ["@/components/consent-signatures-card", () => import("@/components/consent-signatures-card")],
  ["@/components/entry-row", () => import("@/components/entry-row")],
  ["@/components/formatted-date-time", () => import("@/components/formatted-date-time")],
  ["@/components/last-session-summary", () => import("@/components/last-session-summary")],
  ["@/components/last-visit-card", () => import("@/components/last-visit-card")],
  ["@/components/payment-method-card", () => import("@/components/payment-method-card")],
  ["@/components/portal-messages-card", () => import("@/components/portal-messages-card")],
  ["@/components/profile-tab-bar", () => import("@/components/profile-tab-bar")],
  ["@/components/session-timeline", () => import("@/components/session-timeline")],
  ["@/components/treatment-intelligence-card", () => import("@/components/treatment-intelligence-card")],
  ["@/components/treatment-plans-card", () => import("@/components/treatment-plans-card")],
  ["@/components/treatment-time-card", () => import("@/components/treatment-time-card")],
];

/** Loaders every tab must run, once each: identity, the client itself, services. */
const ALWAYS = { identity: 1, getClientById: 1, getActiveServices: 1 };

const EXPECTED: Record<string, Record<string, number>> = {
  overview: {
    ...ALWAYS,
    getActiveCardForStudioClient: 1,
    getClinicalNotesSummary: 1,
    getConsentTemplatesForStudio: 1,
    getImportedTreatmentMemoriesForClient: 1,
    getLatestIntakeForClient: 1,
    getLatestSignaturesForPractitionerView: 1,
    getLatestSubmittedOrReviewedIntakeForClient: 1,
    getPinnedNotesForClient: 1,
    getPortalAccessSummary: 1,
    getPortalMessagesForPractitionerView: 1,
    getRecentPortalAccessEvents: 1,
    // TWICE: last treatment AND treatment intelligence. Both are gated
    // separately, so both counts are load-bearing.
    attachStructuredAreas: 2,
    "query:session_blocks": 2,
  },
  sessions: {
    ...ALWAYS,
    getAppointmentsForClientProfile: 1,
    getTotalTreatmentTime: 1,
    getTreatmentTimeByArea: 1,
    getTreatmentGoal: 1,
    // ONCE: last treatment only — intelligence is Overview-exclusive.
    attachStructuredAreas: 1,
    "query:session_blocks": 1,
  },
  treatment: { ...ALWAYS, getTreatmentPlansForClient: 1 },
  personal: { ...ALWAYS, getClientPersonalNotes: 1 },
  messages: {
    ...ALWAYS,
    getPortalMessagesForPractitionerView: 1,
    getPortalMessageRepliesForPractitionerView: 1,
  },
  health: { ...ALWAYS, getLatestIntakeForClient: 1 },
  consultation: { ...ALWAYS, buildClinicalNoteSections: 1, getClientBudgetContext: 1 },
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
    it(`${tab} runs exactly its expected loaders, exactly as often`, async () => {
      const actual = await invocationsFor(tab);
      // Exact map equality: a missing loader, an unnecessary loader, AND a
      // changed call count all fail.
      expect(actual).toEqual(EXPECTED[tab]);
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
    const count = async (tab: string) => (await invocationsFor(tab))["query:session_blocks"] ?? 0;
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
    // lookup itself may run, once each; nothing downstream may.
    const ran: Record<string, number> = {};
    for (const name of invoked.log) ran[name] = (ran[name] ?? 0) + 1;
    expect(ran).toEqual({ identity: 1, getClientById: 1 });
  });
});

// ===========================================================================
// THE OTHER HALF OF THE GUARANTEE: THE RETURNED CHILD GRAPH IS DATA-PASSIVE.
//
// The recorder above observes the PAGE BODY. That set is only COMPLETE if
// nothing the page returns can perform a read of its own. Earlier revisions
// tried to establish that by executing the returned tree — reimplementing
// React's render semantics by hand — and every correction traded one
// divergence for another: async-only execution missed sync wrappers, a global
// visited-set under-counted reused elements, fixing that over-counted
// passthrough wrappers, and each new call form (memo, lazy, element access,
// Reflect.apply) needed its own rule. That is an interpreter, and it does not
// converge.
//
// So the guarantee is inverted. Nothing here is executed. Instead:
//
//   A. every component reachable in the returned tree is one of the component
//      modules the page imports — established by MODULE IDENTITY, not by name
//      or by rendering; and
//
//   B. every SERVER component among those is structurally incapable of a read:
//      it is not async, it does not take React `use`, and it imports no
//      Supabase client, no server action, and no async binding from any module.
//
// A + B means a read can only originate in the page body, which is exactly what
// the recorder above measures. Client components are the boundary: they cannot
// perform a server read during the server render, and a server component handed
// to one as a child is created in the page body and so appears in this walk.
//
// Both halves are mechanical module-boundary facts. Neither evaluates a
// JavaScript expression, so neither can be defeated by how an expression is
// written — which is what made every previous revision unbounded.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PAGE_FILE = path.join(REPO_ROOT, "app/(app)/clients/[id]/page.tsx");

const readFile = (file: string) => readFileSync(file, "utf8");
const isClientModule = (file: string) => /^\s*["']use client["']/.test(readFile(file));
const isServerActionModule = (file: string) => /^\s*["']use server["']/.test(readFile(file));

/** Resolve an import specifier to a file, or null when it leaves the repo. */
function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Names a module exports as async — declaration level, never a call graph. */
function asyncExports(file: string): Set<string> {
  const src = readFile(file);
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+async\s+function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*[:=][^=]*=\s*async\b/g)) names.add(m[1]);
  return names;
}

/** Value imports of a module as (specifier, bound names); "*" marks a namespace. */
function valueImports(file: string): Array<{ spec: string; names: Set<string> }> {
  const src = readFile(file);
  const out: Array<{ spec: string; names: Set<string> }> = [];
  for (const m of src.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)"/g)) {
    if (m[1]) continue; // `import type` is erased at runtime
    const clause = m[2].trim();
    const names = new Set<string>();
    if (/^\*\s+as\s+\w+/.test(clause)) {
      names.add("*");
    } else {
      const braced = clause.match(/\{([\s\S]*)\}/);
      if (braced) {
        for (const raw of braced[1].split(",")) {
          const part = raw.trim();
          if (!part || part.startsWith("type ")) continue;
          names.add(part.split(" as ")[0].trim());
        }
      }
      const dflt = clause.split("{")[0].trim().replace(/,$/, "").trim();
      if (dflt && !dflt.startsWith("*")) names.add(dflt);
    }
    out.push({ spec: m[3], names });
  }
  return out;
}

/** Component modules the page imports, resolved to files. */
function pageComponentFiles(): Array<{ spec: string; file: string }> {
  const src = readFile(PAGE_FILE);
  const specs = [...new Set([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]))].sort();
  const out: Array<{ spec: string; file: string }> = [];
  for (const spec of specs) {
    const file = resolveModule(spec, PAGE_FILE);
    if (file && file.endsWith(".tsx")) out.push({ spec, file });
  }
  return out;
}

describe("the returned child graph is data-passive", () => {
  it("renders only components the page itself imports", async () => {
    // Module identity, established without calling anything. A component that
    // is not one of these has never been through the audit below.
    const known = new Map<unknown, string>();
    for (const [spec, load] of PAGE_COMPONENT_MODULES) {
      for (const value of Object.values(await load())) {
        if (typeof value === "function" || (value && typeof value === "object")) {
          known.set(value, spec);
        }
      }
    }
    known.set((await import("next/link")).default, "next/link");

    const unrecognised = new Set<string>();
    const walk = (node: unknown, depth = 0) => {
      if (node == null || typeof node !== "object" || depth > 200) return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child, depth + 1);
        return;
      }
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      const type = el.type;
      if (
        el.props !== undefined &&
        (typeof type === "function" || (type && typeof type === "object")) &&
        !known.has(type)
      ) {
        unrecognised.add(
          typeof type === "function"
            ? (type as { name?: string }).name || "(anonymous)"
            : `object component ${String((type as { $$typeof?: symbol }).$$typeof?.description)}`,
        );
      }
      for (const value of Object.values((el.props ?? {}) as Record<string, unknown>)) {
        walk(value, depth + 1);
      }
    };
    for (const tab of ALL_TABS) walk(await treeFor(tab));

    expect(
      [...unrecognised],
      "the page rendered a component this proof has not audited",
    ).toEqual([]);
  });

  it("keeps every rendered server component incapable of reading data", () => {
    // The terminating invariant. Each condition is a declaration- or
    // import-level fact; none inspects a function body or evaluates anything.
    const violations: string[] = [];
    const audited = new Set<string>();

    const audit = (file: string) => {
      if (audited.has(file)) return;
      audited.add(file);
      const rel = path.relative(REPO_ROOT, file);
      const src = readFile(file);

      for (const m of src.matchAll(/export\s+(default\s+)?async\s+function\s*(\w*)/g)) {
        violations.push(`${rel}: async server component "${m[2] || "default"}"`);
      }
      for (const { spec, names } of valueImports(file)) {
        if (spec === "react" && names.has("use")) {
          violations.push(`${rel}: imports React use(), which can await server data`);
          continue;
        }
        const target = resolveModule(spec, file);
        if (!target) continue;
        const targetRel = path.relative(REPO_ROOT, target);
        if (targetRel === "lib/supabase/server.ts" || targetRel === "lib/supabase/admin-server.ts") {
          violations.push(`${rel}: imports a Supabase client from ${spec}`);
          continue;
        }
        if (isServerActionModule(target)) {
          violations.push(`${rel}: imports the server-action module ${spec}`);
          continue;
        }
        const asyncNames = asyncExports(target);
        if (names.has("*") && asyncNames.size > 0) {
          violations.push(`${rel}: namespace-imports ${spec}, which exports async functions`);
          continue;
        }
        const asyncBindings = [...names].filter((n) => asyncNames.has(n)).sort();
        if (asyncBindings.length > 0) {
          violations.push(`${rel}: imports async binding(s) ${asyncBindings.join(", ")} from ${spec}`);
          continue;
        }
        // Follow only server COMPONENT modules. A pure binding imported from a
        // data module is fine — the loader itself is not in scope here — and
        // descending into that module would audit exports nobody can reach.
        if (target.endsWith(".tsx") && !isClientModule(target)) audit(target);
      }
    };

    const servers = pageComponentFiles().filter(({ file }) => !isClientModule(file));
    expect(servers.length, "expected the page to render server components").toBeGreaterThan(0);
    for (const { file } of servers) audit(file);

    expect(violations, "a rendered server component can reach server data").toEqual([]);
  });
});
