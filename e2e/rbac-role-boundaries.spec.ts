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
  seedE2eUnlinkedSession,
  setPractitionerActive,
  setStudioCapacityEnabled,
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
let otherMember: { email: string; practitionerId: string };
let member: { email: string; practitionerId: string };
let todayClient: { clientId: string; name: string };
let clientB: { clientId: string; clientName: string };
let ownerCtx: BrowserContext;
let memberCtx: BrowserContext;
let ownerBCtx: BrowserContext;
let memberState: Awaited<ReturnType<BrowserContext["storageState"]>>;
// Decision 3 fixtures: appointments that have STARTED, in studio A except `bAppt`.
let apptMine: string; // assigned to `member`
let apptTheirs: string; // assigned to `otherMember`
let apptUnassigned: string; // practitioner_id null
let apptForOwner: string; // unassigned, completed by the owner
let apptForRevoked: string; // assigned to `member`, used to prove the OLD cookie cannot complete through the action
let bAppt: string; // studio B
// G-1: a unique price sentinel on a session in studio A.
const SESSION_PRICE_CENTS = 7654321;
const SESSION_PRICE_FORMS = ["7654321", "76543.21", "76,543.21"];
let priceClient: { clientId: string; sessionId: string };
// The captured completion request, replayed with other ids (server-action direct calls).
let template: { url: string; headers: Record<string, string>; body: string; sourceId: string } | null = null;

async function seedStartedAppointment(
  studioId: string,
  clientId: string,
  practitionerId: string | null,
  startedMinutesAgo: number,
): Promise<string> {
  const starts = new Date(Date.now() - startedMinutesAgo * 60_000);
  const ends = new Date(starts.getTime() + 5 * 60_000);
  const rows = await sql<{ id: string }>(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 5, 0, $5, 'confirmed')
     returning id`,
    [studioId, clientId, practitionerId, starts.toISOString(), ends.toISOString()],
  );
  return rows[0]!.id;
}
const statusOf = async (id: string) =>
  (await sql<{ status: string }>(`select status from public.appointments where id = $1`, [id]))[0]!.status;

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

  // Decision 3 fixtures (distinct windows so no overlap rule is in play).
  apptMine = await seedStartedAppointment(seed.studioId, todayClient.clientId, member.practitionerId, 300);
  apptTheirs = await seedStartedAppointment(seed.studioId, todayClient.clientId, otherMember.practitionerId, 240);
  apptUnassigned = await seedStartedAppointment(seed.studioId, todayClient.clientId, null, 180);
  apptForOwner = await seedStartedAppointment(seed.studioId, todayClient.clientId, null, 120);
  apptForRevoked = await seedStartedAppointment(seed.studioId, todayClient.clientId, member.practitionerId, 60);
  const ownerB = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`, [seedB.studioId]))[0]!.id;
  bAppt = await seedStartedAppointment(seedB.studioId, clientB.clientId, ownerB, 30);

  // G-1: a session carrying the price sentinel.
  priceClient = await seedE2eUnlinkedSession(seed);
  await sql(`update public.sessions set price_paid_cents = $1 where id = $2`, [SESSION_PRICE_CENTS, priceClient.sessionId]);

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


test("G-1: a practitioner's client profile and session page carry no session price on any channel (owner control)", async () => {
  const paths = [`/clients/${priceClient.clientId}`, `/clients/${priceClient.clientId}/sessions/${priceClient.sessionId}`];
  const found: string[] = [];
  for (const path of paths) {
    const ch = await fetchChannels(memberCtx, path);
    expect([200, 307, 308]).toContain(ch.html.status);
    for (const l of leaks(ch, SESSION_PRICE_FORMS)) found.push(`${path} ${l}`);
  }
  expect(found, `a session price reached a practitioner: ${found.join(", ")}`).toEqual([]);
  // Control: the OWNER receives the same sentinel on the same surface, so the absence above is not an empty page.
  const owner = await fetchChannels(ownerCtx, paths[0]!);
  expect(owner.html.status).toBe(200);
  expect(leaks(owner, SESSION_PRICE_FORMS).length).toBeGreaterThan(0);
});

test("decision 2: the published service-list price is NOT stripped from a practitioner's booking surface", async () => {
  // The profile's booking card (BookAppointment) renders no price text today, so the observable is the
  // page payload it is handed: a Next client-component prop is serialized into the HTML flight data.
  // Before this fix #1300 selected services without price_cents for a practitioner.
  const ch = await fetchChannels(memberCtx, `/clients/${todayClient.clientId}`);
  expect(ch.html.status).toBe(200);
  expect(ch.html.body).toMatch(new RegExp(`price_cents\\\\*"\\s*:\\s*${PRICE_CENTS}`));
  // Control: the client-finance sentinels are still absent on the same page (the G-1 test above).
  expect(leaks({ html: ch.html, rsc: ch.rsc, prefetch: ch.prefetch }, SESSION_PRICE_FORMS)).toEqual([]);
});

async function openCalendarAppointment(ctx: BrowserContext, id: string) {
  const page = await ctx.newPage();
  await page.goto(`/calendar/${id}`);
  return page;
}
const completeButton = (page: Awaited<ReturnType<typeof openCalendarAppointment>>) =>
  page.getByTestId("mark-appointment-complete");

test("decision 3 (UI): the assignee sees Mark completed and completes; a colleague's and an unassigned one show only the explanation", async () => {
  const theirs = await openCalendarAppointment(memberCtx, apptTheirs);
  await expect(theirs.getByTestId("completion-not-assigned")).toBeVisible();
  await expect(completeButton(theirs)).toHaveCount(0);
  await theirs.close();
  const unassigned = await openCalendarAppointment(memberCtx, apptUnassigned);
  await expect(unassigned.getByTestId("completion-not-assigned")).toBeVisible();
  await expect(completeButton(unassigned)).toHaveCount(0);
  await unassigned.close();

  // The assignee completes through the real UI; capture the real server-action request for replay.
  const mine = await openCalendarAppointment(memberCtx, apptMine);
  mine.on("request", (req) => {
    const h = req.headers();
    if (req.method() === "POST" && h["next-action"] && (req.postData() ?? "").includes(apptMine)) {
      template = { url: req.url(), headers: { "next-action": h["next-action"], "content-type": h["content-type"] ?? "" }, body: req.postData() ?? "", sourceId: apptMine };
    }
  });
  await expect(completeButton(mine)).toBeVisible();
  await completeButton(mine).click();
  // the confirmation dialog's own button is the LAST "Mark completed" in the document
  await mine.getByRole("button", { name: "Mark completed", exact: true }).last().click();
  await expect.poll(() => statusOf(apptMine), { timeout: 15_000 }).toBe("completed");
  expect(template, "the completion server-action request was captured").not.toBeNull();
  await mine.close();

  // Owner control: the owner completes an UNASSIGNED appointment.
  const owner = await openCalendarAppointment(ownerCtx, apptForOwner);
  await expect(owner.getByTestId("completion-not-assigned")).toHaveCount(0);
  await completeButton(owner).click();
  await owner.getByRole("button", { name: "Mark completed", exact: true }).last().click();
  await expect.poll(() => statusOf(apptForOwner), { timeout: 15_000 }).toBe("completed");
  await owner.close();
});

async function replayCompletion(req: { post: (url: string, o: { headers: Record<string, string>; data: string }) => Promise<APIResponse> }, targetId: string): Promise<{ status: number; body: string }> {
  expect(template).not.toBeNull();
  const t = template!;
  const res = await req.post(t.url, { headers: t.headers, data: t.body.split(t.sourceId).join(targetId) });
  return { status: res.status(), body: await res.text() };
}

test("decision 3 (direct server-action calls): the replayed action is refused for a colleague's, an unassigned and another studio's appointment", async () => {
  const before = { theirs: await statusOf(apptTheirs), unassigned: await statusOf(apptUnassigned), b: await statusOf(bAppt) };
  expect(before).toEqual({ theirs: "confirmed", unassigned: "confirmed", b: "confirmed" });
  for (const [name, id] of [["colleague", apptTheirs], ["unassigned", apptUnassigned], ["other studio", bAppt]] as const) {
    const r = await replayCompletion(memberCtx.request, id);
    expect(r.body, `${name}: refusal expected`).toContain("can mark it complete");
    expect(r.body).not.toMatch(/"ok":\s*true/);
  }
  expect({ theirs: await statusOf(apptTheirs), unassigned: await statusOf(apptUnassigned), b: await statusOf(bAppt) }).toEqual(before);
  // The refusals are indistinguishable (nothing about the row is revealed).
  const a = await replayCompletion(memberCtx.request, apptTheirs);
  const b = await replayCompletion(memberCtx.request, bAppt);
  const c = await replayCompletion(memberCtx.request, "00000000-0000-4000-8000-000000000000");
  const norm = (x: string) => x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID");
  expect(norm(a.body)).toBe(norm(b.body));
  expect(norm(a.body)).toBe(norm(c.body));
  // The owner's replay on the other studio's appointment is refused too (cross-studio through the action).
  const ownerCross = await replayCompletion(ownerCtx.request, bAppt);
  expect(ownerCross.body).toContain("can mark it complete");
  expect(await statusOf(bAppt)).toBe("confirmed");
});

// ---- 0277 workflow (Sam 1 Nov): assignment, explicit reassignment and completion in BOTH capacity modes.
// Needs #1320 (picker, check-the-practitioner list) and #1315 (completion gate) in the build under test.

async function seedFutureAppointment(studioId: string, clientId: string, practitionerId: string | null, daysAhead: number): Promise<string> {
  const starts = new Date(Date.now() + daysAhead * 86_400_000);
  starts.setUTCMinutes(0, 0, 0);
  const ends = new Date(starts.getTime() + 30 * 60_000);
  const rows = await sql<{ id: string }>(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 30, 0, $5, 'confirmed')
     returning id`,
    [studioId, clientId, practitionerId, starts.toISOString(), ends.toISOString()],
  );
  return rows[0]!.id;
}

test("capacity OFF: the owner's check list shows a no-practitioner and an owner-assigned visit, changes NOTHING until a row is confirmed, and the change is audited", async ({ browser }) => {
  test.setTimeout(180_000);
  const c = await seedE2eStudio();
  await setStudioCapacityEnabled(c.studioId, false);
  const m = await seedE2eMember(c); // a second ACTIVE practitioner, so an owner-assigned visit is "may be wrong"
  const cli = await seedClientInStudio(c.studioId, "RBACZZCHECK");
  const ownerId = (await sql<{ id: string }>(`select id from public.practitioners where studio_id = $1 and role = 'owner' limit 1`, [c.studioId]))[0]!.id;
  const apptNone = await seedFutureAppointment(c.studioId, cli.clientId, null, 3);
  const apptOwner = await seedFutureAppointment(c.studioId, cli.clientId, ownerId, 4);
  const apptMember = await seedFutureAppointment(c.studioId, cli.clientId, m.practitionerId, 5); // control: not listed
  const snap = async (id: string) =>
    (await sql<{ practitioner_id: string | null; starts_at: string; status: string }>(
      `select practitioner_id, starts_at::text, status from public.appointments where id = $1`, [id]))[0]!;
  const beforeOwner = await snap(apptOwner);
  const beforeMember = await snap(apptMember);

  const ownerC = await browser.newContext();
  const memberC = await browser.newContext();
  try {
    await loginByMagicLink(await ownerC.newPage(), c.ownerEmail);
    await loginByMagicLink(await memberC.newPage(), m.email);

    // A practitioner gets no page at all.
    const mp = await memberC.newPage();
    const denied = await mp.goto("/calendar/check-practitioner");
    expect(denied?.status()).toBe(404);
    await mp.close();

    const page = await ownerC.newPage();
    await page.goto("/calendar/check-practitioner");
    const items = page.getByTestId("check-practitioner-item");
    await expect(items).toHaveCount(2);
    // Merely looking changed nothing.
    expect(await snap(apptOwner)).toEqual(beforeOwner);
    expect((await snap(apptNone)).practitioner_id).toBeNull();

    // Explicit confirmation on the first row (ordered by start): assign the no-practitioner visit to the member.
    const startsBefore = (await snap(apptNone)).starts_at;
    await items.nth(0).getByTestId("check-practitioner-select").selectOption(m.practitionerId);
    await items.nth(0).getByTestId("check-practitioner-confirm").click();
    await expect.poll(async () => (await snap(apptNone)).practitioner_id, { timeout: 15_000 }).toBe(m.practitionerId);
    const after = await snap(apptNone);
    expect(after.starts_at).toBe(startsBefore); // same time
    expect(after.status).toBe("confirmed");
    const audit = await sql<{ n: number }>(
      `select count(*)::int n from public.appointment_audit where appointment_id = $1 and action = 'reassigned'`, [apptNone]);
    expect(audit[0]!.n).toBe(1);
    // The other rows were not touched by that confirmation.
    expect(await snap(apptOwner)).toEqual(beforeOwner);
    expect(await snap(apptMember)).toEqual(beforeMember);
    await page.reload();
    await expect(items).toHaveCount(1);
    await page.close();
  } finally {
    await Promise.all([ownerC.close(), memberC.close()]);
  }
});

for (const capacity of [false, true]) {
  test(`decision 3 with capacity ${capacity ? "ON" : "OFF"}: the assignee completes their own; a colleague's${capacity ? "" : " and an unassigned"} visit ${capacity ? "is" : "are"} refused; the owner completes any`, async ({ browser }) => {
    test.setTimeout(150_000);
    // OFF reuses studio A. ON gets its OWN studio: studio A still holds unassigned confirmed visits, which capacity ON refuses to coexist with.
    let sid = seed.studioId;
    let clientId = todayClient.clientId;
    let mineId = member.practitionerId;
    let theirId = otherMember.practitionerId;
    let oCtx = ownerCtx;
    let mCtx = memberCtx;
    const extra: BrowserContext[] = [];
    if (capacity) {
      const d = await seedE2eStudio();
      await setStudioCapacityEnabled(d.studioId, true);
      const m1 = await seedE2eMember(d);
      const m2 = await seedE2eMember(d);
      const cli = await seedClientInStudio(d.studioId, "RBACZZON");
      sid = d.studioId;
      clientId = cli.clientId;
      mineId = m1.practitionerId;
      theirId = m2.practitionerId;
      oCtx = await browser.newContext();
      mCtx = await browser.newContext();
      extra.push(oCtx, mCtx);
      await loginByMagicLink(await oCtx.newPage(), d.ownerEmail);
      await loginByMagicLink(await mCtx.newPage(), m1.email);
    } else {
      await setStudioCapacityEnabled(sid, false);
    }
    try {
      const base = capacity ? 600 : 500; // distinct windows per mode
      const mine = await seedStartedAppointment(sid, clientId, mineId, base);
      const theirs = await seedStartedAppointment(sid, clientId, theirId, base - 60);
      // Capacity ON cannot hold an unassigned confirmed visit at all (0134 CHECK), so that case exists only in capacity OFF.
      const none = capacity ? null : await seedStartedAppointment(sid, clientId, null, base - 120);
      const others = [theirs, none].filter((x): x is string => !!x);

      for (const id of others) {
        const t = await openCalendarAppointment(mCtx, id);
        await expect(t.getByTestId("completion-not-assigned")).toBeVisible();
        await expect(completeButton(t)).toHaveCount(0);
        await t.close();
      }

      const own = await openCalendarAppointment(mCtx, mine);
      await expect(completeButton(own)).toBeVisible();
      await completeButton(own).click();
      await own.getByRole("button", { name: "Mark completed", exact: true }).last().click();
      await expect.poll(() => statusOf(mine), { timeout: 15_000 }).toBe("completed");
      await own.close();

      // Direct server-action replay (the request captured by the decision-3 case above): refused, nothing changes.
      if (template) {
        for (const id of others) {
          const r = await replayCompletion(mCtx.request, id);
          expect(r.body).toContain("can mark it complete");
        }
      }
      for (const id of others) expect(await statusOf(id)).toBe("confirmed");

      // Owner control: completes the colleague's and, in capacity OFF, the unassigned one.
      for (const id of others) {
        const o = await openCalendarAppointment(oCtx, id);
        await completeButton(o).click();
        await o.getByRole("button", { name: "Mark completed", exact: true }).last().click();
        await expect.poll(() => statusOf(id), { timeout: 15_000 }).toBe("completed");
        await o.close();
      }
    } finally {
      await Promise.all(extra.map((c) => c.close()));
    }
  });
}

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

    // Revocation through the ACTION: the old cookie cannot complete even an appointment assigned to it.
    const replay = await replayCompletion(old, apptForRevoked);
    expect(await statusOf(apptForRevoked), `revoked cookie completed an appointment (${replay.status})`).toBe("confirmed");

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
