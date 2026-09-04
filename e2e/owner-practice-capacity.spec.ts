import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import { E2E_APP_ORIGIN } from "./helpers/local-env";
import {
  getOwnerPractitionerId,
  seedE2eMember,
  seedE2eStudio,
  sql,
  type E2eSeed,
} from "./helpers/seed";

// ===========================================================================
// OWNER-CAP Slice 1 — /dashboard/capacity through a real browser
// ===========================================================================
//
// The deferred coverage for the capacity briefing. Its unit and DB suites
// already prove the derivations and the read soundness; what only a browser can
// prove is that an owner actually REACHES the page through every discovery
// surface (the permanent Business nav entry, search and the dashboard CTA),
// that an ordinary practitioner gets neither the aggregate nor any entry point,
// and that the rebooking names are real links landing on the right client.
//
// THE NAVIGATION SECTION AT THE FOOT OF THIS FILE is the owner's PERMANENT
// entry point, and it lives here rather than in a new spec because it is the
// same question this file already answers three times over — who can reach
// /dashboard/capacity, and by which route. The three surfaces are
// complementary: the nav is always there, the CTA is contextual, search is
// recall. Each is asserted through a locator scoped to its own surface, so no
// two of them can stand in for one another.
//
// THE POPULATION SEEDED HERE IS THE ONE SLICE 1 DEFINES: a current
// (non-archived) client with an OPEN treatment plan and no future TREATMENT
// appointment. Each of the four cases below is one axis of that definition,
// two qualifying and two excluded for DIFFERENT reasons:
//
//   Rebook Rita   open plan, nothing booked          -> on the list
//   Consult Cara  open plan, future CONSULTATION     -> on the list (a
//                                                       consultation is not
//                                                       treatment)
//   Booked Bella  open plan, future TREATMENT        -> NOT on the list
//   Noplan Nadia  NO plan, nothing booked            -> NOT on the list
//
// NADIA IS LOAD-BEARING, and an earlier revision of this spec did not seed her.
// It claimed the studio seed provided a plan-less client; `seedE2eStudio()`
// computes a client name but never inserts the row, so no such client existed.
// Without her, the open-plan requirement is not proved at all: Bella is already
// excluded by her appointment, so a build that ignored plan eligibility
// entirely would still leave exactly Rita and Cara on the list and every
// assertion here would pass for the wrong reason.
//
// SAFETY: fresh synthetic studios on the LOCAL stack. Never Willow. This spec
// only reads through the UI; the only writes are its own seed rows.

test.describe.configure({ mode: "serial" });

const REBOOK = `Rebook Rita ${randomUUID().slice(0, 6)}`;
const CONSULT = `Consult Cara ${randomUUID().slice(0, 6)}`;
const BOOKED = `Booked Bella ${randomUUID().slice(0, 6)}`;
const NOPLAN = `Noplan Nadia ${randomUUID().slice(0, 6)}`;

let seed: E2eSeed;
let member: { email: string; displayName: string; practitionerId: string };
let rebookClientId: string;
let consultClientId: string;
let bookedClientId: string;
let noplanClientId: string;
/** A second studio that keeps NO treatment plans — the fail-closed fixture. */
let planless: E2eSeed;
/** A third studio whose owner identity is as WIDE as the header ever draws it. */
let wide: E2eSeed;

/**
 * The product's own card container: SectionLabel renders the label as an <h3>
 * that is a DIRECT child of the card div, so the heading's parent IS the card.
 * Scoping this way binds an assertion to one named card rather than to a grid
 * ancestor that happens to contain it.
 */
const cardFor = (page: Page, label: string) =>
  page.getByRole("heading", { name: label, exact: true }).locator("..");

/**
 * The numeric figure inside a card. `Figure` renders exactly this element when
 * a value is KNOWN and renders NO such element when it is unknown, so its
 * presence/absence is itself the known/unknown distinction.
 */
const figureIn = (card: Locator) => card.locator("p.tabular-nums");

/**
 * The rebooking list container. Same one-hop rule as `cardFor`: the "Who to
 * rebook" label is an <h3> rendered as a direct child of the list's own div.
 *
 * Membership assertions are scoped through this rather than through the page,
 * because "there is a link with this name SOMEWHERE" is a weaker claim than
 * "this client is on the rebooking list" — and it is the latter that every test
 * here is actually about.
 */
const worklistOf = (page: Page) =>
  page.getByRole("heading", { name: "Who to rebook", exact: true }).locator("..");

/**
 * THE DESKTOP PRIMARY NAVIGATION, by its own accessible name.
 *
 * Every navigation assertion in this file is scoped through this (or through
 * `mobileNav`) rather than through the page, and that is the whole point. Two
 * OTHER surfaces on the dashboard link the very same route — the "Practice
 * capacity" CTA in <main> and the Global Search result — so a page-wide
 * locator for that href would be satisfied by either while the nav entry was
 * missing entirely. Naming the landmark also beats `header nav` positionally:
 * position is not what the test is about.
 */
const primaryNav = (page: Page) =>
  page.getByRole("navigation", { name: "Primary navigation" });

/** The phone sheet. Only rendered while the Menu is open. */
const mobileNav = (page: Page) =>
  page.getByRole("navigation", { name: "Mobile navigation" });

/**
 * The working-surface links of the mobile sheet: its DIRECT <a> children.
 *
 * Settings / Getting Started / Switch studio / Admin live one level deeper,
 * inside the account section's own div below the divider, so "is a direct
 * child" IS "is in the working-surface section" — which is where the product
 * decision says Business belongs.
 */
const mobileWorkingSurfaces = (page: Page) =>
  mobileNav(page).locator("xpath=./a");

/** Below Tailwind's `lg`: the desktop row is display:none, the Menu is the nav. */
const PHONE = { width: 390, height: 844 };

/**
 * THE HEADER-MODE BOUNDARY. Four classes in the shell switch together at `lg`
 * (layout.tsx: primary nav, desktop controls, compact controls; MobileMenu:
 * its root), so 1023px is wholly compact and 1024px wholly desktop.
 *
 * MEASURED, which is why the boundary moved off `md`: five primary items plus
 * search/bell/account need 830px with an ordinary owner name and 913px with one
 * that fills the account button's 12ch cap. At md that overflowed the page by
 * up to 145px across 768-1023 and failed the iPad no-overflow guard in
 * mobile-ux.spec.ts. At 1024 both identities fit with room to spare.
 */
const DESKTOP_FROM = 1024;

/**
 * Every width the contract names. 767/768 and 1023/1024 are deliberately
 * adjacent pairs: a boundary is only proved by the two widths that straddle it,
 * and 768 is where the OLD boundary sat, so it is the one most likely to be
 * left behind by a partial edit.
 */
const WIDTHS = [375, 430, 767, 768, 810, 859, 912, 1023, 1024, 1100, 1280];

/**
 * The ENTIRE responsive contract at ONE width, for whichever role is signed in.
 *
 * Both mode assertions run at every width rather than only the one expected to
 * hold, so the two failure shapes the mode switch can produce fail HERE and by
 * name: a dead zone (neither shell present) and a double (both present at
 * once). Checking only the expected shell would see neither.
 */
async function assertShellAt(
  page: Page,
  width: number,
  opts: { owner: boolean },
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const at = `${width}px`;
  const desktop = width >= DESKTOP_FROM;

  const nav = primaryNav(page);
  const menuButton = page.getByRole("button", { name: "Open navigation menu" });
  const bell = page.getByRole("link", { name: /^Notifications/ });
  const searchInput = page.getByRole("searchbox", { name: "Search Hone" });
  const searchButton = page.getByRole("button", { name: "Search Hone" });
  const accountButton = page.getByRole("button", { name: "Open account menu" });

  // (1) EXACTLY ONE SHELL.
  await expect(nav, `${at}: desktop primary nav`).toHaveCount(desktop ? 1 : 0);
  await expect(menuButton, `${at}: compact Menu button`).toHaveCount(
    desktop ? 0 : 1,
  );

  // (2) NO CONTROL DISAPPEARS AT ANY WIDTH. Search and Notifications exist in
  // both shells — search as an input on desktop and as a button that opens the
  // sheet when compact. The account ACTIONS move into the Menu when compact;
  // that is the pre-existing design, and it is asserted below rather than
  // assumed, because "the account menu vanished on tablets" is exactly the
  // regression a breakpoint move can cause.
  await expect(bell, `${at}: notifications bell`).toHaveCount(1);
  await expect(searchInput, `${at}: desktop search input`).toHaveCount(
    desktop ? 1 : 0,
  );
  await expect(searchButton, `${at}: compact search button`).toHaveCount(
    desktop ? 0 : 1,
  );
  await expect(accountButton, `${at}: desktop account button`).toHaveCount(
    desktop ? 1 : 0,
  );

  // (3) NO HORIZONTAL PAGE OVERFLOW. The PR #228 regression, and the reason
  // this boundary is at lg.
  const doc = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    doc.scroll,
    `${at}: page must not scroll horizontally (scrollWidth ${doc.scroll} vs clientWidth ${doc.client})`,
  ).toBeLessThanOrEqual(doc.client);

  if (desktop) {
    // (4) FIVE ITEMS, ONE LINE, NO COLLISION.
    const items = nav.getByRole("link");
    await expect(items, `${at}: the primary row`).toHaveText(
      opts.owner
        ? ["Dashboard", "Clients", "Calendar", "Records", "Business"]
        : ["Dashboard", "Clients", "Calendar", "Records"],
    );
    const boxes = await items.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height, right: r.right };
      }),
    );
    const first = boxes[0]!;
    for (const [i, b] of boxes.entries()) {
      expect(b.top, `${at}: item ${i} shares the row's top edge`).toBeCloseTo(
        first.top,
        1,
      );
      expect(b.height, `${at}: item ${i} shares the row's height`).toBeCloseTo(
        first.height,
        1,
      );
    }
    // The row ends before the right-hand controls begin. Overflow alone cannot
    // see this: the page can stay exactly as wide as the viewport while two
    // header children sit on top of one another.
    const rowEnd = Math.max(...boxes.map((b) => b.right));
    for (const [label, control] of [
      ["global search", searchInput],
      ["notifications bell", bell],
      ["account menu", accountButton],
    ] as const) {
      const box = (await control.boundingBox())!;
      expect(
        rowEnd,
        `${at}: the primary row must end before the ${label} begins`,
      ).toBeLessThanOrEqual(box.x + 0.5);
    }
    // The compact sheet is not merely hidden — it is not mounted.
    await expect(mobileNav(page), `${at}: no compact sheet`).toHaveCount(0);
    return;
  }

  // (5) COMPACT: every header control keeps its 44px target...
  for (const [label, control] of [
    ["Menu button", menuButton],
    ["search button", searchButton],
    ["notifications bell", bell],
  ] as const) {
    const box = (await control.boundingBox())!;
    expect(box.height, `${at}: ${label} keeps a 44px target`).toBeGreaterThanOrEqual(44);
  }

  // ...and the Menu carries the working surfaces, the account actions, and —
  // for an owner only — Business.
  await menuButton.click();
  const sheet = mobileNav(page);
  await expect(sheet, `${at}: the Menu opens`).toBeVisible();
  await expect(mobileWorkingSurfaces(page), `${at}: working surfaces`).toHaveText(
    opts.owner
      ? ["Dashboard", "Clients", "Calendar", "Records", "Business"]
      : ["Dashboard", "Clients", "Calendar", "Records"],
  );
  await expect(
    sheet.getByRole("link", { name: "Business", exact: true }),
    `${at}: Business is owner-only`,
  ).toHaveCount(opts.owner ? 1 : 0);
  // RETARGETED BY FIN-01A. The Business entry points at /business now, not
  // straight at capacity: capacity was the only owner surface when this was
  // written, and Financials made it two. Capacity is reached THROUGH Business,
  // via the shared subnav, so the menu must no longer link it directly.
  await expect(sheet.locator('a[href="/business"]')).toHaveCount(
    opts.owner ? 1 : 0,
  );
  await expect(sheet.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
  // The account actions the desktop button would have offered.
  await expect(
    sheet.getByRole("link", { name: "Settings" }),
    `${at}: Settings still reachable`,
  ).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: "Sign out" }),
    `${at}: Sign out still reachable`,
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet, `${at}: the Menu closes again`).toHaveCount(0);
}

async function newClient(studioId: string, name: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `insert into public.clients (id, studio_id, name)
     values (gen_random_uuid(), $1, $2) returning id`,
    [studioId, name],
  );
  return rows[0]!.id;
}

async function openPlan(studioId: string, clientId: string): Promise<void> {
  await sql(
    `insert into public.treatment_plans
       (studio_id, client_id, name, suggested_visit_count, status)
     values ($1, $2, 'E2E plan', 6, 'active')`,
    [studioId, clientId],
  );
}

/**
 * A service with an EXPLICIT modality. The studio seed's own service is a
 * consultation, and `isConsultationService` also falls back to the NAME when
 * modality is blank — so a treatment service has to be created deliberately or
 * the distinction this spec exists to prove would not exist in the fixture.
 */
async function newService(
  studioId: string,
  name: string,
  modality: "laser" | "consultation",
): Promise<string> {
  const rows = await sql<{ id: string }>(
    `insert into public.services
       (id, studio_id, name, modality, default_duration_minutes, price_cents, active)
     values (gen_random_uuid(), $1, $2, $3, 60, 0, true) returning id`,
    [studioId, name, modality],
  );
  return rows[0]!.id;
}

/**
 * A confirmed appointment WITH a service, `daysOut` days ahead.
 *
 * The offset is a parameter because the studio carries a studio-wide
 * no-overlap exclusion constraint: two fixture appointments at the same instant
 * are rejected by the real schema, exactly as they would be in production.
 */
async function seedFutureWithService(
  studioId: string,
  practitionerId: string,
  clientId: string,
  serviceId: string,
  daysOut: number,
): Promise<void> {
  await sql(
    `insert into public.appointments
       (id, studio_id, client_id, practitioner_id, service_id, starts_at, ends_at,
        duration_minutes, buffer_minutes_snapshot, blocked_ends_at, status)
     values (gen_random_uuid(), $1, $2, $3, $4,
             now() + ($5 || ' days')::interval,
             now() + ($5 || ' days')::interval + interval '60 min',
             60, 0, now() + ($5 || ' days')::interval + interval '60 min', 'confirmed')`,
    [studioId, clientId, practitionerId, serviceId, String(daysOut)],
  );
}

test.beforeAll(async () => {
  seed = await seedE2eStudio();
  member = await seedE2eMember(seed);
  const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);

  const treatment = await newService(seed.studioId, `E2E Laser ${seed.runId}`, "laser");
  const consultation = await newService(
    seed.studioId,
    `E2E Consult ${seed.runId}`,
    "consultation",
  );

  // Open plan, nothing on the calendar. THE number this page exists to produce.
  rebookClientId = await newClient(seed.studioId, REBOOK);
  await openPlan(seed.studioId, rebookClientId);

  // Open plan, a future CONSULTATION and no treatment. Still needs booking.
  consultClientId = await newClient(seed.studioId, CONSULT);
  await openPlan(seed.studioId, consultClientId);
  await seedFutureWithService(
    seed.studioId,
    ownerPractitionerId,
    consultClientId,
    consultation,
    7,
  );

  // Open plan and a future TREATMENT. The control.
  bookedClientId = await newClient(seed.studioId, BOOKED);
  await openPlan(seed.studioId, bookedClientId);
  await seedFutureWithService(
    seed.studioId,
    ownerPractitionerId,
    bookedClientId,
    treatment,
    9,
  );

  // Current, non-archived, and NO treatment plan — deliberately no openPlan()
  // call. She is the control that makes the open-plan requirement falsifiable.
  noplanClientId = await newClient(seed.studioId, NOPLAN);

  // A studio that records NO treatment plans at all.
  planless = await seedE2eStudio();

  // THE WORST CASE FOR HEADER FIT, which the default seed is not.
  //
  // The only identity text in the header row is the account button's first
  // name, capped by `max-w-[12ch]`. Every seeded owner is "E2E Owner <id>",
  // whose first token is THREE characters — the narrowest that button ever
  // gets. Measuring a fifth nav item against that would flatter it. This owner
  // is a single long token, so the button renders at its full 12ch cap and the
  // responsive sweep measures the tightest header the product can produce.
  wide = await seedE2eStudio();
  await sql(
    `update public.practitioners set display_name = $1
      where studio_id = $2 and role = 'owner'`,
    ["Wilhelmina-Konstantina", wide.studioId],
  );
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

test("an owner reaches the capacity briefing", async ({ page }) => {
  expect(E2E_APP_ORIGIN).toMatch(/^https?:\/\/(localhost|127\.0\.0\.1)/);
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();
  // The Slice-1 briefing, by its own section headings.
  await expect(
    page.getByRole("heading", { name: "Clients", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Future treatment booking depth" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Future treatment time for current clients" }),
  ).toBeVisible();
});

test("an ordinary practitioner is refused the owner aggregate", async ({ page }) => {
  await loginByMagicLink(page, member.email);
  await page.goto("/dashboard/capacity");

  // The CURRENT product contract: the page renders a refusal in place. It does
  // not redirect, and this spec asserts what the product does rather than what
  // a reader might assume it does.
  await expect(
    page.getByText("Only studio owners can see practice capacity."),
  ).toBeVisible();

  // AND NONE OF THE AGGREGATE REACHES THEM — all THREE sections, not one.
  //
  // This is the authority test, and it previously checked a single section
  // heading. A gate regression that rendered the refusal banner AND leaked the
  // Clients cards beneath it would have passed while the test's name claimed
  // the whole aggregate was refused. A partial leak is precisely what this test
  // exists to catch.
  for (const section of [
    "Clients",
    "Future treatment booking depth",
    "Future treatment time for current clients",
  ]) {
    await expect(
      page.getByRole("heading", { name: section, exact: true }),
      `the ${section} section must not reach a practitioner`,
    ).toHaveCount(0);
  }

  // Not one aggregate FIGURE either. `Figure` renders this element for every
  // known value on the briefing, so zero of them is the strongest single
  // statement that no number leaked — including from a card whose heading was
  // renamed.
  await expect(page.locator("p.tabular-nums")).toHaveCount(0);

  // And no client identity: not the worklist, not ANY seeded name, not a record
  // link. All four names, as TEXT — a leak that rendered a client as plain text
  // rather than as a link would otherwise satisfy the link check while the
  // comment claimed no identity reached them at all.
  await expect(page.getByText("Who to rebook")).toHaveCount(0);
  for (const name of [REBOOK, CONSULT, BOOKED, NOPLAN]) {
    await expect(page.getByText(name), `${name} must not reach a practitioner`).toHaveCount(0);
  }
  await expect(page.locator('a[href^="/clients/"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The rebooking worklist
// ---------------------------------------------------------------------------

test("the worklist names who to rebook, and the name opens that client", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  await expect(page.getByRole("heading", { name: "Who to rebook" })).toBeVisible();
  const link = worklistOf(page).getByRole("link", { name: REBOOK });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", `/clients/${rebookClientId}`);

  // Follow it, and prove it lands on the RIGHT client rather than merely a
  // client page.
  await link.click();
  await page.waitForURL(`**/clients/${rebookClientId}**`);
  await expect(page.getByRole("heading", { name: REBOOK })).toBeVisible();
});

test("a CONSULTATION-only client is still on the rebooking list", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  // Something IS booked for this client — it is simply not treatment, which is
  // exactly why they still need a treatment appointment. Scoped to the
  // worklist: a link bearing this name anywhere on the page would not have
  // proved membership of the rebooking list.
  const consultLink = worklistOf(page).getByRole("link", { name: CONSULT });
  await expect(consultLink).toBeVisible();
  // Pinned to the right client, for the same reason the rebook link is: a
  // visible name proves membership, not that the row is actionable.
  await expect(consultLink).toHaveAttribute("href", `/clients/${consultClientId}`);

  // ...and the page never describes this population as having nothing booked.
  await expect(page.getByText(/nothing booked/i)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No treatment booked", exact: true }),
  ).toBeVisible();
});

test("a client with a future TREATMENT is not on the rebooking list", async ({ page }) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  await expect(page.getByRole("heading", { name: "Who to rebook" })).toBeVisible();
  // The claim the title makes: absent from the LIST.
  await expect(worklistOf(page).getByRole("link", { name: BOOKED })).toHaveCount(0);
  // And absent from the page entirely — as TEXT, not merely as a link. The
  // link-only check was labelled "strictly stronger" and was not: a worklist
  // that regressed to rendering her name as plain text would have satisfied
  // both link counts.
  await expect(page.getByRole("link", { name: BOOKED })).toHaveCount(0);
  await expect(page.getByText(BOOKED)).toHaveCount(0);

  // ABSENCE IS ONLY MEANINGFUL IF SHE EXISTS. An unseeded client is absent from
  // the worklist too, so this test would pass on a broken fixture — the exact
  // failure that hid the missing no-plan control. Nadia already carries this
  // proof; Bella now does as well.
  await page.goto(`/clients/${bookedClientId}`);
  await expect(page.getByRole("heading", { name: BOOKED })).toBeVisible();
});

test("the worklist holds exactly the qualifying clients, and matches its own count", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.goto("/dashboard/capacity");

  const worklist = page.getByRole("heading", { name: "Who to rebook" }).locator("..");

  // Included: an open plan and no future TREATMENT.
  await expect(worklist.getByRole("link", { name: REBOOK })).toHaveAttribute(
    "href",
    `/clients/${rebookClientId}`,
  );
  await expect(worklist.getByRole("link", { name: CONSULT })).toHaveAttribute(
    "href",
    `/clients/${consultClientId}`,
  );

  // Excluded for two DIFFERENT reasons, which is the point of having both:
  // Bella has treatment booked; Nadia has no open plan at all.
  await expect(worklist.getByRole("link", { name: BOOKED })).toHaveCount(0);
  await expect(worklist.getByRole("link", { name: NOPLAN })).toHaveCount(0);
  // Nadia is genuinely in the studio and genuinely current — her absence is a
  // decision about plan evidence, not a missing fixture row.
  await page.goto(`/clients/${noplanClientId}`);
  await expect(page.getByRole("heading", { name: NOPLAN })).toBeVisible();

  // And the rendered list is exactly as long as the figure above it claims.
  //
  // BOUND TO ONE EXACT CARD. An earlier revision matched /^No treatment booked/
  // with `page.locator("div").first()`, which is the booking-depth ZERO BAND
  // rather than the client card above the list — and a bare `div` ancestor can
  // resolve to the whole grid, so a matching digit in any depth card satisfied
  // it. This scopes to the client card by its own heading, then to that card's
  // own figure element, and asserts exact equality with the link count.
  await page.goto("/dashboard/capacity");
  const rendered = await page.locator('a[href^="/clients/"]').count();
  expect(rendered).toBe(2);

  const countCard = cardFor(page, "No future treatment booked");
  // Its note is unique to the CLIENT card; the depth band carries none. This
  // pins that the assertion below is reading the intended card.
  await expect(countCard).toContainText(
    "Active treatment clients with no upcoming treatment appointment",
  );
  await expect(figureIn(countCard)).toHaveText(String(rendered));
});

// ---------------------------------------------------------------------------
// Fail-closed presentation
// ---------------------------------------------------------------------------

test("a studio with no treatment plans suppresses the six plan-dependent figures, and offers no list", async ({
  page,
}) => {
  // A deterministic incomplete-evidence fixture that needs NO product-only test
  // seam: a studio that simply keeps no treatment plans cannot establish who is
  // in active treatment, so the briefing must refuse rather than print 0 and an
  // empty-but-actionable call list.
  //
  // SCOPED TO THE PLAN-DEPENDENT FIGURES, and named that way. Client records and
  // treatment time booked do NOT depend on plan evidence and are asserted BELOW
  // to still render — an earlier name promised "no figure", which contradicted
  // those very controls and would have misled anyone diagnosing a failure here.
  await loginAsOwner(page, planless);
  await page.goto("/dashboard/capacity");

  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();

  // EVERY action-driving figure must suppress — asserted one card at a time.
  // A bare `> 1` proved only that two placeholders rendered, so the four depth
  // bands could have regressed to known-looking zeroes and still passed.
  const SUPPRESSED = [
    "Active treatment clients",
    "No future treatment booked",
    "No treatment booked",
    "1 or more treatments",
    "2 or more treatments",
    "3 or more treatments",
  ];
  for (const label of SUPPRESSED) {
    const card = cardFor(page, label);
    await expect(card, `${label} must refuse to answer`).toContainText(
      "Not enough evidence yet",
    );
    // ...AND carry its own reason, matched as the CAUSAL CLAUSE rather than
    // the trailing conclusion. Pinning only "It is not zero" was still too
    // weak: the explanation could have vanished from all six cards while that
    // final sentence remained, and every scoped assertion plus both exact-six
    // counts would still have passed. The whole sentence is asserted, so the
    // card has to actually explain itself.
    await expect(card, `${label} must say WHY it cannot answer`).toContainText(
      "No open treatment plan for a current client is on file, so who is in active treatment cannot be established. It is not zero.",
    );
    // No numeric figure AT ALL — not a zero, which on this screen would read as
    // "nobody needs booking".
    await expect(figureIn(card), `${label} must render no number`).toHaveCount(0);
  }
  // Exactly six of each, so a seventh suppression — or a card that keeps the
  // placeholder while dropping the reason — is a failure too.
  await expect(page.getByText("Not enough evidence yet")).toHaveCount(
    SUPPRESSED.length,
  );
  await expect(
    page.getByText(/No open treatment plan for a current client is on file/),
  ).toHaveCount(SUPPRESSED.length);

  // ...and the figures that are legitimately KNOWN still render, so this is a
  // statement about evidence rather than a blanket "everything is unknown".
  for (const known of ["Client records", "Treatment time booked"]) {
    const card = cardFor(page, known);
    await expect(card).not.toContainText("Not enough evidence yet");
    await expect(figureIn(card)).toHaveCount(1);
  }

  // No worklist at all — not an empty one presented as complete.
  await expect(page.getByRole("heading", { name: "Who to rebook" })).toHaveCount(0);
  await expect(page.locator('a[href^="/clients/"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("an owner can find the capacity page from search", async ({ page }) => {
  await loginAsOwner(page, seed);
  // Searched from /clients, NOT /dashboard: the dashboard carries its own
  // "Practice capacity" CTA link, which would satisfy the assertion below
  // without search having matched anything at all.
  await page.goto("/clients");
  const searchBox = page.getByPlaceholder("Search clients, appointments, notes...");
  await searchBox.fill("capacity");
  // SCOPED TO THE SEARCH WIDGET, not the page. The results panel is a sibling
  // of the input inside GlobalSearch's own container, so the input's parent
  // bounds both. Page-wide, this proved only that SOME link with that name and
  // destination existed after typing: if the registry stopped returning the
  // entry while /clients gained a shell link with the same name, the count, the
  // href, the click and the landing assertion would all still have passed —
  // the same defect already fixed for the dashboard CTA, which I did not carry
  // across to the test beside it.
  const searchWidget = searchBox.locator("..");
  // Exactly one, not `.first()`: a `.first()` here would pass even if the panel
  // were rendering duplicate or unrelated capacity links.
  const result = searchWidget.getByRole("link", { name: /Practice capacity/ });
  await expect(result).toHaveCount(1);
  await expect(result).toBeVisible();
  // WHERE IT GOES, not just that it exists. If the registry kept the title and
  // its href regressed, a test named "can find the capacity page" would have
  // passed while the result no longer reached the page.
  await expect(result).toHaveAttribute("href", "/dashboard/capacity");
  await result.click();
  await page.waitForURL("**/dashboard/capacity");
  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();
});

test("the dashboard offers the owner a capacity CTA that reaches the page", async ({
  page,
}) => {
  // The SECOND discovery surface. Search is proved above; this is the link the
  // dashboard renders under `isOwner`, and nothing else in this spec covered
  // it — a regression exposing or breaking it would have gone unnoticed.
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");

  // SCOPED TO THE DASHBOARD'S OWN CONTENT, not the page. A page-wide locator
  // proved only that SOME link named "Practice capacity" existed after
  // /dashboard loaded: if the CTA were removed while a persistent shell or menu
  // link with the same name and destination existed, the count, the href, the
  // click and the landing assertion would all still have passed.
  const main = page.getByRole("main");
  const cta = main.getByRole("link", { name: /Practice capacity/ });
  await expect(cta).toHaveCount(1);
  await expect(cta).toHaveAttribute("href", "/dashboard/capacity");
  // BY DESTINATION TOO. Counting by NAME cannot see a second, relabelled link
  // to the same route — which is what the old comment claimed to protect
  // against and did not.
  await expect(main.locator('a[href="/dashboard/capacity"]')).toHaveCount(1);

  // WHERE IT GOES, not just that it exists.
  await cta.click();
  await page.waitForURL("**/dashboard/capacity");
  await expect(page.getByRole("heading", { name: "Practice capacity" })).toBeVisible();
});

test("an ordinary practitioner is offered the capacity entry neither in search nor on the dashboard", async ({
  page,
}) => {
  await loginByMagicLink(page, member.email);

  // (1) SEARCH. Owner entries are filtered BEFORE matching, so the surface is
  // not advertised — there is no "no permission" row either.
  await page.goto("/clients");
  await page
    .getByPlaceholder("Search clients, appointments, notes...")
    .fill("capacity");
  await expect(page.getByRole("link", { name: /Practice capacity/ })).toHaveCount(0);
  // The search did run: it reports an empty result rather than silently
  // rendering nothing, which is what makes the absence meaningful.
  await expect(page.getByText("No results found.")).toBeVisible();

  // (2) THE DASHBOARD CTA — asserted on the dashboard ITSELF. Absence from
  // search says nothing about the dashboard, and this test's name previously
  // claimed both while proving only the first.
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Today" }).first()).toBeVisible();
  // Scoped to the dashboard content for symmetry with the owner test...
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: /Practice capacity/ })).toHaveCount(0);
  await expect(main.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
  // ...and page-wide as well, which is strictly stronger: the entry must not
  // reach them through a shell or menu either. By destination as much as by
  // name, since a relabelled link to the owner surface is the same leak.
  await expect(page.getByRole("link", { name: /Practice capacity/ })).toHaveCount(0);
  await expect(page.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The permanent Business entry
// ---------------------------------------------------------------------------
//
// Search and the dashboard CTA above are contextual. This is the entry that is
// simply always there, on every authenticated page, for an owner only.
//
// WHAT IT IS NOT: a data boundary. The tests below hold BOTH halves at once —
// a practitioner is offered no Business entry anywhere, AND typing the route
// still meets the same server-side refusal it always did. Proving only the
// first would describe a protection this change does not provide.

test("an owner's desktop navigation carries Business, once, and it reaches the briefing", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  // ON THE DASHBOARD DELIBERATELY: this page also renders the "Practice
  // capacity" CTA, so the competing surface is present while the nav is being
  // asserted. If the nav locator could see the CTA, it would see it here.
  await page.goto("/dashboard");

  const nav = primaryNav(page);
  await expect(nav).toBeVisible();
  const business = nav.getByRole("link", { name: "Business", exact: true });
  await expect(business).toHaveCount(1);
  // RETARGETED BY FIN-01A: the entry points at the Business hub, and capacity
  // is reached from there through the shared subnav.
  await expect(business).toHaveAttribute("href", "/business");
  // Once BY DESTINATION as well: a second, relabelled link to the owner
  // surface is a duplicate entry point that counting by name cannot see.
  await expect(nav.locator('a[href="/business"]')).toHaveCount(1);
  // The primary nav no longer reaches capacity directly — that is the whole
  // point of the hub, and a stale direct link would be a second entry point.
  await expect(nav.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);

  // THE WHOLE ROW, IN ORDER. Business sits AFTER Records, and the four working
  // surfaces are untouched — a nav that gained Business by displacing Records,
  // or that grew a sixth item, fails here rather than passing four separate
  // presence checks.
  await expect(nav.getByRole("link")).toHaveText([
    "Dashboard",
    "Clients",
    "Calendar",
    "Records",
    "Business",
  ]);

  // THE CTA CANNOT SATISFY THE NAV LOCATOR — the negative control, run inline
  // against the real page rather than asserted in a comment. The dashboard's
  // own link to the identical route exists right now, in <main>, and the nav
  // locator does not see it; nor does the nav carry anything named the way the
  // CTA is named.
  await expect(
    page.getByRole("main").locator('a[href="/dashboard/capacity"]'),
  ).toHaveCount(1);
  await expect(
    nav.getByRole("link", { name: /Practice capacity/ }),
  ).toHaveCount(0);

  // WHERE IT GOES, not just that it exists.
  await business.click();
  await page.waitForURL("**/dashboard/capacity");
  await expect(
    page.getByRole("heading", { name: "Practice capacity" }),
  ).toBeVisible();
  // ...and it is still there once you have arrived: this is a permanent entry,
  // not a one-shot promotion that disappears on the destination.
  await expect(
    primaryNav(page).getByRole("link", { name: "Business", exact: true }),
  ).toBeVisible();
});

test("a practitioner gets no Business entry on the desktop nav, and the route still refuses them", async ({
  page,
}) => {
  await loginByMagicLink(page, member.email);
  await page.goto("/dashboard");

  const nav = primaryNav(page);
  await expect(nav).toBeVisible();
  // The four working surfaces, and ONLY those. Asserting the whole row rather
  // than Business's absence alone is what distinguishes "the owner entry is
  // withheld" from "the navigation failed to render".
  await expect(nav.getByRole("link")).toHaveText([
    "Dashboard",
    "Clients",
    "Calendar",
    "Records",
  ]);
  await expect(
    nav.getByRole("link", { name: "Business", exact: true }),
  ).toHaveCount(0);
  await expect(nav.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);

  // NOT ANYWHERE IN THE SHELL EITHER — by name and by destination. No disabled
  // item, no "no permission" placeholder, no hidden-but-present markup that a
  // screen reader would still announce.
  await expect(
    page.getByRole("link", { name: "Business", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);

  // AND THE HIDING IS NOT THE AUTHORITY. Typing the route directly still meets
  // the page's own server-side owner check, exactly as before this entry
  // existed — with no aggregate figure and no client identity behind it.
  await page.goto("/dashboard/capacity");
  await expect(
    page.getByText("Only studio owners can see practice capacity."),
  ).toBeVisible();
  await expect(page.locator("p.tabular-nums")).toHaveCount(0);
  await expect(page.getByText("Who to rebook")).toHaveCount(0);
  await expect(page.locator('a[href^="/clients/"]')).toHaveCount(0);
  for (const name of [REBOOK, CONSULT, BOOKED, NOPLAN]) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
});

test("an owner's mobile menu carries Business, and tapping it closes the menu and lands", async ({
  page,
}) => {
  await loginAsOwner(page, seed);
  await page.setViewportSize(PHONE);
  await page.goto("/dashboard");

  // THE DESKTOP ROW IS GONE AT THIS WIDTH (below the lg boundary) — asserted
  // FIRST, because everything
  // below is scoped to the sheet precisely so a hidden desktop anchor cannot
  // be what satisfies it. `display: none` keeps the row out of the
  // accessibility tree, so this landmark genuinely resolves to nothing.
  await expect(primaryNav(page)).toHaveCount(0);

  const menuButton = page.getByRole("button", { name: "Open navigation menu" });
  await menuButton.click();
  const nav = mobileNav(page);
  await expect(nav).toBeVisible();

  const business = nav.getByRole("link", { name: "Business", exact: true });
  await expect(business).toHaveCount(1);
  // RETARGETED BY FIN-01A, same as the desktop entry: the hub, not capacity.
  await expect(business).toHaveAttribute("href", "/business");
  // Bound to the SHEET'S OWN SUBTREE, so the hidden desktop link is not merely
  // out of the a11y tree — it is out of the search scope entirely.
  await expect(nav.locator('a[href="/business"]')).toHaveCount(1);
  await expect(nav.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);

  // IN THE WORKING-SURFACE SECTION, above the account divider. These are the
  // sheet's DIRECT link children; Settings / Getting Started / Sign out sit one
  // level deeper, inside the divider's own container. Business being in this
  // list IS the claim that it was not filed with the account actions.
  await expect(mobileWorkingSurfaces(page)).toHaveText([
    "Dashboard",
    "Clients",
    "Calendar",
    "Records",
    "Business",
  ]);
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();

  // The 44px touch target every item in this sheet carries.
  const box = (await business.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);

  // TAPPING IT CLOSES THE SHEET AND NAVIGATES — the behaviour PR #229 exists
  // to provide, which a new item could silently miss.
  await business.click();
  await page.waitForURL("**/dashboard/capacity");
  await expect(nav).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Practice capacity" }),
  ).toBeVisible();
});

test("a practitioner's mobile menu has no Business entry", async ({ page }) => {
  await loginByMagicLink(page, member.email);
  await page.setViewportSize(PHONE);
  await page.goto("/dashboard");

  await expect(primaryNav(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const nav = mobileNav(page);
  await expect(nav).toBeVisible();

  // The same whole-section assertion as the owner's, minus the one item.
  await expect(mobileWorkingSurfaces(page)).toHaveText([
    "Dashboard",
    "Clients",
    "Calendar",
    "Records",
  ]);
  await expect(
    nav.getByRole("link", { name: "Business", exact: true }),
  ).toHaveCount(0);
  await expect(nav.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
  // Their account section is untouched, so nothing was withheld wholesale.
  await expect(nav.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
  // And nowhere else in the shell at this width either.
  await expect(page.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
});

test("the shell is compact below 1024 and full desktop from 1024 — ordinary identity", async ({
  page,
}) => {
  // THE WHOLE BOUNDARY, at every width the contract names. The old `md`
  // boundary put five primary items into a 768px row and overflowed the page
  // by up to 62px with this very identity; 767/768 and 1023/1024 are asserted
  // as adjacent pairs so the boundary is pinned, not merely sampled.
  await loginAsOwner(page, seed);
  await page.goto("/dashboard");
  for (const width of WIDTHS) {
    await assertShellAt(page, width, { owner: true });
  }
});

test("the shell is compact below 1024 and full desktop from 1024 — long identity, the worst case", async ({
  page,
}) => {
  // The same matrix against the widest header the product can draw: an owner
  // whose first name fills the account button's 12ch cap. This identity ALSO
  // overflowed at md with only FOUR items (768-826px on production before this
  // change), so it is the case that decides whether 1024 is genuinely enough
  // rather than merely enough for a short name.
  await loginAsOwner(page, wide);
  await page.goto("/dashboard");
  for (const width of WIDTHS) {
    await assertShellAt(page, width, { owner: true });
  }
});

test("a practitioner gets no Business at any width, in either shell mode", async ({
  page,
}) => {
  // The role gate holds across the mode switch. A gate written into only one
  // of the two shells would pass every desktop test and still leak on a phone,
  // or the reverse — this walks the same eleven widths and asserts the
  // four-item row in both shells.
  await loginByMagicLink(page, member.email);
  await page.goto("/dashboard");
  for (const width of WIDTHS) {
    await assertShellAt(page, width, { owner: false });
    // Nowhere in the shell at this width, by destination as well as by name.
    await expect(
      page.getByRole("link", { name: "Business", exact: true }),
      `${width}px: Business must not reach a practitioner`,
    ).toHaveCount(0);
    await expect(page.locator('a[href="/dashboard/capacity"]')).toHaveCount(0);
  }
});
