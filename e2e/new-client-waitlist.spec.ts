import { test, expect } from "@playwright/test";
import { getOwnerPractitionerId, seedE2eStudio, seedE2eMember, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";
import {
  PRACTITIONER_SMS_CONSENT_SCOPE,
  SMS_OPERATIONAL_CONSENT_DECLINED_NOTE,
  SMS_OPERATIONAL_CONSENT_LABEL,
  SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
} from "@/lib/waitlist/prospect-sms-consent";

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
// THE PROVIDER REFUSES EVERY SEND IN THIS SPEC, AND IT IS NOW ASKED TO.
//
// This used to rely on RESEND_API_KEY="re_dummy_resend_key" being rejected by
// the real Resend API. RESCHEDULE-E2E-01 arms the server-only fake transport for
// the whole lane, whose default mode ACCEPTS -- which would have left this spec
// documenting a refusal it no longer exercised, and passing anyway, because its
// durable-commit assertions render the same result either way. So the refusal is
// now ASKED FOR, per recipient, for BOTH sends this flow makes: the studio
// notice to `studios.owner_email` and the client acknowledgement to the
// visitor's own submitted address (app/book/[slug]/waitlist-actions.ts). Each
// gets a `reject+` local part, which the fake transport reads at send time, so
// the refusal is local to this spec, needs no global state and no restart, and
// is identical on every run and every machine.
//
// The browser lane ALSO defaults the fake to `reject`
// (HONE_E2E_FAKE_RESEND_DEFAULT_MODE), which is what the dummy key used to do
// for every send. That default is the safety net for specs nobody has
// enumerated; the explicit prefixes above are this spec's own claim, and they
// survive any future change to that default.
//
// THAT IS THE MOST VALUABLE SETTING THIS SPEC COULD HAVE. Under WAIT-01 a
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

  // The OTHER half of the pair: the studio notice recipient. Only the studios
  // row changes, so the auth user and practitioner row keep the seeded address
  // and owner sign-in is unaffected; `owner_email` carries no unique constraint.
  await sql(`update public.studios set owner_email = $2 where id = $1`, [
    seed.studioId,
    `reject+waitlist-owner-${seed.runId}@harness.local`,
  ]);


  // RETURN THE STUDIO TO THE PRE-0204 UNSTAMPED SHAPE, which is the only state
  // the legacy env bridge governs.
  //
  // WHY THIS BECAME NECESSARY AT 0205. This lane makes a studio waitlisted by
  // holding the reserved slug in NEW_CLIENT_WAITLIST_STUDIO_SLUGS and letting
  // the bridge escalate `open` -> `waitlist`. The bridge is ONE-WAY and applies
  // only to a row whose persisted authority was never initialized. Since 0205
  // `new_client_admission_mode_set_at` carries a `now()` default, so a seeded
  // studio is born STAMPED and `resolveAdmission` answers `persisted` / `open`
  // -- correctly ignoring the slug, because a brand-new studio is not a legacy
  // row. Without this the four scenarios below run against an OPEN studio and
  // the waitlist never appears.
  //
  // UNSTAMPING RATHER THAN PERSISTING `waitlist` IS DELIBERATE. The refusal
  // scenario moves the slug away and expects the server to decline the join,
  // which is a BRIDGE behaviour: a persisted `waitlist` would survive the slug
  // moving and that scenario would stop testing anything. This lane is about
  // the bridge, and it retires with the bridge at cutover.
  //
  // The permit is required because `studios_admission_mode_guard` (BEFORE
  // UPDATE) refuses any update touching the three admission fields without one.
  // It is transaction-local and names exactly this studio -- the same mechanism
  // the supported command uses, not a bypass of it. A `do` block keeps the
  // permit and the update in ONE transaction, which `sql()` cannot otherwise
  // guarantee: it opens a fresh connection per call. The `::uuid` casts make a
  // malformed id a loud error rather than an interpolation hazard.
  await sql(
    `do $do$
     begin
       perform set_config(
         'hone.admission_mode_studio_id', '${seed.studioId}'::uuid::text, true);
       update public.studios
          set new_client_admission_mode        = 'open',
              new_client_admission_mode_set_at = null,
              new_client_admission_mode_set_by = null
        where id = '${seed.studioId}'::uuid;
     end
     $do$;`,
  );

  // NON-VACUITY AT SETUP. If the unstamp ever silently stops working, every
  // scenario below would fail somewhere deep in a page flow with no hint why.
  // Fail here instead, naming the cause.
  const [shape] = await sql<{ unstamped: boolean }>(
    `select new_client_admission_mode_set_at is null as unstamped
       from public.studios where id = $1`,
    [seed.studioId],
  );
  if (!shape?.unstamped) {
    throw new Error(
      "seedWaitlistStudio: the studio is still STAMPED, so the legacy env bridge " +
        "cannot make it waitlisted. The admission permit or the guard changed.",
    );
  }

  return { ...seed, slug: WAITLIST_SLUG };
}

function canaryEmail(runId: string) {
  // `reject+` ASKS the fake transport to refuse THIS recipient.
  //
  // app/book/[slug]/waitlist-actions.ts sends twice: the studio notice to
  // `studios.owner_email`, and the client acknowledgement to the visitor's own
  // submitted address -- this one. An earlier revision of this fix prefixed only
  // the studio address, so the client acknowledgement was still ACCEPTED and the
  // header's claim that every send is refused was still false. Both are now
  // asked for per-recipient, which needs no global state and no restart.
  return `reject+waitlist-canary-${runId}@harness.local`;
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

/** Every SMS-consent fact 0202 and 0208 keep on an entry, for one studio. */
async function consentRows(studioId: string) {
  return sql<{
    id: string;
    name: string;
    phone: string | null;
    status: string;
    sms_consent_at: string | null;
    sms_consent_source: string | null;
    sms_consent_text_version: string | null;
    sms_consent_recorded_by_practitioner_id: string | null;
    sms_consent_scope: string | null;
    sms_consent_evidence_ref: string | null;
    sms_consent_given_on: string | null;
    sms_opted_out_at: string | null;
  }>(
    `select id, name, phone, status, sms_consent_at, sms_consent_source,
            sms_consent_text_version, sms_consent_recorded_by_practitioner_id,
            sms_consent_scope, sms_consent_evidence_ref,
            sms_consent_given_on::text as sms_consent_given_on, sms_opted_out_at
       from public.new_client_waitlist_entries
      where studio_id = $1
      order by joined_at asc, id asc`,
    [studioId],
  );
}

async function fillAndSubmitWaitlist(
  page: import("@playwright/test").Page,
  // 0208. The SMS question is required and has no default, so every journey
  // answers it. "no" unless the scenario is about the answer itself; `null`
  // leaves it unanswered.
  opts: { name: string; email: string; phone?: string; sms?: "yes" | "no" | null },
) {
  await page.getByLabel(/^name/i).fill(opts.name);
  await page.getByLabel(/^email/i).fill(opts.email);
  if (opts.phone) await page.getByLabel(/^phone/i).fill(opts.phone);
  const sms = opts.sms === undefined ? "no" : opts.sms;
  if (sms) await page.getByRole("radio", { name: sms === "yes" ? /^yes$/i : /^no$/i }).check();
  await page.getByRole("button", { name: /^join waitlist$/i }).click();
}

async function openWaitlistForm(page: import("@playwright/test").Page) {
  await page.goto(`/book/${WAITLIST_SLUG}`);
  await page.getByRole("button", { name: /new client/i }).click();
  await expect(
    page.getByRole("heading", { name: /join the new-client waitlist/i }),
  ).toBeVisible({ timeout: 20_000 });
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

  // 0208 — THE SMS QUESTION, THROUGH THE REAL FORM, SERVER AND DATABASE.
  test("the SMS question has no default, refuses no answer, and records a Yes as the person's own", async ({
    page,
  }) => {
    const seed = await seedWaitlistStudio();
    await openWaitlistForm(page);

    await expect(page.getByText(SMS_OPERATIONAL_CONSENT_LABEL)).toBeVisible();
    const yes = page.getByRole("radio", { name: /^yes$/i });
    const no = page.getByRole("radio", { name: /^no$/i });
    await expect(yes).not.toBeChecked();
    await expect(no).not.toBeChecked();

    // NOT ANSWERED is refused by the server, never read as No, and writes nothing.
    await fillAndSubmitWaitlist(page, {
      name: "Unanswered Person",
      email: canaryEmail(seed.runId),
      phone: "416 555 0161",
      sms: null,
    });
    await expect(page.getByText("Please choose Yes or No for text messages.")).toBeVisible({
      timeout: 60_000,
    });
    expect(await waitlistRows(seed.studioId)).toHaveLength(0);

    // The same visitor answers Yes and submits again.
    await yes.check();
    await page.getByRole("button", { name: /^join waitlist$/i }).click();
    await expect(
      page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
    ).toBeVisible({ timeout: 60_000 });

    const rows = await consentRows(seed.studioId);
    expect(rows).toHaveLength(1);
    // Their own answer to the sentence they saw: the form, the v1 wording, and
    // none of a practitioner record's provenance.
    expect(rows[0]).toMatchObject({
      phone: "416 555 0161",
      sms_consent_source: "public_form",
      sms_consent_text_version: SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
      sms_consent_recorded_by_practitioner_id: null,
      sms_consent_scope: null,
      sms_consent_evidence_ref: null,
      sms_consent_given_on: null,
      sms_opted_out_at: null,
    });
    expect(rows[0].sms_consent_at).not.toBeNull();
  });

  test("No keeps the place and the email, and records no consent", async ({ page }) => {
    const seed = await seedWaitlistStudio();
    await openWaitlistForm(page);

    await page.getByRole("radio", { name: /^no$/i }).check();
    await expect(page.getByText(SMS_OPERATIONAL_CONSENT_DECLINED_NOTE)).toBeVisible();

    await fillAndSubmitWaitlist(page, {
      name: "Declining Person",
      email: canaryEmail(seed.runId),
      phone: "416 555 0162",
      sms: "no",
    });
    await expect(
      page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
    ).toBeVisible({ timeout: 60_000 });

    const rows = await consentRows(seed.studioId);
    expect(rows).toHaveLength(1);
    // On the list, waiting, with the number kept: declining removes SMS
    // eligibility only.
    expect(rows[0]).toMatchObject({
      status: "waiting",
      phone: "416 555 0162",
      sms_consent_at: null,
      sms_consent_source: null,
      sms_consent_text_version: null,
    });
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
    // WAIT-EXPOSE-01 renamed this counter. It now spans every ACTIVE lifecycle
    // state the page surfaces (waiting, held, invited, expired, released), so
    // "Waiting: N" would be a false label. The per-section heading below still
    // carries the waiting-only count.
    await expect(page.getByText(/^Waitlist entries:\s*1$/)).toBeVisible();
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

  // 0208 — THE OWNER RECORDS CONSENT GIVEN OUTSIDE HONE, AND STOP STILL WINS.
  test("the owner records SMS consent given outside Hone, and a STOP elsewhere refuses it", async ({
    page,
  }) => {
    const seed = await seedWaitlistStudio();

    // Two people arrive through the REAL public flow, both answering No.
    for (const [name, phone] of [
      ["Recorded Person", "416 555 0171"],
      ["Stopped Person", "416 555 0172"],
    ] as const) {
      await openWaitlistForm(page);
      await fillAndSubmitWaitlist(page, {
        name,
        email: canaryEmail(`${seed.runId}-${phone.slice(-4)}`),
        phone,
        sms: "no",
      });
      await expect(
        page.getByRole("heading", { name: /you[\u2019']re on the waitlist/i }),
      ).toBeVisible({ timeout: 60_000 });
    }
    const joined = await consentRows(seed.studioId);
    const recordedId = joined.find((r) => r.name === "Recorded Person")!.id;
    const stoppedId = joined.find((r) => r.name === "Stopped Person")!.id;

    // The second number already said STOP to ANOTHER studio, typed differently.
    // Nothing on this studio's row says so; the phone-wide read must.
    const other = await seedE2eStudio();
    await sql(
      `insert into public.clients (id, studio_id, name, email, phone, sms_opted_out_at, sms_opt_out_source)
       values (gen_random_uuid(), $1, $2, $3, '+1 (416) 555-0172', now(), 'twilio_stop')`,
      [other.studioId, `Stopped Elsewhere ${other.runId}`, `e2e-stopped-${other.runId}@harness.local`],
    );

    await loginAsOwner(page, seed);
    await page.goto("/settings/waitlist");

    const recorded = page.locator(`li[data-entry-id="${recordedId}"]`);
    await expect(recorded.getByTestId("sms-consent-status")).toHaveText("Texts: no consent on record");
    await recorded.getByText("Record SMS consent for Recorded Person").click();

    // Nothing answered: refused inline, and nothing recorded.
    await recorded.getByRole("button", { name: /^record consent$/i }).click();
    await expect(recorded.getByRole("alert")).toContainText("Confirm the person agreed", {
      timeout: 20_000,
    });

    const EVIDENCE = "Agreed by phone with the owner; noted in the intake binder";
    await recorded.getByRole("checkbox", { name: /agreed to texts about this waitlist/i }).check();
    await recorded.getByLabel(/where is the evidence/i).fill(EVIDENCE);
    await recorded.getByRole("radio", { name: /^day not known$/i }).check();
    await recorded.getByRole("button", { name: /^record consent$/i }).click();

    await expect(recorded.getByTestId("sms-consent-status")).toContainText(
      "Texts: consent recorded by the studio on",
      { timeout: 20_000 },
    );
    await expect(recorded.getByTestId("sms-consent-status")).toContainText(
      "they agreed on a day not known",
    );
    // Recorded once; the form is not offered again.
    await expect(recorded.getByTestId("sms-consent-form")).toHaveCount(0);

    const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);
    const after = await consentRows(seed.studioId);
    expect(after.find((r) => r.id === recordedId)).toMatchObject({
      phone: "416 555 0171",
      sms_consent_source: "practitioner",
      sms_consent_text_version: null,
      sms_consent_recorded_by_practitioner_id: ownerPractitionerId,
      sms_consent_scope: PRACTITIONER_SMS_CONSENT_SCOPE,
      sms_consent_evidence_ref: EVIDENCE,
      sms_consent_given_on: null,
    });
    expect(after.find((r) => r.id === recordedId)!.sms_consent_at).not.toBeNull();

    // STOP WINS, PHONE-WIDE: a fully answered recording is refused.
    const stopped = page.locator(`li[data-entry-id="${stoppedId}"]`);
    await stopped.getByText("Record SMS consent for Stopped Person").click();
    await stopped.getByRole("checkbox", { name: /agreed to texts about this waitlist/i }).check();
    await stopped.getByLabel(/where is the evidence/i).fill(EVIDENCE);
    await stopped.getByRole("radio", { name: /^i know the day$/i }).check();
    await stopped.getByLabel(/^day they agreed$/i).fill("2026-03-01");
    await stopped.getByRole("button", { name: /^record consent$/i }).click();
    await expect(stopped.getByRole("alert")).toHaveText(
      "This number replied STOP to Hone texts. Consent can't be recorded for it.",
      { timeout: 20_000 },
    );
    const stoppedRow = (await consentRows(seed.studioId)).find((r) => r.id === stoppedId)!;
    expect(stoppedRow.sms_consent_at).toBeNull();
    expect(stoppedRow.phone).toBe("416 555 0172");
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
    // WAIT-EXPOSE-01 renamed this counter. It now spans every ACTIVE lifecycle
    // state the page surfaces (waiting, held, invited, expired, released), so
    // "Waiting: N" would be a false label. The per-section heading below still
    // carries the waiting-only count.
    await expect(page.getByText(/^Waitlist entries:\s*1$/)).toBeVisible();
  });
});
