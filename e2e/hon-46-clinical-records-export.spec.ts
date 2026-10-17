import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
import { markSentryEgress, readSentryEgress } from "./helpers/sentry-egress";
import {
  getOwnerPractitionerId,
  getStudioTimezone,
  seedE2eMember,
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

type Fixture = {
  seed: E2eSeed;
  clientId: string;
  sentinel: Record<
    | "session"
    | "entry"
    | "block"
    | "probeLot"
    | "clinicalNote"
    | "privateWarning"
    | "personalNote"
    | "planning"
    | "deleted"
    | "outside",
    string
  >;
};

let fx: Fixture;

async function auditRows(clientId: string) {
  return sql<{ action: string; actor_id: string; metadata: Record<string, string> }>(
    `select action, actor_id, metadata from public.audit_logs
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
  const tz = await getStudioTimezone(seed.studioId);
  const sentinel = {
    session: `SESSION-NOTE-${run}`,
    entry: `ENTRY-COMMENT-${run}`,
    block: `BLOCK-NOTE-${run}`,
    probeLot: `LOT-${run}`,
    clinicalNote: `CLINICAL-NOTE-${run}`,
    privateWarning: `PRIVATE-WARNING-${run}`,
    personalNote: `PERSONAL-NOTE-${run}`,
    planning: `PLANNING-NOTE-${run}`,
    deleted: `DELETED-SESSION-${run}`,
    outside: `OUTSIDE-RANGE-${run}`,
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
        reaction_type, tolerance_rating, block_notes)
     values ($1, $2, 0, 'upper lip', 'left', 'blend', 'Ballet F3', $3, 'mild_redness', 4, $4) returning id`,
    [seed.studioId, inScope.id, sentinel.probeLot, sentinel.block],
  );
  await sql(
    `insert into public.electrolysis_entries
       (session_id, block_id, area, thermolysis_intensity_percent, pulse_delay_seconds, observation_chips, comments)
     values ($1, $2, 'upper lip', 22, 1.5, '["good release"]'::jsonb, $3)`,
    [inScope.id, block.id, sentinel.entry],
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
  await sql(
    `insert into public.client_clinical_notes (studio_id, client_id, practitioner_id, kind, body, occurred_at)
     values ($1, $2, $3, 'consultation', $4, $5)`,
    [seed.studioId, client.id, ownerId, sentinel.clinicalNote, await at(DAY, "09:30")],
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
  const vercel: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/_vercel/")) vercel.push(r.url());
  });
  await page.goto(`/clients/${fx.clientId}`);
  await expect.poll(() => vercel.length, { timeout: 15_000 }).toBeGreaterThan(0);
  vercel.length = 0;

  const res = await page.goto(url);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["cache-control"] ?? "").toContain("no-store");

  await expect(page.getByTestId("export-session")).toHaveCount(1);
  await expect(page.getByText(fx.sentinel.session)).toBeVisible();
  await expect(page.getByTestId("export-entry")).toContainText(fx.sentinel.entry);
  // The CURRENT charting fields reach the document (Codex P1 4301165385).
  const blockEl = page.getByTestId("export-block");
  await expect(blockEl).toContainText("upper lip · left");
  await expect(blockEl).toContainText("Probe: Ballet F3");
  await expect(blockEl).toContainText(`Probe lot: ${fx.sentinel.probeLot}`);
  await expect(blockEl).toContainText("Reaction: mild_redness");
  await expect(blockEl).toContainText(fx.sentinel.block);
  await expect(blockEl).toContainText("Thermolysis intensity: 22 %");
  await expect(blockEl).toContainText("Pulse delay: 1.5 s");
  await expect(blockEl).toContainText("Observed: good release");

  // No Vercel script or beacon on the export document.
  await page.waitForLoadState("networkidle");
  expect(vercel, "the export loaded Vercel telemetry").toEqual([]);
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

  // THE PRINT VIEW: what printing would put on paper (print stylesheet, app
  // chrome hidden) has the record and none of the excluded sentinels.
  await page.emulateMedia({ media: "print" });
  const printed = await page.locator("body").innerText();
  expect(printed).toContain(fx.sentinel.session);
  expect(printed).toContain(fx.sentinel.clinicalNote);
  for (const s of excluded) expect(printed, `print view leaked ${s}`).not.toContain(s);
  await page.emulateMedia({ media: "screen" });

  // SENTRY NEGATIVE CONTROL (#828 item 6), made NON-VACUOUS: a synthetic
  // canary error is thrown on the export page, and the check only counts once
  // the egress guard has captured it. Then no captured envelope may carry the
  // client's id, name, email or any sentinel. Scope, stated honestly: the guard
  // records a SUMMARY of each envelope (transaction, message, exception
  // values), not the full payload, so this proves those fields only. Full
  // Sentry redaction is #891's (a merge prerequisite of this PR).
  const canary = `HON46-CANARY-${fx.seed.runId}`;
  await page.evaluate((msg) => {
    setTimeout(() => {
      throw new Error(msg);
    }, 0);
  }, canary);
  await expect
    .poll(() => JSON.stringify(readSentryEgress(egressMark)).includes(canary), { timeout: 20_000 })
    .toBe(true);
  const egress = JSON.stringify(readSentryEgress(egressMark));
  for (const s of [fx.clientId, fx.seed.clientName, fx.seed.clientEmail, fx.sentinel.session, ...excluded]) {
    expect(egress, `a Sentry envelope carried ${s}`).not.toContain(s);
  }

  // Two previews (goto + request.get) -> two audit rows, owner as actor, no PHI.
  const ownerId = await getOwnerPractitionerId(fx.seed.studioId);
  const rows = await auditRows(fx.clientId);
  expect(rows.map((r) => r.action)).toEqual(["clinical_records_previewed", "clinical_records_previewed"]);
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
  expect(rows[rows.length - 1].metadata).toEqual({ scope: "range", from: DAY, to: DAY });
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
