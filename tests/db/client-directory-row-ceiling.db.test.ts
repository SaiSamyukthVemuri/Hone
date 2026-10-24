import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient, type Session } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "@/e2e/helpers/local-env";
import { matchesClientSearch } from "@/lib/clients/name-search";
import { adminQuery, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// DAT-001 (E-GAPS): THE CLIENT DIRECTORY PAST THE REAL ROW CEILING
// ===========================================================================
//
// The defect: "Client directory silently omits clients beyond the API row
// ceiling". #981 made the directory read page by keyset and #1078 narrowed its
// columns; both were proved with a fake client that MODELLED the cap. This
// suite proves it against the real stack instead: supabase/config.toml sets
// max_rows = 1000, real RLS, real PostgREST, and the loaders the /clients page
// and global search actually call. Nothing is mocked except Next's cookie
// store, which this process has no request to supply.
//
// The seed puts more than one response's worth of rows in EACH half of the
// archived split, plus a neighbouring studio whose rows must never appear.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ACTIVE_EXTRA = 1100;
const ARCHIVED = 1050;
// Sorts after every "Ceiling ####" name, so it is past row 1000 in name order.
const BEYOND_NAME = "Zulu Beyond-Ceiling";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
  headers: async () => new Headers(),
}));

async function signIn(practitionerId: string, label: string): Promise<Session> {
  const email = `${label}-${randomUUID().slice(0, 8)}@harness.local`;
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
  await adminQuery("update public.practitioners set user_id = $2, email = $3 where id = $1", [
    practitionerId,
    authUser.id,
    email,
  ]);
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  return (await token.json()) as Session;
}

/** The cookies the app would hold for this session, written by @supabase/ssr itself. */
async function cookiesFor(session: Session): Promise<Map<string, string>> {
  const local = new Map<string, string>();
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...local.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => local.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (local.size === 0) throw new Error("no auth cookie was written");
  return local;
}

/** Wait out the GoTrue/PostgREST clock skew (PGRST303) before trusting the token. */
async function waitForToken(accessToken: string): Promise<void> {
  const client = createSupabaseClient(E2E_SUPABASE_URL, ANON, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { error } = await client.from("practitioners").select("id").limit(1);
    if (error?.code !== "PGRST303") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("token never became valid: PostgREST kept reporting PGRST303");
}

let studioId = "";
let activeIds = new Set<string>();
let archivedIds = new Set<string>();
let neighbourIds = new Set<string>();
let accessToken = "";

beforeAll(async () => {
  const seeded = await seedStudio(`dat001-${randomUUID().slice(0, 6)}`);
  studioId = seeded.studioId;
  await adminQuery(
    `insert into public.clients (studio_id, name)
     select $1, 'Ceiling ' || lpad(g::text, 4, '0') from generate_series(1, $2::int) g`,
    [studioId, ACTIVE_EXTRA],
  );
  await adminQuery("insert into public.clients (studio_id, name) values ($1, $2)", [studioId, BEYOND_NAME]);
  // Distinct archive instants, so the most-recently-archived order is total.
  await adminQuery(
    `insert into public.clients (studio_id, name, archived_at)
     select $1, 'Archived ' || lpad(g::text, 4, '0'), now() - (g || ' minutes')::interval
       from generate_series(1, $2::int) g`,
    [studioId, ARCHIVED],
  );
  const neighbour = await seedStudio(`dat001-n-${randomUUID().slice(0, 6)}`);
  await adminQuery(
    `insert into public.clients (studio_id, name)
     select $1, 'Ceiling neighbour ' || g from generate_series(1, 5) g`,
    [neighbour.studioId],
  );

  const ids = async (sql: string, params: unknown[]) =>
    new Set((await adminQuery(sql, params)).rows.map((r) => r.id as string));
  activeIds = await ids("select id from public.clients where studio_id = $1 and archived_at is null", [studioId]);
  archivedIds = await ids("select id from public.clients where studio_id = $1 and archived_at is not null", [studioId]);
  neighbourIds = await ids("select id from public.clients where studio_id = $1", [neighbour.studioId]);

  const session = await signIn(seeded.practitionerId, "dat001");
  accessToken = session.access_token;
  await waitForToken(accessToken);
  jar.clear();
  for (const [k, v] of await cookiesFor(session)) jar.set(k, v);
}, 180_000);

describe("DAT-001: the client directory past the real row ceiling", () => {
  it("the ceiling is real on this stack: one unranged response stops at 1000", async () => {
    // Without this, every test below could pass on a stack with no cap at all.
    const client = createSupabaseClient(E2E_SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.from("clients").select("id").eq("studio_id", studioId).is("archived_at", null);
    expect(error).toBeNull();
    expect(activeIds.size).toBeGreaterThan(1000);
    expect(data).toHaveLength(1000);
  });

  it("the full active list is complete: every active client exactly once, no archived, no other studio", async () => {
    const { getClientsForStudio } = await import("@/lib/supabase/queries");
    const rows = await getClientsForStudio(studioId);
    const got = rows.map((r) => r.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(activeIds.size);
    expect(new Set(got)).toEqual(activeIds);
    expect(rows.every((r) => r.archived_at === null)).toBe(true);
    expect(got.some((id) => neighbourIds.has(id))).toBe(false);
    // Name order, as /clients renders it: the beyond-ceiling name is last.
    expect(rows.at(-1)?.name).toBe(BEYOND_NAME);
  }, 60_000);

  it("the archived split is complete and disjoint from the active list", async () => {
    const { getArchivedClientsForStudio } = await import("@/lib/supabase/queries");
    const rows = await getArchivedClientsForStudio(studioId);
    const got = rows.map((r) => r.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.length).toBe(ARCHIVED);
    expect(new Set(got)).toEqual(archivedIds);
    expect(got.some((id) => activeIds.has(id))).toBe(false);
    // Most recently archived first: 'Archived 0001' was archived 1 minute ago.
    expect(rows[0]?.name).toBe("Archived 0001");
    expect(rows.at(-1)?.name).toBe(`Archived ${String(ARCHIVED).padStart(4, "0")}`);
  }, 60_000);

  it("the /clients typeahead searches the complete list: a client past row 1000 is found", async () => {
    // ClientSearch filters the rows /clients hands it with matchesClientSearch
    // (components/client-search.tsx), so the search is complete exactly when
    // the list it receives is.
    const { getClientsForStudio } = await import("@/lib/supabase/queries");
    const rows = await getClientsForStudio(studioId);
    const index = rows.findIndex((r) => r.name === BEYOND_NAME);
    expect(index).toBeGreaterThanOrEqual(1000);
    const hits = rows.filter((r) => matchesClientSearch(r, "zulu beyond"));
    expect(hits.map((r) => r.name)).toEqual([BEYOND_NAME]);
    // And a query matching every seeded "Ceiling" name sees all of them.
    expect(rows.filter((r) => matchesClientSearch(r, "ceiling")).length).toBe(ACTIVE_EXTRA + 1);
  }, 60_000);

  it("global search finds the client past row 1000, and never an archived or neighbouring one", async () => {
    const { globalSearchAction } = await import("@/app/(app)/global-search-actions");
    const res = await globalSearchAction("Zulu Beyond");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const clients = res.results.filter((r) => r.type === "client");
    expect(clients.map((r) => r.title)).toEqual([BEYOND_NAME]);
    const archived = await globalSearchAction("Archived 0001");
    expect(archived.ok).toBe(true);
    if (archived.ok) {
      expect(archived.results.some((r) => r.type === "client")).toBe(false);
    }
  }, 60_000);
});
