import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// getSessionBlockAreasByBlockIds — a big clinical history must not break the
// read, and a broken read must never look like a complete one.
// ===========================================================================
//
// TWO DEFECTS, both reproduced against this stack through this exact function
// before the fix:
//
//   1. URI. Every block id went into ONE `.in("session_block_id", ids)`.
//      PostgREST filters ride in the query string and the gateway refuses a
//      request line over ~8 KiB, so the read died at a measured boundary:
//      **205 ids passed, 206 threw `Failed to load block areas: URI too long`**.
//      The loader is called with one id per live block across a client's whole
//      read window (200 sessions on the client profile) and blocks-per-session
//      is unbounded, so this arrived with ordinary use and the profile stopped
//      opening. It only ever worsens.
//
//   2. ROWS. The query carried no `.limit()`, so PostgREST applied its own
//      `max_rows` — 1000 here — and truncated **with HTTP 200 and no error**
//      (`content-range: 0-999/*`). That one does not fail at all: it renders a
//      procedure record that silently understates which areas were treated.
//
// The fix chunks the id list, gives each chunk an explicit row ceiling, and
// keeps the read ALL-OR-NOTHING: one chunk failing rejects the whole call, so
// no caller can receive a map that is missing a chunk while looking complete.
// Rejecting is what this function already did on error, so no caller's failure
// handling changes and the "should an area-read failure 500 the profile at all"
// question stays where it was — open, and out of scope here.
// ===========================================================================

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

const AREAS_PATH = "/rest/v1/session_block_areas";

/** Comfortably past the measured 206-id wall, and over four chunks. */
const BLOCKS = 260;
/** Areas seeded per block — the multi-area shape migration 0128 exists for. */
const AREAS_PER_BLOCK = 2;

let studioA = "";
let studioB = "";
let blockIds: string[] = [];
let studioBBlockIds: string[] = [];

let getAreas: typeof import("@/lib/supabase/queries").getSessionBlockAreasByBlockIds;
let CHUNK = 0;
let ROW_LIMIT = 0;

const seenUrls: string[] = [];

/** Fail every areas request whose id list contains `failIdsContaining`. */
function injectAreasFailure(failIdsContaining: string | null): {
  restore: () => void;
  failed: () => number;
} {
  const realFetch = globalThis.fetch;
  let failed = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (href.includes(AREAS_PATH)) {
      seenUrls.push(decodeURIComponent(href));
      if (failIdsContaining && href.includes(failIdsContaining)) {
        failed += 1;
        return new Response(
          JSON.stringify({
            code: "AREAS-INJECTED",
            message: "injected read failure",
            details: null,
            hint: null,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    restore: () => void (globalThis.fetch = realFetch),
    failed: () => failed,
  };
}

async function seedBlocksWithAreas(
  studioId: string,
  clientId: string,
  practitionerId: string,
  count: number,
  areasPerBlock: number,
  sortBase: number,
): Promise<string[]> {
  const sessionId = randomUUID();
  await adminQuery(
    `insert into public.sessions (id, studio_id, client_id, practitioner_id, modality)
     values ($1, $2, $3, $4, 'electrolysis')`,
    [sessionId, studioId, clientId, practitionerId],
  );
  await adminQuery(
    `insert into public.session_blocks (studio_id, session_id, sort_order)
     select $1, $2, $4::int + g from generate_series(1, $3::int) g`,
    [studioId, sessionId, count, sortBase],
  );
  await adminQuery(
    `insert into public.session_block_areas
       (session_block_id, studio_id, area, laterality, display_order)
     select sb.id, $1,
            'area ' || a,
            (array['left','right','bilateral'])[1 + (a % 3)],
            a
       from public.session_blocks sb
       cross join generate_series(1, $3::int) a
      where sb.studio_id = $1 and sb.session_id = $2`,
    [studioId, sessionId, areasPerBlock],
  );
  const rows = await adminQuery(
    `select id from public.session_blocks
      where studio_id = $1 and session_id = $2 order by sort_order`,
    [studioId, sessionId],
  );
  return rows.rows.map((r: { id: string }) => r.id);
}

describe("session block areas — chunked, complete, all-or-nothing", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const a = await seedStudio(`areas-a-${randomUUID().slice(0, 6)}`);
    const b = await seedStudio(`areas-b-${randomUUID().slice(0, 6)}`);
    studioA = a.studioId;
    studioB = b.studioId;
    blockIds = await seedBlocksWithAreas(
      studioA,
      a.clientId,
      a.practitionerId,
      BLOCKS,
      AREAS_PER_BLOCK,
      0,
    );
    studioBBlockIds = await seedBlocksWithAreas(
      studioB,
      b.clientId,
      b.practitionerId,
      3,
      AREAS_PER_BLOCK,
      0,
    );

    const email = `areas-${randomUUID().slice(0, 8)}@harness.local`;
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
      [a.practitionerId, authUser.id, email],
    );
    const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
    const session = (await token.json()) as {
      access_token: string;
      refresh_token: string;
    };
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

    const mod = await import("@/lib/supabase/queries");
    getAreas = mod.getSessionBlockAreasByBlockIds;
    CHUNK = mod.SESSION_BLOCK_AREA_ID_CHUNK;
    ROW_LIMIT = mod.SESSION_BLOCK_AREA_ROW_LIMIT;
  }, 240_000);

  // ------------------------------------------------------------ the repair
  it("reads a history far past the old 206-id wall, completely", async () => {
    expect(blockIds.length).toBe(BLOCKS);
    const out = await getAreas(blockIds, studioA);
    expect(out.size).toBe(BLOCKS);
    for (const id of blockIds) {
      expect(out.get(id)?.length).toBe(AREAS_PER_BLOCK);
    }
    const total = [...out.values()].reduce((n, v) => n + v.length, 0);
    expect(total).toBe(BLOCKS * AREAS_PER_BLOCK);
  }, 60_000);

  it("the OLD boundary is gone: 205 and 206 ids both succeed now", async () => {
    // The measured pre-fix boundary, pinned from both sides. Before chunking
    // the second of these threw "URI too long".
    const at205 = await getAreas(blockIds.slice(0, 205), studioA);
    const at206 = await getAreas(blockIds.slice(0, 206), studioA);
    expect(at205.size).toBe(205);
    expect(at206.size).toBe(206);
  }, 60_000);

  it("the CHUNK boundary is clean: N, N+1 and an exact multiple all return every block", async () => {
    for (const n of [CHUNK, CHUNK + 1, CHUNK * 2, CHUNK * 2 + 1]) {
      const out = await getAreas(blockIds.slice(0, n), studioA);
      expect(out.size, `${n} ids`).toBe(n);
      const total = [...out.values()].reduce((a, v) => a + v.length, 0);
      expect(total, `${n} ids, total areas`).toBe(n * AREAS_PER_BLOCK);
    }
  }, 60_000);

  it("ordering within each block survives chunking", async () => {
    // WHAT THIS CAN AND CANNOT PROVE — stated because a mutation run settled it.
    //
    // Deleting BOTH `.order()` clauses from the query does not change this
    // result. `session_block_areas_block_order_idx` is
    // `(session_block_id, display_order, created_at, id)`, so the planner hands
    // single-block lookups back in display_order whether or not the query asks.
    // Three seedings were tried to break that — descending set-returning
    // insert, one statement per row descending, and an `area` key sorting
    // opposite to display_order so the unique index would disagree — and all
    // three still came back ascending.
    //
    // So this is a RESULT-level contract check, not a discriminating control
    // for the clauses. It is still worth having: it is what catches chunking
    // reordering a block's areas, which is the risk this change actually
    // introduces. The clause itself is pinned by shape at the foot of this file.
    const out = await getAreas(blockIds, studioA);
    for (const id of blockIds) {
      const order = (out.get(id) ?? []).map((x) => x.display_order);
      expect(order.length, `block ${id}`).toBe(AREAS_PER_BLOCK);
      expect(order, `block ${id}`).toEqual([...order].sort((x, y) => x - y));
    }
  }, 60_000);

  // -------------------------------------------------- NEGATIVE CONTROL
  it("one chunk failing makes the WHOLE read unavailable, never partially true", async () => {
    expect(BLOCKS).toBeGreaterThan(CHUNK); // more than one chunk, or this is vacuous
    const gate = injectAreasFailure(blockIds[0]);
    let threw = false;
    let message = "";
    let leaked: unknown = null;
    try {
      leaked = await getAreas(blockIds, studioA);
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    } finally {
      gate.restore();
    }
    // ANTI-VACUITY: the seam actually fired, on exactly one chunk.
    expect(gate.failed()).toBe(1);
    expect(threw).toBe(true);
    expect(message).toContain("Failed to load block areas");
    // THE CLAIM: no map reaches the caller at all. A partial map would have
    // rendered the surviving chunks' blocks as complete and the failed chunk's
    // blocks as having no treated areas.
    expect(leaked).toBeNull();
  }, 60_000);

  it("ANTI-VACUITY for the control: the same call with no injection returns everything", async () => {
    const out = await getAreas(blockIds, studioA);
    expect(out.size).toBe(BLOCKS);
  }, 60_000);

  it("two chunks failing does not leave an unhandled rejection behind", async () => {
    // Promise.all subscribes to every chunk immediately, so the second failure
    // is handled rather than escaping. If that reasoning is ever wrong this
    // turns red instead of printing a warning nobody reads.
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on("unhandledRejection", onUnhandled);
    // Both of these ids sit in different chunks.
    const realFetch = globalThis.fetch;
    let failed = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (
        href.includes(AREAS_PATH) &&
        (href.includes(blockIds[0]) || href.includes(blockIds[CHUNK]))
      ) {
        failed += 1;
        return new Response(JSON.stringify({ message: "injected" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      await expect(getAreas(blockIds, studioA)).rejects.toThrow(
        /Failed to load block areas/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(failed).toBe(2);
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onUnhandled);
    expect(seen).toEqual([]);
  }, 60_000);

  // ------------------------------------------------- complete-result rule
  it("a chunk at the row ceiling REFUSES rather than returning a truncated area set", async () => {
    // One chunk's worth of blocks carrying more areas than a response may hold.
    const a = await adminQuery(
      `select client_id, practitioner_id from public.sessions where studio_id = $1 limit 1`,
      [studioA],
    );
    const perBlock = Math.ceil(ROW_LIMIT / CHUNK) + 1; // guarantees CHUNK*perBlock > ROW_LIMIT
    const fatIds = await seedBlocksWithAreas(
      studioA,
      a.rows[0].client_id,
      a.rows[0].practitioner_id,
      CHUNK,
      perBlock,
      900000,
    );
    expect(fatIds.length * perBlock).toBeGreaterThan(ROW_LIMIT);

    await expect(getAreas(fatIds, studioA)).rejects.toThrow(/row ceiling/);
  }, 180_000);

  it("the stack's own max_rows is not BELOW our ceiling, or detection would be blind", async () => {
    // The row-ceiling check compares against OUR limit. If the provider capped
    // lower it would truncate first and return fewer rows than our limit, and
    // the check above would never fire. This pins that assumption.
    const res = await fetch(
      `${E2E_SUPABASE_URL}${AREAS_PATH}?select=id`,
      {
        headers: {
          apikey: E2E_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
        },
      },
    );
    const rows = (await res.json()) as unknown[];
    expect(res.status).toBe(200);
    expect(rows.length).toBeGreaterThanOrEqual(ROW_LIMIT);
  }, 60_000);

  // ---------------------------------------------------------- tenant scope
  it("chunking does not widen tenancy: another studio's block ids return nothing", async () => {
    const proof = await adminQuery(
      `select count(*)::int n from public.session_block_areas
        where studio_id = $1 and session_block_id = any($2)`,
      [studioB, studioBBlockIds],
    );
    // ANTI-VACUITY: those blocks really do have areas — under studio B.
    expect(proof.rows[0].n).toBe(studioBBlockIds.length * AREAS_PER_BLOCK);

    const out = await getAreas(studioBBlockIds, studioA);
    expect(out.size).toBe(0);
  }, 60_000);

  it("every chunk carries the caller's studio filter", async () => {
    seenUrls.length = 0;
    const gate = injectAreasFailure(null); // capture only
    try {
      await getAreas(blockIds, studioA);
    } finally {
      gate.restore();
    }
    expect(seenUrls.length).toBe(Math.ceil(BLOCKS / CHUNK));
    for (const url of seenUrls) {
      expect(url).toContain(`studio_id=eq.${studioA}`);
      expect(url).not.toContain(`studio_id=eq.${studioB}`);
      expect(url).toContain(`limit=${ROW_LIMIT}`);
    }
  }, 60_000);

  it("and RLS still holds when the caller passes no studio id", async () => {
    // The optional studioId is defence-in-depth, not the boundary. Without it
    // the policy alone must still refuse another studio's rows.
    const out = await getAreas(studioBBlockIds);
    expect(out.size).toBe(0);
  }, 60_000);

  it("SHAPE ONLY: the explicit ordering clauses are still in the query", async () => {
    // Deliberately a source assertion, and labelled as one. The behavioural
    // test above cannot distinguish these clauses from the index that enforces
    // the same order, so nothing else in this file would notice if a refactor
    // dropped them — and the next schema change that drops or reshapes
    // `session_block_areas_block_order_idx` would then silently take the
    // ordering with it.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/supabase/queries.ts", "utf8");
    const fn = src.slice(
      src.indexOf("export async function getSessionBlockAreasByBlockIds"),
      src.indexOf("export async function attachStructuredAreas"),
    );
    expect(fn).toContain('.order("display_order", { ascending: true })');
    expect(fn).toContain('.order("created_at", { ascending: true })');
  });
});
