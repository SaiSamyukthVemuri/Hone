import { test, expect } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// ===========================================================================
// NEW-CLIENT WAITLIST, END TO END (WAIT-01 gate + WAIT-02 durable record)
// ===========================================================================
//
// The ONE reserved slug this lane enables, named literally in
// e2e/helpers/local-env.ts (NEW_CLIENT_WAITLIST_STUDIO_SLUGS and
// NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS). No other spec claims it: every
// other seeded studio gets a random `e2e-studio-<runId>` slug, so the rest of
// the browser suite runs with the feature OFF. That makes the extended run
// itself the flag-OFF regression proof — if this feature could leak into an
// unlisted studio, the existing public-booking specs go red.
const WAITLIST_SLUG = "e2e-waitlist-p0";

// WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// This lane runs with RESEND_API_KEY="re_dummy_resend_key" (see
// e2e/helpers/local-env.ts), so the provider genuinely refuses every send.
// THAT IS NOW THE MOST VALUABLE SETTING THIS SPEC COULD HAVE. Under WAIT-01 a
// refused provider meant the visitor was told they had NOT joined, because the
// email WAS the record. Under WAIT-02 the record is a committed row, so the
// same refusal must produce:
//
//   * a real durable row, and
//   * a success surface that says so.
//
// It must NOT produce a "we couldn't confirm the notification" line: that
// caveat was removed because only a FRESH join could ever carry it, so showing
// it proved the submitted address was not already on the list.
//
// A run of this spec against the old behaviour fails immediately, which is
// exactly the regression guard the commit-point move needs.
//
// STILL NOT PROVED HERE: a forced DATABASE-layer failure. Making the real local
// Postgres refuse this command on demand means mutating a stack other
// worktrees share, and the fail-closed classification (missing command,
// transport error, every closed refusal code -> never "joined") is exercised
// exhaustively in tests/app/book/new-client-waitlist-durable-commit.test.ts.
// What this lane proves instead is the REFUSAL path through the real server:
// a submission the server gate declines shows no success and writes no row.

async function seedWaitlistStudio() {
  const seed = await seedE2eStudio();
  // The reserved slug is a SINGLETON — `studios_slug_unique` (migration 0010)
  // allows exactly one holder. Release it from any earlier holder before
  // claiming it, so later scenarios in this file (and a re-run against a
  // database that was not freshly reset) cannot trip the constraint.
  await sql(
    `update public.studios set slug = 'e2e-waitlist-released-' || id where slug = $1`,
    [WAITLIST_SLUG],
  );
  await sql(`update public.studios set slug = $2 where id = $1`, [seed.studioId, WAITLIST_SLUG]);
  return { ...seed, slug: WAITLIST_SLUG };
}

function canaryEmail(runId: string) {
  return `e2e-waitlist-canary-${runId}@harness.local`;
}

async function countsFor(studioId: string, email: string) {
  const [clients] = await sql<{ n: string }>(
    `select count(*)::text as n from public.clients where studio_id = $1`, [studioId],
  );
  const [appointments] = await sql<{ n: string }>(
    `select count(*)::text as n from public.appointments where studio_id = $1`, [studioId],
  );
  const [intakes] = await sql<{ n: string }>(
    `select count(*)::text as n from public.client_intake_forms where studio_id = $1`, [studioId],
  );
  const [marketing] = await sql<{ n: string }>(
    `select count(*)::text as n from public.waitlist where lower(email) = lower($1)`, [email],
  );
  return {
    clients: Number(clients.n),
    appointments: Number(appointments.n),
    intakes: Number(intakes.n),
    marketingWaitlist: Number(marketing.n),
  };
}

async function waitlistRows(studioId: string) {
  return sql<{ id: string; name: string; email: string; phone: string | null; status: string }>(
    `select id, name, email, phone, status
       from public.new_client_waitlist_entries
      where studio_id = $1
      order by joined_at asc, id asc`,
    [studioId],
  );
}

async function fillAndSubmitWaitlist(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; phone?: string },
) {
  await page.getByLabel(/^name/i).fill(opts.name);
  await page.getByLabel(/^email/i).fill(opts.email);
  if (opts.phone) await page.getByLabel(/^phone/i).fill(opts.phone);
  await page.getByRole("button", { name: /^join waitlist$/i }).click();
}

test.describe("new client at a waitlisted studio", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

  test("joins durably, is told so, and no business record is created", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);
    const before = await countsFor(seed.studioId, email);
    expect(before.clients).toBe(0);
    expect(before.appointments).toBe(0);
    expect(await waitlistRows(seed.studioId)).toHaveLength(0);

    await page.goto(`/book/${WAITLIST_SLUG}`);
    await expect(page.getByText(seed.studioName).first()).toBeVisible();

    // --- the waitlist appears the MOMENT they identify as a new client:
    //     no service, no date, no slot list, and no slot lookup in between.
    await page.getByRole("button", { name: /new client/i }).click();
    await expect(
      page.getByRole("heading", { name: /join the new-client waitlist/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^book appointment$/i })).toHaveCount(0);

    // --- the studio has NOT stopped booking: the escape back is right there.
    await expect(
      page.getByRole("button", { name: /already a client\? continue booking\./i }),
    ).toBeVisible();
    await expect(page.getByText(/fully booked|no appointments available/i)).toHaveCount(0);

    // --- 390px: nothing overflows horizontally.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the waitlist form must not overflow 390px").toBeLessThanOrEqual(0);

    // --- the CTA is a real touch target.
    const cta = page.getByRole("button", { name: /^join waitlist$/i });
    await expect(cta).toBeVisible();
    const box = await cta.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // --- WAIT-02B STAGE B1: THE COLLECTION NOTICE, IN A REAL BROWSER, BEFORE
    //     ANYTHING IS SUBMITTED. This is the one thing a static render cannot
    //     settle: that the notice is actually VISIBLE on the 390px viewport a
    //     prospect uses, and that the policy it points at actually resolves.
    //     A notice that is present in the markup but pushed off-screen, or that
    //     links to a 404, is not a notice.
    const collectionNotice = page.getByText(
      /use the name, email and phone number you enter here/i,
    );
    await expect(collectionNotice).toBeVisible();
    const privacyLink = page.getByRole("link", { name: /privacy policy/i });
    await expect(privacyLink).toBeVisible();
    await expect(privacyLink).toHaveAttribute("href", "/privacy");

    // The linked policy must genuinely cover the person about to submit. Fetched
    // rather than navigated so the half-filled form is not thrown away.
    const policy = await page.request.get("/privacy");
    expect(policy.status()).toBe(200);
    const policyBody = await policy.text();
    expect(policyBody).toContain("Prospective clients");
    expect(policyBody).toContain("From prospective clients directly");

    await fillAndSubmitWaitlist(page, {
      name: "E2E Waitlist Canary",
      email,
      phone: "+1 555 555 0199",
    });

    // --- THE COMMIT POINT. The provider refuses in this lane, and the visitor
    //     is still told they joined, because the DATABASE says they did.
    await expect(
      page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
    ).toBeVisible({ timeout: 60_000 });
    // ...and the panel says NOTHING about the notification. It used to carry a
    // "we couldn't confirm the notification to the studio" caveat, which only a
    // FRESH join could ever produce — so its presence proved the address was not
    // already waiting. See the duplicate scenario below.
    await expect(
      page.getByText(/couldn[\u2019']t confirm the notification to the studio/i),
    ).toHaveCount(0);
    await expect(
      page.getByText(/couldn't record your waitlist request|couldn't confirm your waitlist request/i),
    ).toHaveCount(0);

    // --- the durable row exists, and it is the ONLY thing that was written.
    const rows = await waitlistRows(seed.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("E2E Waitlist Canary");
    expect(rows[0].email).toBe(email);
    expect(rows[0].phone).toBe("+1 555 555 0199");
    expect(rows[0].status).toBe("waiting");

    const after = await countsFor(seed.studioId, email);
    expect(after.clients, "no client may be created").toBe(0);
    expect(after.appointments, "no appointment may be created").toBe(0);
    expect(after.intakes, "no intake may be created").toBe(0);
    expect(
      after.marketingWaitlist,
      "the marketing public.waitlist table must never receive a booking lead",
    ).toBe(0);
  });

  // THE ENUMERATION PROOF, end to end through the real stack.
  //
  // The first submission creates a row; the second is refused as a duplicate by
  // the database. If the visible outcome differed at all, anyone could type a
  // name and address into a public form and learn whether that person had asked
  // this studio for treatment. So the two are compared as RENDERED TEXT, not as
  // two separate expectations that happen to look similar.
  test("a duplicate submission is visually indistinguishable from the first", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);
    const panels: string[] = [];

    for (const attempt of [1, 2]) {
      await page.goto(`/book/${WAITLIST_SLUG}`);
      await page.getByRole("button", { name: /new client/i }).click();
      await expect(
        page.getByRole("heading", { name: /join the new-client waitlist/i }),
      ).toBeVisible({ timeout: 20_000 });
      await fillAndSubmitWaitlist(page, { name: "Repeat Submitter", email });

      const panel = page.getByRole("status").filter({
        has: page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
      });
      await expect(panel, `attempt ${attempt}`).toBeVisible({ timeout: 60_000 });
      panels.push((await panel.innerText()).replace(/\s+/g, " ").trim());

      // Calm on BOTH: no error copy, and the form is gone, so nothing invites a
      // further attempt. (`getByRole("alert")` is NOT the check — Next's route
      // announcer is a permanent empty alert region on every page.)
      await expect(
        page.getByText(
          /couldn[\u2019']t record your waitlist request|couldn[\u2019']t confirm your waitlist request|too many requests/i,
        ),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^join waitlist$/i })).toHaveCount(0);
      // Neither removed, outcome-revealing message appears on either attempt.
      await expect(page.getByText(/already on this studio/i)).toHaveCount(0);
      await expect(
        page.getByText(/couldn[\u2019']t confirm the notification to the studio/i),
      ).toHaveCount(0);
    }

    // The load-bearing assertion: identical rendered text, character for
    // character, for a fresh join and for a duplicate.
    expect(panels[1], "a duplicate must read exactly like a fresh join").toBe(panels[0]);
    expect(panels[0]).toContain("You\u2019re on the waitlist.");

    // ...while the database still refused the second row.
    const rows = await waitlistRows(seed.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("waiting");
  });

  test("a submission the SERVER refuses shows no success and writes no row", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);

    await page.goto(`/book/${WAITLIST_SLUG}`);
    await page.getByRole("button", { name: /new client/i }).click();
    await expect(
      page.getByRole("heading", { name: /join the new-client waitlist/i }),
    ).toBeVisible({ timeout: 20_000 });

    // The tab is now STALE: the studio this form points at is no longer the
    // one holding the gated slug, so the server-resolved studio fails the
    // independent feature check. The browser cannot tell, and must not be able
    // to talk its way past it.
    await sql(`update public.studios set slug = 'e2e-waitlist-moved-' || id where id = $1`, [
      seed.studioId,
    ]);

    await fillAndSubmitWaitlist(page, { name: "Stale Tab", email });

    await expect(
      page.getByText(/couldn't record your waitlist request/i),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
    ).toHaveCount(0);
    expect(await waitlistRows(seed.studioId)).toHaveLength(0);
  });
});

test("an existing client at a waitlisted studio keeps the normal booking path", async ({ page }) => {
  const seed = await seedWaitlistStudio();

  await page.goto(`/book/${WAITLIST_SLUG}`);
  await page.getByRole("button", { name: /existing client/i }).click();

  // Exactly what it was before this feature: the client-portal hand-off.
  await expect(
    page.getByRole("heading", { name: new RegExp(`already a ${seed.studioName} client`, "i") }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("link", { name: /sign in to client portal/i })).toBeVisible();

  // No waitlist framing reaches an existing client.
  await expect(
    page.getByRole("heading", { name: /join the new-client waitlist/i }),
  ).toHaveCount(0);
  await expect(page.getByText(/waitlist/i)).toHaveCount(0);

  // ...and identifying as an existing client writes nothing to the waitlist.
  expect(await waitlistRows(seed.studioId)).toHaveLength(0);
});

// ===========================================================================
// THE OPERATOR QUEUE
// ===========================================================================
test.describe("the studio's waitlist queue", () => {
  test("the owner sees who is waiting and can remove them", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);

    // Arrive through the REAL public flow, so the row under management is one
    // the product actually produced.
    await page.goto(`/book/${WAITLIST_SLUG}`);
    await page.getByRole("button", { name: /new client/i }).click();
    await expect(
      page.getByRole("heading", { name: /join the new-client waitlist/i }),
    ).toBeVisible({ timeout: 20_000 });
    await fillAndSubmitWaitlist(page, {
      name: "Queue Person",
      email,
      phone: "555 0142",
    });
    await expect(
      page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
    ).toBeVisible({ timeout: 60_000 });

    await loginAsOwner(page, seed);

    // The tab is visible because this studio's durable waitlist is enabled.
    await page.goto("/settings/booking");
    await expect(page.getByRole("link", { name: /^waitlist$/i })).toBeVisible();

    await page.goto("/settings/waitlist");
    await expect(page.getByRole("heading", { name: /^waitlist$/i })).toBeVisible();
    await expect(page.getByText(/^Waiting:\s*1$/)).toBeVisible();
    await expect(page.getByText("Queue Person", { exact: true })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByText("555 0142")).toBeVisible();

    // 390px: the queue is usable on a phone and does not overflow.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the queue must not overflow 390px").toBeLessThanOrEqual(0);

    // Removal is two-step: the confirm button is inside a closed <details>, so
    // it is present but NOT operable until the owner opens the disclosure. A
    // mis-tap on a phone cannot remove someone.
    const confirm = page.getByRole("button", { name: /confirm removal/i });
    await expect(confirm).toBeHidden();
    await page.getByText("Remove", { exact: true }).click();
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The entry leaves the ACTIVE queue...
    await expect(page.getByText(/nobody is waiting right now/i)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Queue Person", { exact: true })).toHaveCount(0);

    // ...but the row is NOT deleted: it keeps its history and its actor.
    const rows = await waitlistRows(seed.studioId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("removed");
    const [evidence] = await sql<{ removed_at: string | null; removed_by: string | null }>(
      `select removed_at, removed_by_practitioner_id as removed_by
         from public.new_client_waitlist_entries where id = $1`,
      [rows[0].id],
    );
    expect(evidence.removed_at).not.toBeNull();
    expect(evidence.removed_by).not.toBeNull();
  });

  test("a non-owner practitioner of the same studio is refused", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);
    await sql(
      `insert into public.new_client_waitlist_entries (studio_id, name, email)
       values ($1, 'Hidden Person', $2)`,
      [seed.studioId, email],
    );

    const member = await seedE2eMember(seed);
    await loginByMagicLink(page, member.email);

    await page.goto("/settings/waitlist");
    await expect(
      page.getByText(/only studio owners can see the new-client waitlist/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Hidden Person", { exact: true })).toHaveCount(0);
    await expect(page.getByText(email, { exact: true })).toHaveCount(0);
  });

  test("another studio's owner sees their OWN queue, never this one's", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    const email = canaryEmail(seed.runId);
    await sql(
      `insert into public.new_client_waitlist_entries (studio_id, name, email)
       values ($1, 'Studio A Person', $2)`,
      [seed.studioId, email],
    );

    // A completely separate studio, with its own owner and its own waiting
    // person carrying the SAME email — legitimate, and it must stay separate.
    const other = await seedE2eStudio();
    await sql(
      `insert into public.new_client_waitlist_entries (studio_id, name, email)
       values ($1, 'Studio B Person', $2)`,
      [other.studioId, email],
    );

    await loginAsOwner(page, other);
    await page.goto("/settings/waitlist");

    await expect(page.getByText("Studio B Person", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Studio A Person", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Waiting:\s*1$/)).toBeVisible();
  });
});
