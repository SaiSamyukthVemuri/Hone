import { expect, test, type APIResponse, type BrowserContext } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import {
  seedClientInStudio,
  seedE2eActiveCardOnFile,
  seedE2eCardOnFileCapability,
  seedE2eDashboardClient,
  seedE2eMember,
  seedE2eStudio,
  seedE2eTodayAppointment,
  setPractitionerActive,
  sql,
  type E2eSeed,
} from "./helpers/seed";

// RBAC Deliverable 2, dimensions 1, 2, 5 and 6 as RUNTIME proofs, with the marker
// method in privacy/RBAC-FORBIDDEN-DATA-MARKERS.md: a unique sentinel in every
// forbidden field, an OWNER positive control on the same fixture and surface, and
// every channel a browser can receive (HTML, the RSC flight payload, the prefetch
// variant). Roles come from real signed-in synthetic sessions, never a flag.
//
// Needs #1309 (owner-only card pill) in the build under test; before it merges the
// practitioner dashboard test is EXPECTED to fail, which is the leak it pins.
// Client-profile spend (G-1) is fixed in #1300 and proved there by Photos.
//
// Opt-in, like the other long matrices: set RBAC_E2E=1. CI green proves nothing
// about this file while it is skipped.
test.skip(process.env.RBAC_E2E !== "1", "opt-in RBAC role-boundary proof; set RBAC_E2E=1");
test.describe.configure({ mode: "serial" });

const PRICE_CENTS = 98765;
const PRICE_SENTINEL = "987.65";

type Seen = { status: number; location: string | null; body: string };
type Channels = { html: Seen; rsc: Seen; prefetch: Seen };

// The router state tree the client sends on a prefetch, for a top-level segment.
const TREE = encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }, null, null, true]));

async function seen(res: APIResponse): Promise<Seen> {
  return { status: res.status(), location: res.headers()["location"] ?? null, body: await res.text() };
}

async function fetchChannels(
  ctx: Pick<BrowserContext, "request">,
  path: string,
): Promise<Channels> {
  const opts = { maxRedirects: 0, failOnStatusCode: false } as const;
  return {
    html: await seen(await ctx.request.get(path, opts)),
    rsc: await seen(await ctx.request.get(path, { ...opts, headers: { RSC: "1" } })),
    prefetch: await seen(
      await ctx.request.get(path, {
        ...opts,
        headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Router-State-Tree": TREE },
      }),
    ),
  };
}

function leaks(ch: Channels, sentinels: string[]): string[] {
  const out: string[] = [];
  for (const [name, r] of Object.entries(ch) as Array<[string, Seen]>) {
    const hay = [r.body, safeDecode(r.body), r.location ?? ""].join("\n");
    for (const s of sentinels) if (hay.includes(s)) out.push(`${name}:${s}`);
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Owner-only pages (matrix section 1). A practitioner must not receive owner data on any channel.
const OWNER_ONLY_PATHS = [
  "/settings/team",
  "/settings/studio",
  "/settings/payments",
  "/settings/services",
  "/settings/booking",
  "/settings/availability",
  "/settings/consent",
  "/settings/data",
  "/settings/import",
  "/settings/integrations",
  "/settings/launch",
  "/settings/machines",
  "/settings/tracking",
  "/settings/waitlist",
  "/dashboard/capacity",
  "/financials",
];

let seed: E2eSeed;
let seedB: E2eSeed;
let otherMember: { email: string };
let member: { email: string; practitionerId: string };
let todayClient: { clientId: string; name: string };
let clientB: { clientId: string; clientName: string };
let ownerCtx: BrowserContext;
let memberCtx: BrowserContext;
let ownerBCtx: BrowserContext;
let memberState: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  seed = await seedE2eStudio();
  seedB = await seedE2eStudio();
  member = await seedE2eMember(seed);
  otherMember = await seedE2eMember(seed); // its email is the TEAM sentinel for `member`
  // PRICE sentinel on the studio price list that owner-only pages render.
  await sql(`update public.services set price_cents = $1 where studio_id = $2`, [PRICE_CENTS, seed.studioId]);
  // A today's visit with a card on file, so the owner dashboard has a pill to find.
  await seedE2eCardOnFileCapability(seed);
  todayClient = await seedE2eDashboardClient(seed, { label: "RBACZZTODAY" });
  await seedE2eTodayAppointment(seed, {
    clientId: todayClient.clientId,
    startsMinutesFromNow: 60,
    endsMinutesFromNow: 120,
    withService: true,
  });
  await seedE2eActiveCardOnFile(seed, todayClient.clientId);
  clientB = await seedClientInStudio(seedB.studioId, "RBACZZSTUDIOB");

  ownerCtx = await browser.newContext();
  memberCtx = await browser.newContext();
  ownerBCtx = await browser.newContext();
  await loginByMagicLink(await ownerCtx.newPage(), seed.ownerEmail);
  await loginByMagicLink(await memberCtx.newPage(), member.email);
  await loginByMagicLink(await ownerBCtx.newPage(), seedB.ownerEmail);
  memberState = await memberCtx.storageState();
});

test.afterAll(async () => {
  await Promise.all([ownerCtx?.close(), memberCtx?.close(), ownerBCtx?.close()]);
});

test("owner positive control: owner-only pages deliver the sentinels to an owner", async () => {
  const services = await fetchChannels(ownerCtx, "/settings/services");
  expect(services.html.status).toBe(200);
  expect(services.html.body).toContain(PRICE_SENTINEL);
  const team = await fetchChannels(ownerCtx, "/settings/team");
  expect(team.html.status).toBe(200);
  expect(team.html.body).toContain(otherMember.email);
  const dash = await fetchChannels(ownerCtx, "/dashboard");
  expect(dash.html.body).toContain("today-card-status");
});

test("practitioner: no owner-only page delivers owner data on HTML, RSC or prefetch", async () => {
  const sentinels = [PRICE_SENTINEL, otherMember.email, "today-card-status"];
  const found: string[] = [];
  for (const path of OWNER_ONLY_PATHS) {
    const ch = await fetchChannels(memberCtx, path);
    for (const l of leaks(ch, sentinels)) found.push(`${path} ${l}`);
    // Never an owner page served as-is: 200 is only acceptable when it carries none of the sentinels (checked above).
  }
  expect(found, `owner data reached a practitioner: ${found.join(", ")}`).toEqual([]);
});

test("practitioner dashboard: no card-on-file pill, no snapshot money (owner control above)", async () => {
  const ch = await fetchChannels(memberCtx, "/dashboard");
  expect(ch.html.status).toBe(200);
  // The practitioner can still see the visit (control that the page rendered at all).
  expect(ch.html.body).toContain(todayClient.name);
  expect(leaks(ch, ["today-card-status", "Card on file", "No card", "Card status unavailable", "Service value", "Practice snapshot"])).toEqual([]);
});

test("cross-studio, both directions: another studio's client never renders", async () => {
  const aSees = await fetchChannels(ownerCtx, `/clients/${clientB.clientId}`);
  expect(leaks(aSees, [clientB.clientName])).toEqual([]);
  const bSeesA = await fetchChannels(ownerBCtx, `/clients/${todayClient.clientId}`);
  expect(leaks(bSeesA, [todayClient.name])).toEqual([]);
  // Control: each owner reaches their own client's page.
  const bOwn = await fetchChannels(ownerBCtx, `/clients/${clientB.clientId}`);
  expect(bOwn.html.status).toBe(200);
  expect(bOwn.html.body).toContain(clientB.clientName);
});

test("revocation: the OLD practitioner cookie is refused at once on HTML, RSC and prefetch", async ({ playwright }) => {
  const baseURL = E2E_APP_ORIGIN;
  const old = await playwright.request.newContext({ baseURL, storageState: memberState });
  const paths = ["/dashboard", "/clients", "/calendar", "/settings/profile"];
  const sentinels = [todayClient.name, otherMember.email];
  const fetchOld = async (path: string): Promise<Channels> => {
    const opts = { maxRedirects: 0, failOnStatusCode: false } as const;
    const mk = async (headers?: Record<string, string>) => seen(await old.get(path, { ...opts, headers }));
    return {
      html: await mk(),
      rsc: await mk({ RSC: "1" }),
      prefetch: await mk({ RSC: "1", "Next-Router-Prefetch": "1", "Next-Router-State-Tree": TREE }),
    };
  };
  try {
    // Control, before revocation: the same cookie reaches the roster.
    const before = await fetchOld("/dashboard");
    expect(before.html.status).toBe(200);
    expect(before.html.body).toContain(todayClient.name);

    await setPractitionerActive(member.practitionerId, false);

    const found: string[] = [];
    for (const path of paths) {
      const ch = await fetchOld(path);
      for (const l of leaks(ch, sentinels)) found.push(`${path} ${l}`);
      for (const [name, r] of Object.entries(ch) as Array<[string, Seen]>) {
        const refused = r.status >= 300 || !r.body.includes("RBACZZTODAY");
        expect(refused, `${path} ${name}: revoked cookie must not be served the app (status ${r.status})`).toBe(true);
      }
    }
    expect(found, `revoked session still received data: ${found.join(", ")}`).toEqual([]);
  } finally {
    await setPractitionerActive(member.practitionerId, true);
    await old.dispose();
  }
});
