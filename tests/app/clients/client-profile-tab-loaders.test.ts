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
//
// TWO PROPERTIES THIS OBSERVATION DEPENDS ON
// ------------------------------------------
// 1. MULTIPLICITY IS KEPT. Expectations are call COUNTS, not a set of names.
//    `attachStructuredAreas` runs twice on Overview, under two separate gates;
//    with a deduplicated set, deleting one of them stayed green.
// 2. THE RETURNED TREE IS EXECUTED. Awaiting the page runs its body and returns
//    an element tree — Next, not the await, runs the components in it. So the
//    tree is walked and its async server components are run too (see
//    renderDeep), and a read added to one of them is observed rather than
//    missed.
//
// 3. EVERY QUERY IS RECORDED, BY TABLE. Both Supabase factories are faked; the
//    server factory records each `.from(table)` rather than each client
//    construction, so a read issued through an already-existing client, against
//    any table, is still observed.
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
 * Execute the async server components inside a returned RSC tree.
 *
 * Awaiting the page function runs its body and hands back an element tree; it
 * does not run the components in that tree — Next does. So a read added to an
 * async child server component would happen in production and be invisible
 * here. The tree is therefore walked and every async component in it executed.
 *
 * Sync function components are deliberately NOT invoked: a "use client"
 * component is just a function under vitest, and calling it would run browser
 * code and make this test fail for reasons unrelated to tab gating. The walk
 * still descends through children and element-valued props, so an async
 * component handed to one of them is still reached and run.
 */
/**
 * Call one component and return what it rendered, or undefined if it refused.
 *
 * A client component invoked outside a React render throws on its first hook,
 * which is expected here and means "not a server component" — but React logs
 * that error before throwing, so the message is filtered while the call is in
 * flight. Only the hook-call message is suppressed, and console.error is always
 * restored, so a genuine error from a server component still surfaces.
 */
async function callComponent(fn: (p: unknown) => unknown, props: unknown): Promise<unknown> {
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("Invalid hook call") || first.includes("Rules of Hooks")) return;
    realError(...args);
  };
  try {
    const out = fn(props);
    return out && typeof (out as { then?: unknown }).then === "function" ? await out : out;
  } catch {
    // A client component throws here — on its first hook, as an "Invalid hook
    // call" or as a raw TypeError from a null dispatcher, depending on the
    // path. Distinguishing those from a genuine server-component failure by
    // message is exactly the recognise-every-form trap this file keeps falling
    // into, so it is not attempted.
    //
    // Swallowing is sound instead because of where the guard sits: the Supabase
    // fake RECORDS a surface before refusing it, so a read through rpc/storage/
    // schema lands in the log even though the call then throws and is caught
    // here. The count changes and the tab map fails.
    //
    // Residual, stated plainly: reads a component would have performed AFTER a
    // throw are not observed. In production that component throws too, so this
    // is a broken page rather than a silent extra read — a different failure
    // class from the one this file exists to catch.
    return undefined;
  } finally {
    console.error = realError;
  }
}

/**
 * Resolve a component type through the wrappers React allows, or return null
 * when this walker cannot classify it.
 *
 * Returning null is a FAILURE upstream, not a skip — the same inversion the
 * projection guard uses. A memo- or lazy-wrapped async component is an object,
 * not a function, so the previous walker stepped over it and the read inside it
 * was never seen. Rather than enumerate wrappers forever, anything unrecognised
 * now fails the test and has to be taught to this function before it can be
 * used.
 */
function resolveComponent(type: unknown): { fn: ((p: unknown) => unknown) | null; ok: boolean } {
  if (typeof type === "function") return { fn: type as (p: unknown) => unknown, ok: true };
  // Host elements ("div") and Fragment/Suspense (symbols) render no reads
  // themselves; their children are walked below.
  if (typeof type === "string" || typeof type === "symbol") return { fn: null, ok: true };
  if (type && typeof type === "object") {
    const t = type as { $$typeof?: symbol; type?: unknown; render?: unknown; _init?: unknown; _payload?: unknown };
    const tag = typeof t.$$typeof === "symbol" ? String(t.$$typeof.description ?? "") : "";
    if (tag.includes("memo")) return resolveComponent(t.type);
    if (tag.includes("forward_ref")) return resolveComponent(t.render);
    if (tag.includes("lazy")) {
      try {
        return resolveComponent((t._init as (p: unknown) => unknown)(t._payload));
      } catch {
        return { fn: null, ok: false };
      }
    }
    return { fn: null, ok: false };
  }
  return { fn: null, ok: true };
}

const isElement = (n: object): boolean =>
  typeof (n as { $$typeof?: unknown }).$$typeof === "symbol" && "type" in n;

// The real tree bottoms out between depth 10 and 20 (measured by lowering this
// cap until the suite breaks), so 200 is roughly ten times the headroom needed
// and the limit is a runaway guard rather than a silent truncation point.
const MAX_RENDER_DEPTH = 200;

async function renderDeep(node: unknown, depth = 0, path = new Set<object>()): Promise<void> {
  if (node == null || typeof node !== "object") return;
  // Depth exhaustion is a FAILURE, not an empty subtree. Returning quietly left
  // everything past the limit unexecuted while this file claimed to fail closed,
  // and React applies no such cutoff, so the read would happen in production.
  expect(
    depth,
    "renderDeep hit its depth limit, so part of the tree went unexecuted and any read inside it would be invisible",
  ).toBeLessThanOrEqual(MAX_RENDER_DEPTH);
  // Cycle protection tracks the ACTIVE PATH only, added on the way down and
  // removed on the way back up. A set spanning the whole walk deduplicated an
  // element object reused in two positions — `const r = <R/>; {r}{r}` — which
  // React renders twice and this walked once, hiding a doubled read behind an
  // unchanged count.
  if (path.has(node)) return;
  path.add(node);
  try {
    await renderDeepNode(node, depth, path);
  } finally {
    path.delete(node);
  }
}

async function renderDeepNode(node: object, depth: number, path: Set<object>): Promise<void> {
  if (Array.isArray(node)) {
    for (const child of node) await renderDeep(child, depth + 1, path);
    return;
  }
  if (!isElement(node)) {
    // Plain objects and iterables are walked too: an element nested in an
    // object-valued prop, or yielded by a generator, is rendered for real by
    // Next and was previously invisible here.
    const iter = (node as { [Symbol.iterator]?: unknown })[Symbol.iterator];
    if (typeof iter === "function") {
      for (const child of node as Iterable<unknown>) await renderDeep(child, depth + 1, path);
      return;
    }
    for (const value of Object.values(node)) await renderDeep(value, depth + 1, path);
    return;
  }
  const el = node as { type?: unknown; props?: unknown };
  const props = (el.props ?? {}) as Record<string, unknown>;
  const resolved = resolveComponent(el.type);
  expect(
    resolved.ok,
    `renderDeep met a component type it cannot classify, so any read inside it would be invisible: ${String(el.type)}`,
  ).toBe(true);
  if (resolved.fn) {
    // EVERY function component is executed, not only `async`-declared ones.
    //
    // Predicating on AsyncFunction missed two forms Next renders for real: a
    // sync wrapper `function W() { return <AsyncReads /> }`, whose async child
    // lives in W's RETURN VALUE rather than its props, and a component that
    // returns a promise without the async keyword. Both left every loader map
    // green while the read really happened.
    //
    // Client components are plain functions under vitest, so calling one may
    // throw (a hook outside a render) — that is caught and its subtree skipped,
    // which is sound: a client component cannot RETURN a server component. It
    // can only receive one as a prop, and props are walked below regardless.
    await renderDeep(await callComponent(resolved.fn, props), depth + 1, path);
  }
  for (const value of Object.values(props)) await renderDeep(value, depth + 1, path);
}

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
  const tree = await ClientProfilePage({
    params: Promise.resolve({ id: CLIENT.id }),
    searchParams: Promise.resolve({ tab }),
  });
  await renderDeep(tree);
  const counts: Record<string, number> = {};
  for (const name of invoked.log) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
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
