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
// prove is that an owner actually REACHES the page, that an ordinary
// practitioner does not receive the aggregate, and that the rebooking names are
// real links landing on the right client.
//
// THE POPULATION SEEDED HERE IS THE ONE SLICE 1 DEFINES: a current
// (non-archived) client with an OPEN treatment plan and no future TREATMENT
// appointment. Each of the three cases below is one axis of that definition,
// with a control:
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

  // And none of the aggregate reaches them.
  await expect(page.getByText("Who to rebook")).toHaveCount(0);
  await expect(page.getByText(REBOOK)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Future treatment booking depth" }),
  ).toHaveCount(0);
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
  // And, strictly stronger, absent from the page entirely.
  await expect(page.getByRole("link", { name: BOOKED })).toHaveCount(0);

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

test("a studio with no treatment plans shows no figure and no partial list", async ({
  page,
}) => {
  // A deterministic incomplete-evidence fixture that needs NO product-only test
  // seam: a studio that simply keeps no treatment plans cannot establish who is
  // in active treatment, so the briefing must refuse rather than print 0 and an
  // empty-but-actionable call list.
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
  await page
    .getByPlaceholder("Search clients, appointments, notes...")
    .fill("capacity");
  // Exactly one, not `.first()`: a `.first()` here would pass even if the page
  // were rendering duplicate or unrelated capacity links.
  const result = page.getByRole("link", { name: /Practice capacity/ });
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

test("an ordinary practitioner is not offered the owner-only entry", async ({ page }) => {
  await loginByMagicLink(page, member.email);
  await page.goto("/clients");
  await page
    .getByPlaceholder("Search clients, appointments, notes...")
    .fill("capacity");

  // Owner entries are filtered BEFORE matching, so the surface is not
  // advertised at all — there is no "no permission" row either.
  await expect(page.getByRole("link", { name: /Practice capacity/ })).toHaveCount(0);
  // The search did run: it reports an empty result rather than silently
  // rendering nothing, which is what makes the absence meaningful.
  await expect(page.getByText("No results found.")).toBeVisible();
});
