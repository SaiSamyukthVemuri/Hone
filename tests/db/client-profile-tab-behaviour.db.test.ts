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
// PERF2 — what a practitioner actually SEES on each Client Profile tab.
//
// The sibling suite (client-profile-tab-queries.db.test.ts) proves which
// QUERIES each tab issues. That is the shape of the optimization. This proves
// the thing the optimization must not break: that the data belonging to a tab
// still reaches the screen.
//
// The REAL page function runs against the LOCAL Supabase stack as a REAL
// signed-in practitioner, and its element tree is rendered by REAL
// react-dom/server. Assertions are on the resulting practitioner-visible text.
// Nothing about React is modelled here — the hand-written renderer that
// preceded this file was deleted precisely because it was a model.
//
// The client is seeded with data on EVERY tab, so "the tab renders its data"
// is a claim about real rows and not about an empty state that happens to
// match. Each tab's rows carry a token unique to that tab, which makes both
// halves of the deferral contract checkable in the same rendered string:
// the owning tab shows the token, and a tab that deferred the read does not.
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

// The browser half of the App Router, which client components call during
// render. Next provides these from router context; this process has no router
// mounted, so they are shimmed exactly as `next/headers` is above. Framework
// plumbing only: no page decision is taken here, and `notFound` keeps its
// meaning as a signal that the page refused to serve the client.
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
  usePathname: () => "/clients/behaviour",
  useParams: () => ({}),
  useSelectedLayoutSegment: () => null,
  notFound: () => {
    throw new NotFoundSignal("notFound");
  },
}));

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

// A token per tab-owned record. Rendered verbatim, so its presence in the
// visible text means the row was read AND displayed, and its absence on
// another tab means that tab did not need it.
const T = {
  pinned: "TOKENPINNEDNOTE",
  personal: "TOKENPERSONALNOTES",
  warning: "TOKENPRIVATEWARNING",
  plan: "TOKENTREATMENTPLAN",
  messageSubject: "TOKENMESSAGESUBJECT",
  messageBody: "TOKENMESSAGEBODY",
  consultation: "TOKENCONSULTNOTE",
  skinHair: "TOKENSKINHAIRNOTE",
  budget: "TOKENBUDGETNOTES",
  goal: "TOKENGOALNOTES",
  lastTreatment: "TOKENLASTTREATMENTAREA",
  reply: "TOKENMESSAGEREPLY",
} as const;

let clientId = "";
let otherStudioClientId = "";
const MISSING_CLIENT_ID = "00000000-0000-4000-8000-000000000000";

let renderPage: (props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) => Promise<unknown>;

function captureTables(): { taken: string[]; restore: () => void } {
  const taken: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes("/rest/v1/")) {
      taken.push(url.replace(E2E_SUPABASE_URL, "").replace("/rest/v1/", "").split("?")[0]!);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return { taken, restore: () => void (globalThis.fetch = realFetch) };
}

/** Tags stripped, entities decoded, whitespace collapsed: what a reader sees. */
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

/** Render one tab of the real page and return what it puts on screen. */
async function seen(tab: string, id = clientId): Promise<string> {
  const el = await renderPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({ tab }),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  return visibleText(renderToStaticMarkup(el as never));
}

const rendered: Record<string, string> = {};

describe("Client Profile — what each tab shows a practitioner", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    const seed = await seedStudio(`perf2b-${randomUUID().slice(0, 6)}`);
    clientId = seed.clientId;
    const { blockId } = await seedSession(seed);
    // Give the charted block an identifiable area, so "the last treatment
    // rendered" is a claim about the block's own data rather than about a
    // heading that is printed whether or not the read ran.
    await adminQuery("update public.session_blocks set primary_area = $2 where id = $1", [
      blockId,
      T.lastTreatment,
    ]);

    const { studioId, practitionerId } = seed;
    // One row per tab, each carrying that tab's token.
    await adminQuery(
      `insert into public.client_pinned_notes (client_id, studio_id, text, created_by_practitioner_id)
       values ($1, $2, $3, $4)`,
      [clientId, studioId, T.pinned, practitionerId],
    );
    await adminQuery(
      `insert into public.client_personal_notes
         (client_id, studio_id, personal_notes, private_warnings, updated_by_practitioner_id)
       values ($1, $2, $3, $4, $5)`,
      [clientId, studioId, T.personal, T.warning, practitionerId],
    );
    await adminQuery(
      `insert into public.treatment_plans
         (client_id, studio_id, name, created_by_practitioner_id, suggested_visit_count)
       values ($1, $2, $3, $4, 12)`,
      [clientId, studioId, T.plan, practitionerId],
    );
    const message = await adminQuery(
      `insert into public.client_portal_messages
         (studio_id, client_id, created_by_practitioner_id, subject, body, status, published_at)
       values ($1, $2, $3, $4, $5, 'published', now())
       returning id`,
      [studioId, clientId, practitionerId, T.messageSubject, T.messageBody],
    );
    await adminQuery(
      `insert into public.client_portal_message_replies
         (studio_id, client_id, message_id, body, created_by)
       values ($1, $2, $3, $4, 'client')`,
      [studioId, clientId, (message.rows[0] as { id: string }).id, T.reply],
    );
    await adminQuery(
      `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body)
       values ($1, $2, $3, 'consultation', $4), ($1, $2, $3, 'skin_hair_analysis', $5)`,
      [clientId, studioId, practitionerId, T.consultation, T.skinHair],
    );
    await adminQuery(
      `insert into public.client_budget_context
         (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
       values ($1, $2, 'somewhat_limited', $3, $4)`,
      [clientId, studioId, T.budget, practitionerId],
    );
    await adminQuery(
      `insert into public.treatment_goals (client_id, studio_id, estimated_total_minutes, notes, created_by)
       values ($1, $2, 4800, $3, $4)`,
      [clientId, studioId, T.goal, practitionerId],
    );
    await adminQuery(
      `insert into public.client_intake_forms
         (studio_id, client_id, status, current_step, responses, started_at, submitted_at)
       values ($1, $2, 'submitted', 5, '{}'::jsonb, now(), now())`,
      [studioId, clientId],
    );

    // A client in a DIFFERENT studio, to prove the page refuses it.
    const other = await seedStudio(`perf2b-other-${randomUUID().slice(0, 6)}`);
    otherStudioClientId = other.clientId;

    // A REAL local GoTrue user with a password. The DB harness inserts auth
    // rows directly, which GoTrue does not own, so the practitioner is
    // repointed at a user the auth service actually knows about.
    const email = `perf2b-${randomUUID().slice(0, 8)}@harness.local`;
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
      [practitionerId, authUser.id, email],
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

    // Every canonical tab is rendered once, here, so the assertions below read
    // as a matrix over the SAME set of renders rather than re-running the page
    // per expectation.
    for (const tab of ALL_TABS) rendered[tab] = await seen(tab);
  }, 120_000);

  it("renders every tab in the product contract", () => {
    expect(Object.keys(rendered).sort()).toEqual([...ALL_TABS].sort());
    // A tab that threw or rendered a stub would not carry the page chrome.
    for (const tab of ALL_TABS) expect(rendered[tab]).toContain("Log session");
  });

  it("shows each tab the data that tab owns", () => {
    expect(rendered.overview).toContain(T.pinned);
    expect(rendered.personal).toContain(T.personal);
    expect(rendered.personal).toContain(T.warning);
    expect(rendered.treatment).toContain(T.plan);
    expect(rendered.messages).toContain(T.messageSubject);
    expect(rendered.messages).toContain(T.messageBody);
    expect(rendered.messages).toContain(T.reply);
    expect(rendered.consultation).toContain(T.consultation);
    expect(rendered.consultation).toContain(T.skinHair);
    expect(rendered.consultation).toContain(T.budget);
    expect(rendered.sessions).toContain(T.goal);
    // Health has no free-text token to carry: the tab renders the intake's
    // STATUS, which is derived from the row this suite seeded as submitted and
    // not yet reviewed.
    expect(rendered.health).toContain("Awaiting review");
  });

  it("keeps Overview's deliberately shared dependencies rendering", () => {
    // Clinical notes serve BOTH the Consultation tab and Overview's briefing.
    expect(rendered.overview).toContain(T.consultation);
    expect(rendered.overview).toContain(T.skinHair);
    // Portal messages serve BOTH the Messages tab and Overview's pending
    // tasks. Overview renders the DERIVED count, not the message body, which
    // is why this asserts the task line rather than a token.
    expect(rendered.overview).toContain("1 unread portal message");
    expect(rendered.overview).not.toContain("No pending portal tasks");
    // The most recent session, which Overview and Sessions both render —
    // under their own headings, which is why this asserts two strings.
    // Both render the LAST TREATMENT itself, so this asserts the charted
    // block's own area rather than the surrounding heading — a heading prints
    // whether or not the read ran, and the area does not.
    expect(rendered.overview).toContain(T.lastTreatment);
    expect(rendered.sessions).toContain(T.lastTreatment);
  });

  it("does not carry a tab's own data onto tabs that defer it", () => {
    // Left of the arrow: whose data. Right: the tabs that must not need it.
    const deferred: Array<[string, string[]]> = [
      [T.personal, ALL_TABS.filter((t) => t !== "personal")],
      [T.warning, ALL_TABS.filter((t) => t !== "personal")],
      [T.plan, ALL_TABS.filter((t) => t !== "treatment")],
      [T.messageSubject, ALL_TABS.filter((t) => t !== "messages")],
      [T.messageBody, ALL_TABS.filter((t) => t !== "messages")],
      [T.budget, ALL_TABS.filter((t) => t !== "consultation")],
      [T.goal, ALL_TABS.filter((t) => t !== "sessions")],
      [T.pinned, ALL_TABS.filter((t) => t !== "overview")],
      [T.reply, ALL_TABS.filter((t) => t !== "messages")],
      // The last treatment serves Overview's briefing and the Sessions tab.
      [T.lastTreatment, ALL_TABS.filter((t) => t !== "overview" && t !== "sessions")],
      // Clinical notes are the documented shared case: Consultation renders
      // them and Overview briefs on them. Nowhere else.
      [T.consultation, ALL_TABS.filter((t) => t !== "consultation" && t !== "overview")],
      [T.skinHair, ALL_TABS.filter((t) => t !== "consultation" && t !== "overview")],
    ];
    for (const [token, tabs] of deferred) {
      for (const tab of tabs) {
        expect(rendered[tab], `${token} must not render on "${tab}"`).not.toContain(token);
      }
    }
  });

  it("shows deferred data as soon as the owning tab is opened", async () => {
    // The deferral is only safe because navigation re-runs the page. Render a
    // tab that defers each token, then its owner, and watch it appear.
    for (const [away, owner, token] of [
      ["overview", "personal", T.personal],
      ["overview", "treatment", T.plan],
      ["overview", "messages", T.messageSubject],
      ["personal", "sessions", T.goal],
      ["personal", "consultation", T.budget],
      ["personal", "messages", T.reply],
      ["personal", "sessions", T.lastTreatment],
    ] as const) {
      expect(await seen(away)).not.toContain(token);
      expect(await seen(owner)).toContain(token);
    }
  }, 120_000);

  it("does no profile work for a client it must not serve", async () => {
    for (const id of [MISSING_CLIENT_ID, otherStudioClientId]) {
      const cap = captureTables();
      let signal = "rendered";
      try {
        await seen("overview", id);
      } catch (err) {
        signal = err instanceof NotFoundSignal ? "notFound" : `threw:${(err as Error).name}`;
      } finally {
        cap.restore();
      }
      expect(signal).toBe("notFound");
      // Identity, then the client lookup that fails — and nothing downstream.
      expect(cap.taken).toEqual(["practitioners", "clients"]);
    }
  }, 60_000);
});
