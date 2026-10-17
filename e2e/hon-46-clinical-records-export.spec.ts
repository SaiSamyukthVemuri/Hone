import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
import { markSentryEgress, readSentryEgress } from "./helpers/sentry-egress";
import { formatClinicalDate } from "../lib/clinical-notes/clinical-date";
import {
  getOwnerPractitionerId,
  getStudioTimezone,
  seedE2eMember,
  setStudioTimezone,
  seedE2eStudio,
  sql,
  type E2eSeed,
} from "./helpers/seed";

// ===========================================================================
// HON-46: per-client clinical-records preview/print, in the browser.
// ===========================================================================
//
// SERVER-SIDE EXCLUSION, PROVEN WITH SEEDED DATA: the client has a private
// warning, a personal note, a next-session planning note, a deleted session
// and a session outside the range, each carrying a unique synthetic sentinel.
// The owner's export must show the in-scope session, its entry and the
// clinical note, and none of the sentinels, in the rendered page AND in the
// raw HTML the server sent (so nothing was merely hidden by CSS).
//
// #828 rules, also asserted here: owner only (a practitioner and another
// studio's owner are refused and write no audit row), one audit row per
// preview and per print, the print dialog opens only after the print was
// audited, and the response is never cached (no-store). Synthetic data only.

const DAY = "2026-09-15";
const OUTSIDE_DAY = "2026-09-20";
// The HON-46 journey (Sam, 2026-10-17): one client, ONE treatment date with
// several treatments, its neighbouring date, and a date with none. All outside
// the DAY..OUTSIDE_DAY range the other tests count sessions in.
const JOURNEY_DAY = "2026-09-24";
const JOURNEY_PREV_DAY = "2026-09-23";
const EMPTY_DAY = "2026-09-25";

type Fixture = {
  seed: E2eSeed;
  clientId: string;
  sentinel: Record<
    | "session"
    | "entry"
    | "block"
    | "probeLot"
    | "nextDayNote"
    | "laser"
    | "clinicalNote"
    | "privateWarning"
    | "personalNote"
    | "planning"
    | "deleted"
    | "outside"
    | "journeyMorning"
    | "journeyAfternoon"
    | "journeyPrevDay"
    | "journeyNote",
    string
  >;
};

let fx: Fixture;

async function auditRows(clientId: string) {
  return sql<{ id: string; action: string; actor_id: string; metadata: Record<string, string> }>(
    `select id, action, actor_id, metadata from public.audit_logs
      where entity_id = $1 and action like 'clinical_records_%' order by created_at`,
    [clientId],
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const seed = await seedE2eStudio();
  const run = seed.runId;
  // seedE2eStudio creates no client row (other specs create one by booking),
  // so this spec inserts its own synthetic client.
  const client = { id: randomUUID() };
  await sql(`insert into public.clients (id, studio_id, name, email) values ($1, $2, $3, $4)`, [
    client.id,
    seed.studioId,
    seed.clientName,
    seed.clientEmail,
  ]);
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  // A NEGATIVE UTC offset, so a clinical note's midnight-UTC civil date and
  // the studio-local day disagree: the case Codex P1 4302644059 is about.
  await setStudioTimezone(seed.studioId, "America/Los_Angeles");
  const tz = await getStudioTimezone(seed.studioId);
  const sentinel = {
    session: `SESSION-NOTE-${run}`,
    entry: `ENTRY-COMMENT-${run}`,
    block: `BLOCK-NOTE-${run}`,
    probeLot: `LOT-${run}`,
    nextDayNote: `NEXT-DAY-NOTE-${run}`,
    laser: `LASER-NOTE-${run}`,
    clinicalNote: `CLINICAL-NOTE-${run}`,
    privateWarning: `PRIVATE-WARNING-${run}`,
    personalNote: `PERSONAL-NOTE-${run}`,
    planning: `PLANNING-NOTE-${run}`,
    deleted: `DELETED-SESSION-${run}`,
    outside: `OUTSIDE-RANGE-${run}`,
    journeyMorning: `JOURNEY-MORNING-${run}`,
    journeyAfternoon: `JOURNEY-AFTERNOON-${run}`,
    journeyPrevDay: `JOURNEY-PREV-DAY-${run}`,
    journeyNote: `JOURNEY-NOTE-${run}`,
  };
  const at = (day: string, time: string) =>
    sql<{ t: string }>(`select (($1::date + $2::time) at time zone $3)::text as t`, [day, time, tz]).then((r) => r[0].t);

  const [inScope] = await sql<{ id: string }>(
    `insert into public.sessions
       (studio_id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at,
        session_notes, next_session_note, price_paid_cents)
     values ($1, $2, $3, $3, 'electrolysis', $4, $5, $6, 12345) returning id`,
    [seed.studioId, client.id, ownerId, await at(DAY, "10:00"), sentinel.session, sentinel.planning],
  );
  // CURRENT charting: a settings block with structured probe, lot and
  // reaction, and an entry charted in it with the newer readings.
  const [block] = await sql<{ id: string }>(
    `insert into public.session_blocks
       (studio_id, session_id, sort_order, primary_area, side, mode, probe_label, probe_lot_number,
        reaction_type, tolerance_rating, block_notes, caution_for_next_session)
     values ($1, $2, 0, 'upper lip', 'left', 'blend', 'Ballet F3', $3, 'mild_redness', 4, $4, true) returning id`,
    [seed.studioId, inScope.id, sentinel.probeLot, sentinel.block],
  );
  // Multi-area charting: session_block_areas is authoritative; primary_area
  // keeps only the first area (Codex P1 4301307238).
  await sql(
    `insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
     values ($1, $2, 'Cheeks', 'left', 0), ($1, $2, 'Sideburns', 'right', 1)`,
    [block.id, seed.studioId],
  );
  await sql(
    `insert into public.electrolysis_entries
       (session_id, block_id, area, thermolysis_intensity_percent, pulse_delay_seconds, observation_chips, comments)
     values ($1, $2, 'upper lip', 22, 1.5, '["good release"]'::jsonb, $3)`,
    [inScope.id, block.id, sentinel.entry],
  );
  // A laser treatment pass on the same session (Codex P1 4301153312).
  await sql(
    `insert into public.laser_entries (session_id, zone, session_number, equipment_params, observation_notes)
     values ($1, 'Underarm', 3, '{"fluence_j_cm2": 18}'::jsonb, $2)`,
    [inScope.id, sentinel.laser],
  );
  await sql(
    `insert into public.sessions
       (studio_id, client_id, practitioner_id, modality, started_at, session_notes, deleted_at, delete_reason)
     values ($1, $2, $3, 'electrolysis', $4, $5, now(), 'duplicate')`,
    [seed.studioId, client.id, ownerId, await at(DAY, "14:00"), sentinel.deleted],
  );
  await sql(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at, session_notes)
     values ($1, $2, $3, 'electrolysis', $4, $5)`,
    [seed.studioId, client.id, ownerId, await at(OUTSIDE_DAY, "10:00"), sentinel.outside],
  );
  // The journey date: TWO treatments the same day, and one the day before.
  await sql(
    `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at, session_notes)
     values ($1, $2, $3, 'electrolysis', $4, $5), ($1, $2, $3, 'electrolysis', $6, $7),
            ($1, $2, $3, 'electrolysis', $8, $9)`,
    [
      seed.studioId,
      client.id,
      ownerId,
      await at(JOURNEY_DAY, "09:00"),
      sentinel.journeyMorning,
      await at(JOURNEY_DAY, "16:30"),
      sentinel.journeyAfternoon,
      await at(JOURNEY_PREV_DAY, "16:30"),
      sentinel.journeyPrevDay,
    ],
  );
  // A clinical note ON the journey date: kept, per Sam's decision.
  await sql(
    `insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body, occurred_at)
     values ($1, $2, $3, 'skin_hair_analysis', $4, $5::date)`,
    [seed.studioId, client.id, ownerId, sentinel.journeyNote, JOURNEY_DAY],
  );
  // Clinical notes are stored the way the date input stores them: MIDNIGHT
  // UTC of the civil date. One on DAY (in scope) and one on the next day (out).
  await sql(
    `insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body, occurred_at)
     values ($1, $2, $3, 'consultation', $4, $5::date), ($1, $2, $3, 'consultation', $6, ($5::date + 1))`,
    [seed.studioId, client.id, ownerId, sentinel.clinicalNote, DAY, sentinel.nextDayNote],
  );
  await sql(
    `insert into public.client_personal_notes (studio_id, client_id, personal_notes, private_warnings)
     values ($1, $2, $3, $4)`,
    [seed.studioId, client.id, sentinel.personalNote, sentinel.privateWarning],
  );
  fx = { seed, clientId: client.id, sentinel };
});

test("owner: the day's records appear; every excluded sentinel is absent from page and raw HTML", async ({ page }) => {
  const egressMark = markSentryEgress();
  await loginByMagicLink(page, fx.seed.ownerEmail);
  const url = `/clients/${fx.clientId}/records/export?scope=day&day=${DAY}`;

  // VERCEL TELEMETRY (Codex P1 4301165382, #828 G-26). Positive control first:
  // an ordinary app page DOES load the Vercel scripts, so the check below can
  // fail. Then the export document, entered by a full load, loads none.
  // Each request is attributed to the document that was current when it was
  // made, so a late script load from the control page (Analytics injects its
  // scripts after hydration, which can land after goto() resolves) is never
  // counted against the export.
  const vercel: Array<{ url: string; doc: string }> = [];
  page.on("request", (r) => {
    if (r.url().includes("/_vercel/")) vercel.push({ url: r.url(), doc: page.url() });
  });
  await page.goto(`/clients/${fx.clientId}`);
  await expect
    .poll(() => vercel.filter((v) => /\/_vercel\/(insights|speed-insights)\/script\.js/.test(v.url)).length, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(2);
  await page.waitForLoadState("networkidle");
  vercel.length = 0;

  const res = await page.goto(url);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["cache-control"] ?? "").toContain("no-store");

  await expect(page.getByTestId("export-session")).toHaveCount(1);
  await expect(page.getByText(fx.sentinel.session)).toBeVisible();
  await expect(page.getByTestId("export-entry")).toContainText(fx.sentinel.entry);
  // The CURRENT charting fields reach the document (Codex P1 4301165385).
  const blockEl = page.getByTestId("export-block");
  await expect(blockEl).toContainText("Left Cheeks · Right Sideburns");
  await expect(blockEl).toContainText("Probe: Ballet F3");
  await expect(blockEl).toContainText(`Probe lot: ${fx.sentinel.probeLot}`);
  // Un-migrated block reaction: printed as LEGACY, by its label, through the
  // saved-record view's rule (Codex P1 4304382927).
  await expect(blockEl).toContainText("Legacy skin response: Mild redness");
  await expect(blockEl).not.toContainText("Reaction: mild_redness");
  await expect(blockEl).toContainText(fx.sentinel.block);
  await expect(blockEl).toContainText("Thermolysis intensity: 22 %");
  await expect(blockEl).toContainText("Pulse delay: 1.5 s");
  await expect(blockEl).toContainText("Observed: good release");
  // A flag-only caution is exported (Codex P2 4302644062).
  await expect(blockEl).toContainText("Caution for next session: Yes");
  // The day's clinical note is in, dated as its CIVIL date; the next day's is
  // out (Codex P1 4302644059, Los Angeles studio).
  await expect(page.getByTestId("export-note")).toHaveCount(1);
  await expect(page.getByTestId("export-note")).toContainText(formatClinicalDate(`${DAY}T00:00:00+00:00`));
  await expect(page.getByText(fx.sentinel.nextDayNote)).toHaveCount(0);
  const laserEl = page.getByTestId("export-laser");
  await expect(laserEl).toContainText("Laser · Underarm");
  await expect(laserEl).toContainText("fluence j cm2: 18");
  await expect(laserEl).toContainText(fx.sentinel.laser);

  // No Vercel script or beacon on the export document.
  await page.waitForLoadState("networkidle");
  expect(
    vercel.filter((v) => v.doc.includes("/records/export")),
    "the export document loaded Vercel telemetry",
  ).toEqual([]);
  expect(await page.evaluate(() => typeof (window as unknown as { va?: unknown }).va)).toBe("undefined");
  expect(await page.evaluate(() => typeof (window as unknown as { si?: unknown }).si)).toBe("undefined");
  await expect(page.getByTestId("export-note")).toContainText(fx.sentinel.clinicalNote);
  await expect(page.getByRole("region", { name: "Not included" })).toContainText("Private warnings and personal notes");

  // The printable title (the default PDF file name) carries no client name.
  await expect(page).toHaveTitle(/Clinical records export/);
  expect(await page.title()).not.toContain(fx.seed.clientName);

  const excluded = [
    fx.sentinel.privateWarning,
    fx.sentinel.personalNote,
    fx.sentinel.planning,
    fx.sentinel.deleted,
    fx.sentinel.outside,
  ];
  const rendered = await page.content();
  const raw = await (await page.request.get(url)).text();
  for (const s of excluded) {
    expect(rendered, `rendered page leaked ${s}`).not.toContain(s);
    expect(raw, `server HTML leaked ${s}`).not.toContain(s);
  }
  expect(raw).not.toContain("12345"); // the seeded price paid

  // NATIVE PRINT IS GATED (Codex P1 4301153310): Ctrl/Cmd+P never runs the
  // audited button, so what the browser would print here is ONLY the notice,
  // with no record content and no client name.
  await page.emulateMedia({ media: "print" });
  const nativePrint = await page.locator("body").innerText();
  expect(nativePrint).toContain("can only be printed with the Print button");
  for (const s of [fx.sentinel.session, fx.sentinel.clinicalNote, fx.sentinel.entry, fx.seed.clientName, ...excluded]) {
    expect(nativePrint, `an unaudited print would contain ${s}`).not.toContain(s);
  }
  await page.emulateMedia({ media: "screen" });

  // SENTRY (#828 item 6; Codex P1 4302852097): NOTHING about the export page
  // reaches Sentry. An error thrown ON the export page is DROPPED by the shared
  // scrubber, so it must never be captured. NON-VACUOUS by a positive control:
  // the export page is given time to send (Sentry transmits an event as soon
  // as it is captured), THEN the owner leaves by the page's own "Back to
  // client" exit and a second error there IS captured. Scope, stated honestly:
  // the guard records a SUMMARY of each envelope (transaction, message,
  // exception values), not the full payload; the drop itself is proven field
  // by field in tests/lib/observability.
  const droppedCanary = `HON46-CANARY-EXPORT-${fx.seed.runId}`;
  const controlCanary = `HON46-CANARY-CONTROL-${fx.seed.runId}`;
  const throwSoon = (msg: string) =>
    page.evaluate((m) => {
      setTimeout(() => {
        throw new Error(m);
      }, 0);
    }, msg);
  await throwSoon(droppedCanary);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_500);

  // LEAVING is a FULL document load (Codex P1 4302941126): the exit is a plain
  // <a>, so the app page, which DOES load analytics, gets its own document.
  vercel.length = 0;
  const exportUrl = page.url();
  // Whether leaving was a full document load is RECORDED here and asserted
  // only after the Back checks, so that on a soft-navigating exit the Back
  // assertions (the observable leak) are what fail first.
  let leftByFullLoad = false;
  const onLoad = () => {
    leftByFullLoad = true;
  };
  page.once("load", onLoad);
  await page.getByRole("link", { name: "Back to client" }).click();
  await page.waitForURL((u) => u.pathname === `/clients/${fx.clientId}`);
  // Positive control for the Back check below: analytics IS live out here.
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as { va?: unknown }).va), { timeout: 15_000 })
    .not.toBe("undefined");
  await throwSoon(controlCanary);
  await expect
    .poll(() => JSON.stringify(readSentryEgress(egressMark)).includes(controlCanary), { timeout: 20_000 })
    .toBe(true);
  const egress = JSON.stringify(readSentryEgress(egressMark));
  expect(egress, "an error raised on the export page reached Sentry").not.toContain(droppedCanary);
  expect(egress, "an envelope named the records export route").not.toMatch(/records(?:\/|%2f)export/i);
  for (const s of [fx.clientId, fx.seed.clientName, fx.seed.clientEmail, fx.sentinel.session, ...excluded]) {
    expect(egress, `a Sentry envelope carried ${s}`).not.toContain(s);
  }

  // BACK into the export (Codex P1 4302941126): it must come back as its OWN
  // analytics-free document, never inside the app page's document where the
  // Vercel scripts are running.
  await page.waitForLoadState("networkidle");
  vercel.length = 0;
  await page.goBack();
  await page.waitForURL((u) => u.href === exportUrl);
  await expect(page.getByTestId("export-session")).toHaveCount(1);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => typeof (window as unknown as { va?: unknown }).va), "window.va on the export after Back").toBe("undefined");
  expect(await page.evaluate(() => typeof (window as unknown as { si?: unknown }).si), "window.si on the export after Back").toBe("undefined");
  expect(
    await page.evaluate(() => [...document.scripts].map((x) => x.src).filter((src) => src.includes("/_vercel/"))),
    "a /_vercel/ script in the export document after Back",
  ).toEqual([]);
  expect(
    vercel.filter((v) => v.doc.includes("/records/export")),
    "Vercel telemetry requested on the export after Back",
  ).toEqual([]);
  // And the exit itself was a full document load.
  page.off("load", onLoad);
  expect(leftByFullLoad, "leaving the export by its exit was not a full document load").toBe(true);

  // THREE previews -> three audit rows, owner as actor, no PHI: the goto, the
  // raw-HTML request.get, and the Back above. The export is served no-store,
  // so Back is a fresh server render (never a back/forward-cache restore), and
  // that re-display is audited like any other preview.
  const ownerId = await getOwnerPractitionerId(fx.seed.studioId);
  const rows = await auditRows(fx.clientId);
  expect(rows.map((r) => r.action)).toEqual([
    "clinical_records_previewed",
    "clinical_records_previewed",
    "clinical_records_previewed",
  ]);
  for (const r of rows) {
    expect(r.actor_id).toBe(ownerId);
    expect(r.metadata).toEqual({ scope: "day", day: DAY });
  }
});

test("owner: printing is audited first, and the dialog opens only after", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  await loginByMagicLink(page, fx.seed.ownerEmail);
  await page.goto(`/clients/${fx.clientId}/records/export?scope=range&from=${DAY}&to=${DAY}`);
  const before = (await auditRows(fx.clientId)).length;

  await page.getByRole("button", { name: "Print" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

  // `before` was read after the page load, so it already counts that preview;
  // the click adds exactly one print row.
  const rows = await auditRows(fx.clientId);
  expect(rows.slice(before).map((r) => r.action)).toEqual(["clinical_records_printed"]);
  // Bound to THIS preview (Codex P1 4303617257): the print names the preview
  // row the page was rendered with, and audits that preview's own scope.
  const preview = rows[before - 1];
  expect(preview.action).toBe("clinical_records_previewed");
  expect(rows[rows.length - 1].metadata).toEqual({ scope: "range", from: DAY, to: DAY, preview_audit_id: preview.id });

  // The audited print ARMED the gate: the print view now carries the record,
  // still without any excluded sentinel. (window.print is stubbed, so no
  // afterprint fires and the gate stays armed for this check.)
  await page.emulateMedia({ media: "print" });
  const printed = await page.locator("body").innerText();
  expect(printed).toContain(fx.sentinel.session);
  expect(printed).toContain(fx.sentinel.clinicalNote);
  expect(printed).not.toContain("can only be printed with the Print button");
  for (const s of [fx.sentinel.privateWarning, fx.sentinel.personalNote, fx.sentinel.planning, fx.sentinel.deleted, fx.sentinel.outside]) {
    expect(printed, `print view leaked ${s}`).not.toContain(s);
  }
});

test("HON-46 journey: client record -> choose a date -> preview -> print, including an empty date", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  await loginByMagicLink(page, fx.seed.ownerEmail);
  const before = (await auditRows(fx.clientId)).length;

  // 1. The client record, where analytics IS live (positive control).
  await page.goto(`/clients/${fx.clientId}`);
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as { va?: unknown }).va), { timeout: 15_000 })
    .not.toBe("undefined");

  // 2. Its visible entry opens the export by a FULL document load.
  const entry = page.getByTestId("client-print-records");
  await expect(entry).toBeVisible();
  await expect(entry).toHaveText("Print treatment records");
  const loaded = page.waitForEvent("load");
  await entry.click();
  await loaded;
  await page.waitForURL((u) => u.pathname === `/clients/${fx.clientId}/records/export`);
  expect(await page.evaluate(() => typeof (window as unknown as { va?: unknown }).va), "analytics carried into the export").toBe("undefined");

  // 3. "One day" is the default; nothing is read or audited before Preview.
  await expect(page.getByRole("combobox", { name: "Scope" })).toHaveValue("day");
  await expect(page.getByRole("textbox", { name: "Treatment date" })).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByTestId("export-session")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Print" })).toHaveCount(0);
  expect((await auditRows(fx.clientId)).length).toBe(before);

  // 4. Choose the treatment date and preview: BOTH treatments that day, nothing
  //    from any other date, no private warning or personal note.
  await page.getByRole("textbox", { name: "Treatment date" }).fill(JOURNEY_DAY);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForURL((u) => u.searchParams.get("scope") === "day" && u.searchParams.get("day") === JOURNEY_DAY);
  await expect(page.getByTestId("export-session")).toHaveCount(2);
  await expect(page.getByTestId("export-session").nth(0)).toContainText(fx.sentinel.journeyMorning);
  await expect(page.getByTestId("export-session").nth(1)).toContainText(fx.sentinel.journeyAfternoon);
  // The day's clinical note is kept (Sam's decision).
  await expect(page.getByTestId("export-note")).toHaveCount(1);
  await expect(page.getByTestId("export-note")).toContainText(fx.sentinel.journeyNote);
  // The preview SAYS what will print: client, the selected date, both kinds.
  const journeyDate = formatClinicalDate(`${JOURNEY_DAY}T00:00:00+00:00`);
  const includes = page.getByTestId("export-includes");
  await expect(includes).toContainText("This print includes");
  await expect(includes).toContainText(fx.seed.clientName);
  await expect(includes).toContainText(`Treatment sessions and clinical notes recorded on ${journeyDate}.`);
  await expect(page.getByTestId("export-scope-label")).toHaveText(`Treatment date: ${journeyDate}`);
  const html = await page.content();
  for (const s of [
    fx.sentinel.journeyPrevDay,
    fx.sentinel.session,
    fx.sentinel.outside,
    fx.sentinel.clinicalNote,
    fx.sentinel.privateWarning,
    fx.sentinel.personalNote,
    fx.sentinel.planning,
  ]) {
    expect(html, `the ${JOURNEY_DAY} preview carried ${s}`).not.toContain(s);
  }

  // 5. Print: audited first, then the dialog; the print view is that day only.
  await page.getByRole("button", { name: "Print" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  await page.emulateMedia({ media: "print" });
  const printed = await page.locator("body").innerText();
  expect(printed).toContain(fx.sentinel.journeyMorning);
  expect(printed).toContain(fx.sentinel.journeyAfternoon);
  expect(printed).toContain(fx.sentinel.journeyNote);
  // The PRINTED page names the date and what it includes.
  expect(printed).toContain(`Treatment date: ${journeyDate}`);
  expect(printed).toContain("This print includes");
  expect(printed).toContain(`Treatment sessions and clinical notes recorded on ${journeyDate}.`);
  expect(printed).not.toContain(formatClinicalDate(`${JOURNEY_PREV_DAY}T00:00:00+00:00`));
  expect(printed).not.toContain(fx.sentinel.journeyPrevDay);
  expect(printed).not.toContain(fx.sentinel.privateWarning);
  await page.emulateMedia({ media: "screen" });

  // 6. An EMPTY date says so, and offers nothing to print.
  await page.getByRole("textbox", { name: "Treatment date" }).fill(EMPTY_DAY);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.waitForURL((u) => u.searchParams.get("day") === EMPTY_DAY);
  await expect(page.getByTestId("export-empty")).toContainText("No treatments were recorded on");
  await expect(page.getByTestId("export-includes")).toHaveCount(0);
  await expect(page.getByTestId("export-session")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Print" })).toHaveCount(0);

  // The audit trail of the whole journey: preview, print, preview (empty).
  const rows = (await auditRows(fx.clientId)).slice(before);
  expect(rows.map((r) => [r.action, r.metadata])).toEqual([
    ["clinical_records_previewed", { scope: "day", day: JOURNEY_DAY }],
    // Bound to the preview on screen (Codex P1 4303617257).
    ["clinical_records_printed", { scope: "day", day: JOURNEY_DAY, preview_audit_id: rows[0].id }],
    ["clinical_records_previewed", { scope: "day", day: EMPTY_DAY }],
  ]);
});

test("the export document makes no telemetry or third-party request, and none carries its URL (Codex P1 4303921817)", async ({
  page,
}) => {
  await loginByMagicLink(page, fx.seed.ownerEmail);
  type Seen = { url: string; referer: string | undefined };
  const record = (into: Seen[]) => (r: import("@playwright/test").Request) =>
    into.push({ url: r.url(), referer: r.headers()["referer"] });

  // POSITIVE CONTROL: on an ordinary app page the recorder DOES see
  // same-origin requests carrying the page URL as Referer, so the absence
  // asserted below is observed, not assumed.
  const control: Seen[] = [];
  page.on("request", record(control));
  await page.goto(`/clients/${fx.clientId}`);
  await page.waitForLoadState("networkidle");
  expect(
    control.some((c) => c.referer?.includes(`/clients/${fx.clientId}`)),
    "the recorder saw no Referer at all, so the check below would be vacuous",
  ).toBe(true);

  // The export, in a FRESH tab (same signed-in context) so no request from the
  // previous document (unload beacons) can be attributed to it.
  const tab = await page.context().newPage();
  const seen: Seen[] = [];
  tab.on("request", record(seen));
  const exportPath = `/clients/${fx.clientId}/records/export`;
  const res = await tab.goto(`${exportPath}?scope=day&day=${JOURNEY_DAY}`);
  // Asserted LAST, so that with the fix reverted the request inventory itself
  // (the observable leak) is what fails first.
  const referrerPolicy = res?.headers()["referrer-policy"];
  await expect(tab.getByTestId("export-session")).toHaveCount(2);
  await tab.waitForLoadState("networkidle");
  // SDK inits fire after hydration; give any of them time to show up.
  await tab.waitForTimeout(3_000);

  const origin = new URL(tab.url()).origin;
  const web = seen.filter((r) => /^https?:/.test(r.url));
  expect(web.length, "the inventory recorded nothing").toBeGreaterThan(0);
  expect(
    web.filter((r) => new URL(r.url).origin !== origin).map((r) => r.url),
    "a third-party request from the export",
  ).toEqual([]);
  expect(
    web.filter((r) => /^\/(ingest|monitoring|_vercel)(\/|$)/.test(new URL(r.url).pathname)).map((r) => r.url),
    "a telemetry request from the export",
  ).toEqual([]);
  expect(
    web.filter((r) => r.referer?.includes("/records/export")).map((r) => `${r.url} <- ${r.referer}`),
    "a request from the export carried its URL as Referer",
  ).toEqual([]);
  expect(referrerPolicy, "the export's Referrer-Policy header").toBe("no-referrer");
  await tab.close();
});

test("owner: one session is reachable from the audited range view and exports alone", async ({ page }) => {
  await loginByMagicLink(page, fx.seed.ownerEmail);
  await page.goto(`/clients/${fx.clientId}/records/export?scope=range&from=${DAY}&to=${OUTSIDE_DAY}`);
  // Two live sessions in this range (the in-scope day and the later one).
  await expect(page.getByTestId("export-session")).toHaveCount(2);
  const before = (await auditRows(fx.clientId)).length;

  await page.getByTestId("export-session-link").first().click();
  await expect(page).toHaveURL(/scope=session&session=/);
  await expect(page.getByTestId("export-session")).toHaveCount(1);
  await expect(page.getByText(fx.sentinel.session)).toBeVisible();
  await expect(page.getByText(fx.sentinel.outside)).toHaveCount(0);
  // A single-session view offers no further session link.
  await expect(page.getByTestId("export-session-link")).toHaveCount(0);
  // And it carries NO clinical notes, even the one dated that day (Codex P1
  // 4302690099): notes are not session-linked. The page says why.
  await expect(page.getByTestId("export-note")).toHaveCount(0);
  await expect(page.getByText(fx.sentinel.clinicalNote)).toHaveCount(0);
  await expect(page.getByTestId("export-notes-session-scope")).toBeVisible();

  const rows = await auditRows(fx.clientId);
  expect(rows.slice(before).map((r) => r.action)).toEqual(["clinical_records_previewed"]);
  expect(rows[rows.length - 1].metadata.scope).toBe("session");
});

test("a signed-out request is sent to login, gets no record data, and writes no audit row", async ({ browser }) => {
  // A fresh context: no session cookie at all. The route left app/(app), and
  // a layout redirect never gates a page, so this proves the middleware and
  // the page's own requirePractitionerWithStudio() both still apply.
  const context = await browser.newContext();
  const page = await context.newPage();
  const before = (await auditRows(fx.clientId)).length;
  const res = await page.goto(`/clients/${fx.clientId}/records/export?scope=day&day=${DAY}`);
  await expect(page).toHaveURL(/\/login/);
  const html = (await res?.text()) ?? "";
  for (const s of [fx.sentinel.session, fx.sentinel.clinicalNote, fx.sentinel.entry, fx.seed.clientName]) {
    expect(html, `signed-out response leaked ${s}`).not.toContain(s);
    expect(await page.content()).not.toContain(s);
  }
  expect((await auditRows(fx.clientId)).length).toBe(before);
  await context.close();
});

test("a practitioner who is not the owner is refused and no audit row is written", async ({ page }) => {
  const member = await seedE2eMember(fx.seed);
  const before = (await auditRows(fx.clientId)).length;
  await loginByMagicLink(page, member.email);
  await page.goto(`/clients/${fx.clientId}/records/export?scope=day&day=${DAY}`);
  await expect(page.getByText("Only the studio owner can export clinical records.")).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(fx.sentinel.session);
  expect((await auditRows(fx.clientId)).length).toBe(before);
});

test("another studio's owner gets not-found and no audit row is written", async ({ page }) => {
  const other = await seedE2eStudio();
  const before = (await auditRows(fx.clientId)).length;
  await loginByMagicLink(page, other.ownerEmail);
  const res = await page.goto(`/clients/${fx.clientId}/records/export?scope=day&day=${DAY}`);
  expect(res?.status()).toBe(404);
  expect(await page.content()).not.toContain(fx.sentinel.session);
  expect((await auditRows(fx.clientId)).length).toBe(before);
});
