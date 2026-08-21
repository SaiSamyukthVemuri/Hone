import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, seedSession, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// PERF2 — what the Client Profile ACTUALLY asks the database, per tab.
//
// This is the proof of record for #612. It replaces a long line of static
// harnesses — source substring checks, AST call walkers, alias/shadow maps,
// binding-purity analysis and a hand-written React renderer — every one of
// which was defeated by how some expression happened to be written, because
// none of them observed the thing the optimization is about.
//
// Here nothing is modelled and nothing is simulated. The REAL page function
// runs against the LOCAL Supabase stack as a REAL signed-in practitioner, and
// every PostgREST request it issues is captured off `fetch`. The assertions are
// on those requests: which tables, how many, in what order, with which
// projection. A read cannot hide from this, however it is spelled, because it
// has to leave the process to reach the database.
//
// WHAT IS AND IS NOT CLAIMED. This proves the SHAPE of the decomposition —
// which reads happen per tab. It does not measure latency. The 584ms p50
// `client-profile.domain` baseline came from production and must be remeasured
// there after merge; nothing here should be read as a speed claim.
// ===========================================================================

// supabase-js requires a global WebSocket at client construction; Node 20 in
// this lane has none and the real Next server does. Profile reads never open a
// realtime channel, so a no-op stub satisfies construction with no dependency
// and no production change. Must be set before any client is built.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// The signed-in session, held as the cookies the app would receive. It is
// written by @supabase/ssr itself rather than hand-rolled, so the format is
// whatever the library actually expects.
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

type Captured = { table: string; select: string; url: string };

/** Every PostgREST request the page issues, in the order it issued them. */
function captureRequests(): { taken: Captured[]; restore: () => void } {
  const taken: Captured[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/rest/v1/")) {
      const rel = url.replace(E2E_SUPABASE_URL, "").replace("/rest/v1/", "");
      const [table, query = ""] = rel.split("?");
      const select = decodeURIComponent(
        query.split("&").find((p) => p.startsWith("select="))?.slice("select=".length) ?? "",
      );
      taken.push({ table, select, url: rel });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { taken, restore: () => void (globalThis.fetch = realFetch) };
}

/** The product's tab vocabulary, read from the ProfileTab contract. */
const ALL_TABS: string[] = (() => {
  const file = path.resolve(__dirname, "../../components/profile-tab.ts");
  const src = readFileSync(file, "utf8");
  const union = src.slice(src.indexOf("export type ProfileTab"));
  const body = union.slice(0, union.indexOf(";"));
  const tabs = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  if (tabs.length === 0) throw new Error("ProfileTab union not found");
  return tabs;
})();

// The exact tables each tab reads, and how many times. Counts, not a set: the
// two session_blocks reads on Overview are separately gated, and so are the two
// client_intake_forms reads.
const ALWAYS = {
  practitioners: 2, // identity, then the studio's practitioner list
  clients: 1,
  client_pricing: 1,
  sessions: 1,
  services: 1,
};

const EXPECTED: Record<string, Record<string, number>> = {
  overview: {
    ...ALWAYS,
    practitioners: 2,
    client_intake_forms: 2, // latest, and latest submitted-or-reviewed
    client_portal_magic_links: 1,
    client_portal_sessions: 1,
    client_portal_messages: 1,
    client_pinned_notes: 1,
    consent_form_templates: 1,
    client_consent_signatures: 1,
    client_payment_methods: 1,
    client_portal_access_events: 1,
    imported_treatment_memories: 1,
    client_clinical_notes: 2,
    session_blocks: 2, // last treatment AND treatment intelligence
    session_block_areas: 2,
  },
  sessions: {
    ...ALWAYS,
    sessions: 3,
    appointments: 1,
    treatment_goals: 1,
    session_blocks: 1, // last treatment only
    session_block_areas: 1,
  },
  consultation: { ...ALWAYS, client_clinical_notes: 4, client_budget_context: 1 },
  treatment: { ...ALWAYS, treatment_plans: 1 },
  personal: { ...ALWAYS, client_personal_notes: 1 },
  messages: { ...ALWAYS, client_portal_messages: 1, client_portal_message_replies: 1 },
  health: { ...ALWAYS, client_intake_forms: 1 },
};

// Tables no other tab may touch. This is the optimization's whole point.
const TAB_EXCLUSIVE: Record<string, string> = {
  appointments: "sessions",
  treatment_goals: "sessions",
  treatment_plans: "treatment",
  client_personal_notes: "personal",
  client_portal_message_replies: "messages",
  client_budget_context: "consultation",
  client_pinned_notes: "overview",
  imported_treatment_memories: "overview",
  consent_form_templates: "overview",
  client_payment_methods: "overview",
};

const SESSION_BLOCK_PROJECTIONS = [
  "id,session_id,sort_order,block_name,primary_area,side,custom_area_detail,mode,apilus_modality,energy_level,minutes_performed,probe_label,probe_lot_number,tolerance_rating,reaction_type,reaction_notes,caution_for_next_session,caution_note,electrolysis_entries(observation_chips,deleted_at)",
  "id,session_id,primary_area,side,block_name,mode,apilus_modality,energy_level,machine_frequency,probe_label,minutes_performed,tolerance_rating,reaction_type,caution_for_next_session,caution_note,electrolysis_entries(hairs_treated,observation_chips,deleted_at)",
];

let clientId = "";
let renderPage: (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

/** Run the real page for a tab and return the requests it made. */
async function requestsFor(tab: string, id = clientId): Promise<Captured[]> {
  const cap = captureRequests();
  try {
    await renderPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve({ tab }),
    });
  } finally {
    cap.restore();
  }
  return cap.taken;
}

const tally = (taken: Captured[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { table } of taken) counts[table] = (counts[table] ?? 0) + 1;
  return counts;
};

describe("Client Profile — real per-tab query behaviour", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const seed = await seedStudio(`perf2-${randomUUID().slice(0, 6)}`);
    clientId = seed.clientId;
    // A session with a block, so the gated session_blocks reads are reachable.
    await seedSession(seed);

    // A REAL local GoTrue user with a password. The DB harness inserts auth
    // rows directly, which GoTrue does not own, so the practitioner is
    // repointed at a user the auth service actually knows about.
    const email = `perf2-${randomUUID().slice(0, 8)}@harness.local`;
    const password = `Pw-${randomUUID()}`;
    const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: E2E_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
    const authUser = (await created.json()) as { id: string };
    await adminQuery(
      "update public.practitioners set user_id = $2, email = $3 where id = $1",
      [seed.practitionerId, authUser.id, email],
    );

    const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
    const session = (await token.json()) as { access_token: string; refresh_token: string };

    const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (list: Array<{ name: string; value: string }>) =>
          list.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    await writer.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (jar.size === 0) throw new Error("no auth cookie was written");

    renderPage = (await import("@/app/(app)/clients/[id]/page")).default as typeof renderPage;
  }, 60_000);

  it("has an expectation for every tab in the product contract", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_TABS].sort());
  });

  for (const tab of Object.keys(EXPECTED)) {
    it(`${tab} reads exactly the tables it needs, exactly as often`, async () => {
      expect(tally(await requestsFor(tab))).toEqual(EXPECTED[tab]);
    }, 30_000);
  }

  it("leaves every tab-exclusive table untouched on other tabs", async () => {
    for (const tab of ALL_TABS) {
      const tables = new Set(Object.keys(tally(await requestsFor(tab))));
      for (const [table, owner] of Object.entries(TAB_EXCLUSIVE)) {
        if (owner !== tab) {
          expect(tables, `${table} was read on ${tab}`).not.toContain(table);
        }
      }
    }
  }, 60_000);

  it("keeps Overview's pending-task inputs, which also serve their own tabs", async () => {
    // Intake and portal messages feed computePortalPendingTasks on Overview as
    // well as rendering on Health and Messages. Narrowing either gate to a
    // single tab empties that card — a product regression, not a saving.
    const overview = tally(await requestsFor("overview"));
    expect(overview.client_intake_forms).toBe(2);
    expect(overview.client_portal_messages).toBe(1);
    expect(tally(await requestsFor("health")).client_intake_forms).toBe(1);
    expect(tally(await requestsFor("messages")).client_portal_messages).toBe(1);
  }, 30_000);

  it("resolves the client before doing any profile work", async () => {
    const taken = await requestsFor("overview");
    const clientAt = taken.findIndex((r) => r.table === "clients");
    expect(clientAt, "the client was never read").toBeGreaterThanOrEqual(0);
    // Everything gated on the client existing must come after it.
    for (const table of ["client_pinned_notes", "session_blocks", "consent_form_templates"]) {
      const at = taken.findIndex((r) => r.table === table);
      expect(at, `${table} was read before the client was resolved`).toBeGreaterThan(clientAt);
    }
  }, 30_000);

  it("issues no profile query at all when the client does not resolve", async () => {
    // A client id that is not in this studio. The page must stop at the client
    // lookup — observed from real requests, not from where notFound() sits.
    let threw = false;
    let taken: Captured[] = [];
    const cap = captureRequests();
    try {
      await renderPage({
        params: Promise.resolve({ id: randomUUID() }),
        searchParams: Promise.resolve({ tab: "overview" }),
      });
    } catch {
      threw = true;
    } finally {
      cap.restore();
      taken = cap.taken;
    }
    expect(threw, "an unknown client should not render").toBe(true);
    const tables = [...new Set(taken.map((r) => r.table))].sort();
    expect(tables).toEqual(["clients", "practitioners"]);
  }, 30_000);

  it("reads session_blocks only on the tabs that render it", async () => {
    expect(tally(await requestsFor("overview")).session_blocks).toBe(2);
    expect(tally(await requestsFor("sessions")).session_blocks).toBe(1);
    for (const tab of ALL_TABS.filter((t) => t !== "overview" && t !== "sessions")) {
      expect(tally(await requestsFor(tab)).session_blocks, `${tab} read session_blocks`).toBe(
        undefined,
      );
    }
  }, 60_000);

  it("asks for exactly the pinned session_blocks columns and no others", async () => {
    // Data minimisation, read off the wire. Every previous version of this
    // guard parsed the source and was evaded by an alias, a rebound name, a
    // helper-returned builder, `blocks["select"]` or `Reflect.apply`. None of
    // that matters here: the projection is in the request.
    const projections = (await requestsFor("overview"))
      .filter((r) => r.table === "session_blocks")
      .map((r) => r.select)
      .sort();
    expect(projections).toEqual([...SESSION_BLOCK_PROJECTIONS].sort());
    expect(projections.some((p) => p === "*" || p.includes("*"))).toBe(false);
  }, 30_000);
});
