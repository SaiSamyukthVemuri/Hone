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
// Record Keeping — a history read that did not happen is never "no history".
// ===========================================================================
//
// THE DEFECT, as reproduced before the fix. `getAuditEventsByRecord` destructured
// `const { data } = await supabase…` and never looked at `error`, so ANY failed
// read collapsed to an empty `Map`. The UI renders an absent entry as
//
//     "No history recorded yet."
//
// on an append-only clinical audit trail written exclusively by database
// triggers — i.e. it states that nothing was ever done to this record. Measured
// on the unfixed code against this same stack: 200 records holding 200 audit
// events, one injected HTTP 500, and the function returned a map of size 0 —
// byte-for-byte the shape it returns for a record that genuinely has no
// history. The caller could not tell them apart, so the page asserted an
// absence it had never read.
//
// WHAT THIS FILE PROVES, and why each part is here:
//
//   1. the healthy path still returns real history (without this, every
//      assertion below is satisfied by a page that reads nothing);
//   2. a record that genuinely has no history is still reported as EMPTY, not
//      unavailable — the fix must not buy truthfulness by crying failure;
//   3. THE NEGATIVE CONTROL: exactly one chunk fails, and that chunk's records
//      become UNKNOWN while every other chunk still shows its real events;
//   4. the same failure driven through the REAL PAGE: the rendered output must
//      not contain the sentence, and must say what actually happened;
//   5. tenant scoping is unchanged — splitting one request into several does
//      not widen what any of them may see;
//   6. the URI wall itself, measured against this stack, so the number the fix
//      is built on cannot rot silently.
//
// Every failure case asserts that the seam actually fired. A seam that quietly
// stops matching after a refactor must turn this file RED rather than reduce it
// to asserting that a healthy page renders.
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

// The record forms are client components that call useRouter(); the page cannot
// be rendered without an app-router stub. Mirrors
// tests/db/client-profile-read-failure-containment.db.test.ts.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/records",
  useParams: () => ({}),
  useSelectedLayoutSegment: () => null,
}));

/** Copy the surfaces use to refuse to claim absence after a failed read. */
const UNAVAILABLE = "could not be loaded";

/** The sentence that would be a clinical LIE after a read that never returned. */
const CONFIDENT_ABSENCE = "No history recorded yet.";

const HISTORY_PATH = "/rest/v1/record_keeping_audit_events";

/** Two chunks' worth plus a remainder, so "one chunk failed" is observable. */
const ITEMS = 60;

let studioA = "";
let studioB = "";
let itemIds: string[] = [];
/** A studio-A record whose audit rows were removed: genuinely empty history. */
let emptyHistoryItemId = "";
let studioBItemIds: string[] = [];

let getAuditEventsByRecord: typeof import("@/lib/record-keeping/queries").getAuditEventsByRecord;
let AUDIT_HISTORY_ID_CHUNK = 0;
let AUDIT_EVENT_READ_LIMIT = 0;
let renderPage: (props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;
let renderPrint: (props: {
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

/** Requests this test saw go to the history table, for the scoping assertion. */
const seenHistoryUrls: string[] = [];

/**
 * Fail every history request whose id list contains `failIdsContaining`, and
 * record how many were actually failed so a test can prove the seam fired.
 *
 * Injected at `globalThis.fetch`, which is the RIGHT seam here: supabase-js
 * converts a transport failure into `{ data: null, error }`, and the
 * `{ data, error }` path is exactly the path this defect lived on.
 */
function injectHistoryFailure(failIdsContaining: string | null): {
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
    if (href.includes(HISTORY_PATH)) {
      seenHistoryUrls.push(decodeURIComponent(href));
      if (failIdsContaining && href.includes(failIdsContaining)) {
        failed += 1;
        return new Response(
          JSON.stringify({
            code: "RK-HISTORY-INJECTED",
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

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render the REAL Records page (default section) to HTML. */
async function renderRecords(): Promise<string> {
  return toHtml(await renderPage({ searchParams: Promise.resolve({}) }));
}

/**
 * Resolve an already-awaited page element to HTML.
 *
 * `renderToStaticMarkup` cannot do this: the Records sections are async
 * components and the synchronous renderer throws "a component suspended while
 * responding to synchronous input" on them. The streaming renderer resolves
 * them, and `onAllReady` waits for the whole tree rather than the shell.
 */
async function toHtml(el: unknown): Promise<string> {
  const { renderToPipeableStream } = await import("react-dom/server");
  const { Writable } = await import("node:stream");
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = renderToPipeableStream(el as never, {
      onAllReady() {
        const sink = new Writable({
          write(c: Buffer, _e: unknown, cb: () => void) {
            chunks.push(Buffer.from(c));
            cb();
          },
          final(cb: () => void) {
            resolve(Buffer.concat(chunks).toString("utf8"));
            cb();
          },
        });
        stream.pipe(sink);
      },
      onError: reject,
    });
  });
}

/** Render the REAL print/export view with history requested. */
async function renderPrintWithHistory(): Promise<string> {
  const el = await renderPrint({
    searchParams: Promise.resolve({ section: "sterile", history: "1" }),
  });
  return toHtml(el);
}

async function seedItems(studioId: string, count: number): Promise<string[]> {
  // The _audit trigger writes one 'created' event per row, so this seeds the
  // records AND their real history through the shipped write path rather than
  // fabricating audit rows.
  await adminQuery(
    `insert into public.record_keeping_sterile_items
       (studio_id, date_purchased, item_description, manufacturer_name, lot_number)
     select $1, current_date - (g % 300), 'Truth pack ' || lpad(g::text, 4, '0'),
            'Truth Supplies', 'LOT' || lpad(g::text, 6, '0')
       from generate_series(1, $2::int) g`,
    [studioId, count],
  );
  const rows = await adminQuery(
    `select id from public.record_keeping_sterile_items
      where studio_id = $1 order by item_description`,
    [studioId],
  );
  return rows.rows.map((r: { id: string }) => r.id);
}

describe("record-keeping audit history — a failed read is never an absence", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const a = await seedStudio(`rkhist-a-${randomUUID().slice(0, 6)}`);
    const b = await seedStudio(`rkhist-b-${randomUUID().slice(0, 6)}`);
    studioA = a.studioId;
    studioB = b.studioId;
    await seedItems(studioA, ITEMS);
    studioBItemIds = await seedItems(studioB, 2);

    // The ids IN THE PAGE'S OWN ORDER (`date_purchased desc, created_at desc`,
    // getSterileItemRecords). Chunk membership follows that order, so a test
    // that wants "the first chunk" has to ask for it the way the page does —
    // ordering these any other way makes the UI cases non-deterministic.
    const ordered = await adminQuery(
      `select id from public.record_keeping_sterile_items
        where studio_id = $1 order by date_purchased desc, created_at desc`,
      [studioA],
    );
    itemIds = ordered.rows.map((r: { id: string }) => r.id);
    expect(itemIds.length).toBe(ITEMS);

    // One studio-A record with its trigger-written history removed, so the
    // suite has a record whose history is genuinely, provably empty. It is the
    // LAST in page order, which puts it in the final chunk and therefore never
    // in the chunk the failure cases doom. Deleting from an append-only table
    // is possible here only because the harness pool connects as the
    // superuser; no application path can do this.
    emptyHistoryItemId = itemIds[itemIds.length - 1];
    await adminQuery(
      `delete from public.record_keeping_audit_events
        where studio_id = $1 and record_id = $2`,
      [studioA, emptyHistoryItemId],
    );

    const email = `rkhist-${randomUUID().slice(0, 8)}@harness.local`;
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

    const mod = await import("@/lib/record-keeping/queries");
    getAuditEventsByRecord = mod.getAuditEventsByRecord;
    AUDIT_HISTORY_ID_CHUNK = mod.AUDIT_HISTORY_ID_CHUNK;
    AUDIT_EVENT_READ_LIMIT = mod.AUDIT_EVENT_READ_LIMIT;
    renderPage = (await import("@/app/(app)/records/page"))
      .default as typeof renderPage;
    renderPrint = (await import("@/app/(app)/records/print/page"))
      .default as typeof renderPrint;
  }, 180_000);

  // ------------------------------------------------------------- baseline
  it("baseline: the healthy read returns real history and reports nothing missing", async () => {
    const out = await getAuditEventsByRecord(studioA, "sterile_item", itemIds);
    // Every record but the deliberately-emptied one has its trigger event.
    expect(out.byRecord.size).toBe(ITEMS - 1);
    expect(out.unavailableRecordIds.size).toBe(0);
    expect(out.byRecord.get(itemIds[0])?.length).toBeGreaterThan(0);
  });

  it("a record that genuinely has no history is EMPTY, not unavailable", async () => {
    const out = await getAuditEventsByRecord(studioA, "sterile_item", itemIds);
    // This is the assertion that stops the fix from buying truthfulness by
    // calling everything unknown: the page must still be ABLE to say
    // "No history recorded yet." when that is the true answer.
    expect(out.byRecord.has(emptyHistoryItemId)).toBe(false);
    expect(out.unavailableRecordIds.has(emptyHistoryItemId)).toBe(false);
  });

  // ------------------------------------------------------ NEGATIVE CONTROL
  it("one chunk fails: only that chunk is UNKNOWN, every other chunk keeps its real events", async () => {
    expect(ITEMS).toBeGreaterThan(AUDIT_HISTORY_ID_CHUNK); // more than one chunk
    const doomed = itemIds.slice(0, AUDIT_HISTORY_ID_CHUNK);
    const survivors = itemIds.slice(AUDIT_HISTORY_ID_CHUNK);

    const gate = injectHistoryFailure(doomed[0]);
    let out: Awaited<ReturnType<typeof getAuditEventsByRecord>>;
    try {
      out = await getAuditEventsByRecord(studioA, "sterile_item", itemIds);
    } finally {
      gate.restore();
    }

    // ANTI-VACUITY: if the seam never fired, everything below would be
    // describing a perfectly healthy read.
    expect(gate.failed()).toBe(1);

    // The failed chunk is UNKNOWN — and crucially NOT empty.
    for (const id of doomed) {
      expect(out.unavailableRecordIds.has(id)).toBe(true);
      expect(out.byRecord.has(id)).toBe(false);
    }
    // The surviving chunks still carry their real events. A fix that marked
    // the whole read unknown on any failure would fail here.
    for (const id of survivors) {
      expect(out.unavailableRecordIds.has(id)).toBe(false);
    }
    expect(out.byRecord.size).toBe(survivors.length - 1); // minus the emptied one
  });

  it("THE UI: a failed chunk never adds an absence claim, and says what happened", async () => {
    const count = (hay: string, needle: string) => hay.split(needle).length - 1;

    // Healthy first, so the failing render is compared against what this page
    // truthfully says rather than against zero.
    const healthy = visibleText(await renderRecords());
    const healthyAbsence = count(healthy, CONFIDENT_ABSENCE);
    // Exactly one record on this page genuinely has no history.
    expect(healthyAbsence).toBe(1);
    expect(count(healthy.toLowerCase(), UNAVAILABLE)).toBe(0);

    const doomed = itemIds.slice(0, AUDIT_HISTORY_ID_CHUNK);
    const gate = injectHistoryFailure(doomed[0]);
    let failingHtml = "";
    try {
      failingHtml = await renderRecords();
    } finally {
      gate.restore();
    }
    // ANTI-VACUITY: exactly one chunk was actually failed.
    expect(gate.failed()).toBe(1);

    const failing = visibleText(failingHtml);
    // THE CLAIM. The number of records asserting "nothing was ever done to me"
    // does NOT grow when a read fails. Before this fix it grew by the size of
    // the failed chunk.
    expect(count(failing, CONFIDENT_ABSENCE)).toBe(healthyAbsence);
    // And the records whose history did not load say so, on screen.
    expect(count(failing.toLowerCase(), UNAVAILABLE)).toBe(
      AUDIT_HISTORY_ID_CHUNK,
    );
  }, 120_000);

  it("THE PRINTED DOCUMENT: an unreadable history prints a line, it does not vanish", async () => {
    const count = (hay: string, needle: string) => hay.split(needle).length - 1;

    // Healthy: the print view lists history and says nothing about failure.
    const healthy = visibleText(await renderPrintWithHistory());
    expect(count(healthy.toLowerCase(), UNAVAILABLE)).toBe(0);
    expect(healthy).toContain("History");

    const doomed = itemIds.slice(0, AUDIT_HISTORY_ID_CHUNK);
    const gate = injectHistoryFailure(doomed[0]);
    let failing = "";
    try {
      failing = visibleText(await renderPrintWithHistory());
    } finally {
      gate.restore();
    }
    expect(gate.failed()).toBe(1);

    // On a printed inspection document an omitted History block is
    // indistinguishable from a record that never had one, so the failure has to
    // be STATED. Before this fix HistoryLines returned null and the block
    // simply disappeared.
    expect(count(failing.toLowerCase(), UNAVAILABLE)).toBe(
      AUDIT_HISTORY_ID_CHUNK,
    );
  }, 120_000);

  // ---------------------------------------------------------- tenant scope
  it("chunking does not widen tenancy: another studio's ids return nothing, and leak nothing", async () => {
    const proof = await adminQuery(
      `select count(*)::int n from public.record_keeping_audit_events
        where studio_id = $1 and record_id = any($2)`,
      [studioB, studioBItemIds],
    );
    // ANTI-VACUITY: those ids really do have history — under studio B.
    expect(proof.rows[0].n).toBeGreaterThan(0);

    seenHistoryUrls.length = 0;
    const gate = injectHistoryFailure(null); // capture only
    let out: Awaited<ReturnType<typeof getAuditEventsByRecord>>;
    try {
      out = await getAuditEventsByRecord(studioA, "sterile_item", studioBItemIds);
    } finally {
      gate.restore();
    }

    expect(out.byRecord.size).toBe(0);
    // Absent rows here are a true absence for THIS studio, not a failure.
    expect(out.unavailableRecordIds.size).toBe(0);

    // Every request the chunked read issued carried the caller's studio filter
    // and the record-type filter, on top of RLS.
    expect(seenHistoryUrls.length).toBeGreaterThan(0);
    for (const url of seenHistoryUrls) {
      expect(url).toContain(`studio_id=eq.${studioA}`);
      expect(url).toContain("record_type=eq.sterile_item");
      expect(url).not.toContain(`studio_id=eq.${studioB}`);
    }
  });

  it("every chunked request carries the studio filter, at full caller size", async () => {
    seenHistoryUrls.length = 0;
    const gate = injectHistoryFailure(null);
    try {
      await getAuditEventsByRecord(studioA, "sterile_item", itemIds);
    } finally {
      gate.restore();
    }
    expect(seenHistoryUrls.length).toBe(
      Math.ceil(ITEMS / AUDIT_HISTORY_ID_CHUNK),
    );
    for (const url of seenHistoryUrls) {
      expect(url).toContain(`studio_id=eq.${studioA}`);
    }
  });

  // ------------------------------------------------------------- the wall
  it("THE THRESHOLD, measured: the gateway refuses an over-long id list with HTTP 414", async () => {
    // Built through URLSearchParams, which is what supabase-js uses: it
    // percent-encodes the separators (`,` -> `%2C`), and that encoding is a
    // third of the per-id cost. A hand-written template literal with raw
    // commas produces a URL ~2 bytes per id SHORTER than the one the app
    // actually sends, which is enough to put this assertion on the wrong side
    // of the wall.
    const url = (n: number) => {
      const qs = new URLSearchParams();
      qs.append("select", "*");
      qs.append("studio_id", `eq.${studioA}`);
      qs.append("record_type", "eq.sterile_item");
      qs.append(
        "record_id",
        `in.(${Array.from(
          { length: n },
          (_, i) => `${String(i).padStart(8, "0")}-1111-4222-8333-444444444444`,
        ).join(",")})`,
      );
      qs.append("order", "created_at.desc");
      qs.append("limit", String(AUDIT_EVENT_READ_LIMIT));
      return `${E2E_SUPABASE_URL}${HISTORY_PATH}?${qs.toString()}`;
    };
    const call = async (n: number) =>
      (
        await fetch(url(n), {
          headers: {
            apikey: E2E_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
          },
        })
      ).status;

    // The wall is a request-line BYTE budget (~8 KiB), which these id counts
    // straddle for this query shape. If a stack ever moves it, this fails and
    // the constant in lib/record-keeping/queries.ts is re-derived rather than
    // trusted.
    expect(await call(205)).toBe(200);
    expect(await call(206)).toBe(414);

    // And the shipped chunk stays far under it.
    expect(await call(AUDIT_HISTORY_ID_CHUNK)).toBe(200);
  }, 60_000);

  // -------------------------------------------------------- truncation rule
  it("a response cut off at the row ceiling leaves its record-less ids UNKNOWN, not empty", async () => {
    // Stays inside studio A: the audit table's RLS scopes SELECT to the
    // caller's studio, so a record seeded into some other studio would return
    // zero rows for reasons that have nothing to do with the ceiling — a
    // passing-for-the-wrong-reason test. A different record_type keeps this
    // completely clear of the sterile_item assertions above.
    await adminQuery(
      `insert into public.record_keeping_disinfectants
         (studio_id, date_prepared, disinfectant_name, concentration)
       values ($1, current_date, 'Truth disinfectant loud', '1%'),
              ($1, current_date, 'Truth disinfectant quiet', '2%')`,
      [studioA],
    );
    const rows = await adminQuery(
      `select id from public.record_keeping_disinfectants
        where studio_id = $1 order by disinfectant_name`,
      [studioA],
    );
    const ids = rows.rows.map((r: { id: string }) => r.id);
    expect(ids.length).toBe(2);
    const [loud, quiet] = ids;

    // Push `quiet`'s trigger event far into the past and give `loud` a full
    // ceiling's worth of NEWER events, so the response is exhausted before
    // `quiet`'s event is reached.
    await adminQuery(
      `update public.record_keeping_audit_events
          set created_at = now() - interval '10 years'
        where studio_id = $1 and record_id = $2`,
      [studioA, quiet],
    );
    await adminQuery(
      `insert into public.record_keeping_audit_events
         (studio_id, record_type, record_id, action, changed_fields, changes, created_at)
       select $1, 'disinfectant', $2, 'updated', array['notes'], '{}'::jsonb,
              now() + (g || ' seconds')::interval
         from generate_series(1, $3::int) g`,
      [studioA, loud, AUDIT_EVENT_READ_LIMIT],
    );

    const out = await getAuditEventsByRecord(studioA, "disinfectant", ids);
    // ANTI-VACUITY: the ceiling really was reached.
    expect(out.byRecord.get(loud)?.length).toBe(AUDIT_EVENT_READ_LIMIT);
    // `quiet` got none from a response that was cut off — indistinguishable
    // from having none, so it may not be rendered as having none.
    expect(out.byRecord.has(quiet)).toBe(false);
    expect(out.unavailableRecordIds.has(quiet)).toBe(true);
  }, 60_000);
});
