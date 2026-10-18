import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, seedSession, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// PERF-02C — failure containment for the overview clinical read wave.
//
// PERF-02C put three mutually independent reads into one Promise.all. A bare
// Promise.all over three throwing promises rejects as a UNIT, which would
// couple two clinical reads whose independent failure is the entire subject of
// CLIN-01-B: one read throwing would blank the other's card, or 500 the page
// on a surface whose whole contract is that it never states an unread
// absence. Containment therefore lives in a `.catch` at each unit's edge.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE SOURCE GUARDS.
// tests/app/clients/clinical-read-truth.test.ts pins the SHAPE of the error
// branches with regexes over the page source. Shape cannot show that a THROWN
// failure — as opposed to a returned `{ error }` — is contained. That needs
// the real page, really failing. This file is that proof.
//
// TWO TRAPS THIS FILE IS BUILT AROUND, both of which produced a green test
// that proved nothing before they were found:
//
//   1. Injecting the fault at `globalThis.fetch` DOES NOT reach the throw
//      path. supabase-js catches every fetch failure and converts it into
//      `{ data: null, error }`, so the unit resolves and the ordinary error
//      branch runs. Those cases are still worth having (they are the
//      `{ data, error }` path) but they are NOT the throw path, and they pass
//      identically with the containment deleted. The throw has to be injected
//      at `createClient()`, which sits inside each unit's await path and is
//      not wrapped by supabase-js.
//
//   2. Matching "the page appears somewhere in the stack" catches the WRONG
//      calls: identity and getClientById also run under the page, but reach
//      createClient through lib/supabase/queries.ts. Only the two
//      session_blocks units call it DIRECTLY from page.tsx, so the immediate
//      caller frame is the discriminator.
//
// Every failing case therefore asserts that the seam actually fired. A seam
// that silently stops matching after a refactor must turn this file RED, not
// quietly reduce it to asserting that a healthy page renders.
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

class NotFoundSignal extends Error {}
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
  usePathname: () => "/clients/containment",
  useParams: () => ({}),
  useSelectedLayoutSegment: () => null,
  notFound: () => {
    throw new NotFoundSignal("notFound");
  },
}));

// The THROW seam. `target` selects which direct-from-page createClient call
// rejects: 1 = the summary unit, 2 = the intelligence unit, -1 = all of them,
// 0 = none. `seen` counts the eligible calls, so a test can prove the seam
// fired rather than passing because nothing was ever injected.
const svcFault = vi.hoisted(() => ({ target: 0, seen: 0 }));
vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createClient: async (...args: unknown[]) => {
      const immediate = (new Error().stack ?? "").split("\n").slice(2)[0] ?? "";
      if (/clients\/\[id\]\/page\.tsx/.test(immediate)) {
        svcFault.seen += 1;
        if (svcFault.target === -1 || svcFault.target === svcFault.seen) {
          throw new TypeError("PERF02C-INJECTED-CLIENT-FAILURE");
        }
      }
      return (actual.createClient as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

// The NOTES seam. The clinical-notes summary is the one unit that must NOT be
// contained: it has no unavailability flag and its card renders under a plain
// `&&`, so swallowing its failure removes the briefing without saying so. Its
// rejection is carried out of the wave and re-raised, and these modes prove the
// re-raise survives rejection values that are themselves falsy.
const notesFault = vi.hoisted(() => ({
  mode: "off" as "off" | "null" | "undefined" | "error",
  seen: 0,
}));
vi.mock("@/lib/clinical-notes/queries", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getClinicalNotesSummary: async (...args: unknown[]) => {
      if (notesFault.mode !== "off") {
        notesFault.seen += 1;
        if (notesFault.mode === "null") return Promise.reject(null);
        if (notesFault.mode === "undefined") return Promise.reject(undefined);
        return Promise.reject(new Error("PERF02C-INJECTED-NOTES-FAILURE"));
      }
      return (
        actual.getClinicalNotesSummary as (...a: unknown[]) => Promise<unknown>
      )(...args);
    },
  };
});

/** The charted area token, rendered verbatim when the summary read succeeded. */
const AREA_TOKEN = "TOKENCONTAINMENTAREA";

/** Copy the surfaces use to refuse to claim absence after a failed read. */
const UNAVAILABLE = "could not be loaded";

/** Statements that would be a clinical LIE after a read that never returned. */
const CONFIDENT_ABSENCE = [
  "No recorded visits yet.",
  "No charted treatment history yet.",
  "No charted treatments yet.",
];

let clientId = "";
let renderPage: (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Render the overview tab of the REAL page and return what it puts on screen.
 *
 * `didThrow` is a FLAG, not a property of the thrown value. `throw null` and
 * `throw undefined` are legal, so a helper that reports the caught value alone
 * cannot tell "did not throw" from "threw null" — which is precisely the defect
 * the notes-rejection cases below exist to catch, and a helper carrying the same
 * ambiguity would report those cases green while the page silently swallowed the
 * failure.
 */
async function renderOverview(): Promise<{
  text: string;
  didThrow: boolean;
  thrown: unknown;
}> {
  try {
    const el = await renderPage({
      params: Promise.resolve({ id: clientId }),
      searchParams: Promise.resolve({ tab: "overview" }),
    });
    const { renderToStaticMarkup } = await import("react-dom/server");
    return {
      text: visibleText(renderToStaticMarkup(el as never)),
      didThrow: false,
      thrown: undefined,
    };
  } catch (e) {
    return { text: "", didThrow: true, thrown: e };
  }
}

/** Fail the two session_blocks reads at the PostgREST layer: the `{ error }` path. */
function injectReadError(target: { summary?: boolean; intel?: boolean }): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/rest/v1/session_blocks")) {
      const dec = decodeURIComponent(url);
      // The two reads are told apart by their select list.
      const hit = dec.includes("sort_order")
        ? target.summary
        : dec.includes("machine_frequency")
          ? target.intel
          : false;
      if (hit) {
        return new Response(
          JSON.stringify({
            code: "PERF02C-INJECTED",
            message: "injected read failure",
            details: null,
            hint: null,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => void (globalThis.fetch = realFetch);
}

describe("PERF-02C — one clinical read failing cannot take down the wave", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const seed = await seedStudio(`perf02c-${randomUUID().slice(0, 6)}`);
    clientId = seed.clientId;
    const { blockId } = await seedSession(seed);
    // An identifiable charted area, so "the summary read's data reached the
    // screen" is a claim about a real row rather than about a heading that
    // prints either way.
    await adminQuery("update public.session_blocks set primary_area = $2 where id = $1", [
      blockId,
      AREA_TOKEN,
    ]);

    const email = `perf02c-${randomUUID().slice(0, 8)}@harness.local`;
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

    renderPage = (await import("@/app/(app)/clients/[id]/page")).default as typeof renderPage;
  }, 120_000);

  // ---------------------------------------------------------------- baseline
  // Without this, every assertion below could be satisfied by a page that
  // renders nothing at all.
  it("baseline: an undisturbed overview shows its real charted data", async () => {
    const { text, didThrow } = await renderOverview();
    expect(didThrow).toBe(false);
    expect(text).toContain(AREA_TOKEN);
    expect(text.toLowerCase()).not.toContain(UNAVAILABLE);
  });

  // ------------------------------------------------- the `{ data, error }` path
  it("summary read returns an error alone: intelligence still shows real data", async () => {
    const restore = injectReadError({ summary: true });
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      restore();
    }
    expect(out.didThrow).toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    // The sibling read was untouched, so its rows must still be on screen.
    expect(out.text).toContain(AREA_TOKEN);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  it("intelligence read returns an error alone: last visit still shows real data", async () => {
    const restore = injectReadError({ intel: true });
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      restore();
    }
    expect(out.didThrow).toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    expect(out.text).toContain(AREA_TOKEN);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  it("both reads return errors: two unavailable states, no confident absence", async () => {
    const restore = injectReadError({ summary: true, intel: true });
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      restore();
    }
    expect(out.didThrow).toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  // ------------------------------------------------------------- the THROW path
  // These are the cases the source guards cannot reach and the fetch-level
  // injection above cannot produce. They fail if the `.catch` at either unit's
  // edge is removed.
  it("summary unit REJECTS: the page still renders and the sibling read survives", async () => {
    svcFault.target = 1;
    svcFault.seen = 0;
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      svcFault.target = 0;
    }
    expect(
      svcFault.seen,
      "the throw seam never fired: no createClient call was attributed to the page, so this case proved nothing",
    ).toBeGreaterThan(0);
    expect(out.didThrow, "a rejecting unit took the whole page down").toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    expect(out.text).toContain(AREA_TOKEN);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  it("intelligence unit REJECTS: the page still renders and the sibling read survives", async () => {
    svcFault.target = 2;
    svcFault.seen = 0;
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      svcFault.target = 0;
    }
    expect(svcFault.seen, "the throw seam never fired").toBeGreaterThan(1);
    expect(out.didThrow, "a rejecting unit took the whole page down").toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    // The summary read was untouched, so the charted area must survive.
    expect(out.text).toContain(AREA_TOKEN);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  it("both units REJECT: still contained, and still no confident absence", async () => {
    svcFault.target = -1;
    svcFault.seen = 0;
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      svcFault.target = 0;
    }
    expect(svcFault.seen, "the throw seam never fired").toBeGreaterThan(0);
    expect(out.didThrow, "two rejecting units took the page down").toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  // ------------------------------------- the notes summary must FAIL LOUD
  // Codex review of PR #659, P2. The rejection used to be tracked by its own
  // VALUE (`notesSummaryThrown !== null && !== undefined`). `throw null` and
  // `throw undefined` are legal, so those two rejections were recorded and then
  // skipped by the rethrow condition — the page rendered, the briefing card
  // silently vanished under its `&&`, and a practitioner saw an absence nobody
  // had read. Tracking is now a dedicated boolean, and these cases pin that.
  //
  // "Fails loud" is asserted with the didThrow FLAG, never with the thrown
  // value: the value is exactly what cannot be trusted here.
  for (const [label, mode, expected] of [
    ["null", "null", null],
    ["undefined", "undefined", undefined],
  ] as const) {
    it(`notes summary rejects with ${label}: the page still fails loudly`, async () => {
      notesFault.mode = mode;
      notesFault.seen = 0;
      let out: Awaited<ReturnType<typeof renderOverview>>;
      try {
        out = await renderOverview();
      } finally {
        notesFault.mode = "off";
      }
      expect(notesFault.seen, "the notes seam never fired").toBeGreaterThan(0);
      expect(
        out.didThrow,
        `a ${label} rejection was swallowed: the page rendered without the clinical briefing and said nothing`,
      ).toBe(true);
      // The original rejection value is re-raised unchanged, not replaced.
      expect(out.thrown).toBe(expected);
    });
  }

  it("notes summary rejects with an ordinary Error: the page still fails loudly", async () => {
    notesFault.mode = "error";
    notesFault.seen = 0;
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      notesFault.mode = "off";
    }
    expect(notesFault.seen).toBeGreaterThan(0);
    expect(out.didThrow).toBe(true);
    expect((out.thrown as Error)?.message).toBe("PERF02C-INJECTED-NOTES-FAILURE");
  });

  it("a null notes rejection still fails loudly when a sibling read ALSO failed", async () => {
    // The sibling is contained and the notes rejection is not, so the notes
    // failure must still reach the caller rather than being masked by a
    // sibling that handled itself.
    notesFault.mode = "null";
    notesFault.seen = 0;
    const restore = injectReadError({ summary: true });
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      restore();
      notesFault.mode = "off";
    }
    expect(notesFault.seen).toBeGreaterThan(0);
    expect(out.didThrow, "a contained sibling masked the notes rejection").toBe(true);
    expect(out.thrown).toBe(null);
  });

  it("the sibling block reads stay independently contained while notes is healthy", async () => {
    // Guards the other direction: the notes fix must not have made the two
    // session_blocks units fail loud too. Both reject; the page still renders.
    svcFault.target = -1;
    svcFault.seen = 0;
    let out: Awaited<ReturnType<typeof renderOverview>>;
    try {
      out = await renderOverview();
    } finally {
      svcFault.target = 0;
    }
    expect(svcFault.seen).toBeGreaterThan(0);
    expect(out.didThrow, "the notes fix leaked fail-loud onto the block reads").toBe(false);
    expect(out.text.toLowerCase()).toContain(UNAVAILABLE);
    for (const claim of CONFIDENT_ABSENCE) expect(out.text).not.toContain(claim);
  });

  it("recovers: the next render after a contained failure is healthy again", async () => {
    const { text, didThrow } = await renderOverview();
    expect(didThrow).toBe(false);
    expect(text).toContain(AREA_TOKEN);
    expect(text.toLowerCase()).not.toContain(UNAVAILABLE);
  });
});
