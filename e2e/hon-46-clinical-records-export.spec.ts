import { test, expect } from "@playwright/test";
import { loginByMagicLink } from "./helpers/flows";
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
    "session" | "entry" | "clinicalNote" | "privateWarning" | "personalNote" | "planning" | "deleted" | "outside",
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
  const [client] = await sql<{ id: string }>(
    `select id from public.clients where studio_id = $1 and email = $2`,
    [seed.studioId, seed.clientEmail],
  );
  const ownerId = await getOwnerPractitionerId(seed.studioId);
  const tz = await getStudioTimezone(seed.studioId);
  const sentinel = {
    session: `SESSION-NOTE-${run}`,
    entry: `ENTRY-COMMENT-${run}`,
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
  await sql(
    `insert into public.electrolysis_entries (session_id, area, comments) values ($1, 'upper lip', $2)`,
    [inScope.id, sentinel.entry],
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
  await loginByMagicLink(page, fx.seed.ownerEmail);
  const url = `/clients/${fx.clientId}/records/export?scope=day&day=${DAY}`;

  const res = await page.goto(url);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["cache-control"] ?? "").toContain("no-store");

  await expect(page.getByTestId("export-session")).toHaveCount(1);
  await expect(page.getByText(fx.sentinel.session)).toBeVisible();
  await expect(page.getByTestId("export-entry")).toContainText(fx.sentinel.entry);
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
