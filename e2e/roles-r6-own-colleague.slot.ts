import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seedE2eEndedAppointmentSession, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { seedAppointmentFor, seedStudioWithStaff, type StudioWithStaff } from "./helpers/multistaff-seed";
import { getRoles, jwtFor, saveRole } from "./helpers/roles-r1-client";
import { blockUnlessKeysReleased } from "./helpers/roles-release";

// Roles R6, OWN versus COLLEAGUE (OPS 3 Nov) and the aftercare timeline, at General's head with #1341 60f0ab3e1.
// Plan-stage: typechecked only, NEVER run until the slot. Real path only: the owner narrows the practitioner role with the real save
// command; a real signed-in practitioner browser session drives the UI; the captured server-action POST is replayed with the
// practitioner's own cookies against a COLLEAGUE's appointment id. Controls: own appointment allowed in the same state, the owner
// allowed on the colleague's appointment. A positive marker is required before any "refused" counts; a miss is BLOCKED, never a pass.
test.use({ bypassCSP: true });

const OUT = process.env.ROLES_R6_OUT;
const REASON = "Integrated verification of own versus colleague on a synthetic studio.";
const login = (p: Page, email: string) => (loginByMagicLink as (...a: unknown[]) => Promise<void>)(p, email, { openRowDetails: false });
type Row = { id: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "OBSERVED" | "RESIDUAL"; realPath: boolean; detail?: string };
const results: Row[] = [];
const ROWS_FILE = OUT ? path.join(OUT, "roles-r6-own-colleague.rows.jsonl") : null;
const rec = (r: Row) => {
  results.push(r);
  if (ROWS_FILE) { mkdirSync(OUT!, { recursive: true }); appendFileSync(ROWS_FILE, JSON.stringify(r) + "\n"); }
};
const rowsOnDisk = (): Row[] => (ROWS_FILE && existsSync(ROWS_FILE) ? readFileSync(ROWS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : results);

let A: StudioWithStaff;
let S = "";
let tOwner = "";
let ownerCtx: BrowserContext, p1Ctx: BrowserContext;
let op: Page, p1: Page;
let clientId = "", chartApptId = "";
const original = new Map<string, string>();
let slot = 0;

async function stateOf(key: string): Promise<{ version: number; eff: string }> {
  const g = (await getRoles(tOwner, S)).body;
  return { version: g.version as number, eff: g.roles?.practitioner?.[key]?.effective as string };
}
async function setScope(key: string, scope: "off" | "own" | "studio"): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const { version, eff } = await stateOf(key);
    if (eff === scope) return null;
    const r = (await saveRole(tOwner, S, version, { practitioner: { [key]: scope } }, REASON, true)).body;
    if (r?.ok) return null;
    if (r?.code === "stale_version") continue;
    return `save refused: ${String(r?.code ?? JSON.stringify(r)).slice(0, 120)}`;
  }
  return "save refused: stale_version after 3 tries";
}
const shot = async (p: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(path.join(OUT, "own-colleague-shots"), { recursive: true });
  await p.screenshot({ path: path.join(OUT, "own-colleague-shots", `${name}.png`), fullPage: true });
};
const apptRow = async (id: string) => (await sql<{ status: string; starts_at: string }>(`select status, starts_at::text as starts_at from public.appointments where id = $1`, [id]))[0];
const mk = (practitionerId: string) => seedAppointmentFor(S, practitionerId, clientId, 3000 + slot++ * 120); // distinct future slots: no studio-wide overlap
type Cap = { url: string; action: string; ct: string; body: string };
async function capture(p: Page, needle: string, drive: () => Promise<void>): Promise<Cap | undefined> {
  const caps: Cap[] = [];
  const h = (r: import("@playwright/test").Request) => {
    const a = r.headers()["next-action"];
    if (a && r.method() === "POST" && (r.postData() ?? "").includes(needle)) caps.push({ url: r.url(), action: a, ct: r.headers()["content-type"] ?? "", body: r.postData() ?? "" });
  };
  p.on("request", h);
  try { await drive(); await p.waitForTimeout(900); } finally { p.off("request", h); }
  return caps[caps.length - 1];
}
const replay = async (ctx: BrowserContext, cap: Cap, from: string, to: string) =>
  (await ctx.request.post(cap.url, { headers: { "Next-Action": cap.action, "Content-Type": cap.ct }, data: cap.body.split(from).join(to) })).text();

// A fresh stack has every key PENDING, which makes a stored Off inert: report BLOCKED (skipped, with the reason) instead of a false FAIL.
blockUnlessKeysReleased(test);

test.beforeAll(async ({ browser }) => {
  A = await seedStudioWithStaff();
  S = A.seed.studioId;
  tOwner = (await jwtFor(A.seed.ownerEmail)).token;
  // The Move dialog offers only generated available times; the staff seed sets no opening hours, so without this the dialog says "No available times". Synthetic studio only.
  await sql(`insert into public.studio_availability_default (studio_id, day_of_week, practitioner_id, is_open, open_time, close_time)
    select $1, d, null, true, '00:00', '23:45' from generate_series(0, 6) d
    on conflict (studio_id, day_of_week, practitioner_id) do update set is_open = true, open_time = '00:00', close_time = '23:45'`, [S]);
  const c = await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, clientEmail: `rbac-oc-${Date.now()}@harness.local` });
  clientId = c.clientId; chartApptId = c.appointmentId;
  for (const k of ["appt.move", "appt.cancel", "clin.view_aftercare", "clin.view_records"]) original.set(k, (await stateOf(k)).eff);
  ownerCtx = await browser.newContext({ bypassCSP: true });
  p1Ctx = await browser.newContext({ bypassCSP: true });
  for (const x of [ownerCtx, p1Ctx]) await x.route(/\/monitoring/, (r) => r.fulfill({ status: 200, body: "{}" })); // Sentry fence, browser side
  op = await ownerCtx.newPage(); p1 = await p1Ctx.newPage();
  await login(op, A.seed.ownerEmail);
  await login(p1, A.prac1.email);
});
test.afterAll(async () => {
  for (const [k, v] of original) if (v === "off" || v === "own" || v === "studio") await setScope(k, v as "off" | "own" | "studio");
  await ownerCtx?.close(); await p1Ctx?.close();
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "roles-r6-own-colleague.json"), JSON.stringify({ accepted: false, originalEffective: Object.fromEntries(original), results: rowsOnDisk() }, null, 1));
});

// ----------------------------------------------------------------------------------------------- appt.cancel at Own
test("appt.cancel at Own: own appointment allowed, a colleague's refused in the UI and on a direct replay", async () => {
  const id = "appt.cancel-own-vs-colleague";
  expect(await setScope("appt.cancel", "own"), "appt.cancel at Own").toBeNull();
  const mine = await mk(A.prac1.practitionerId), theirs = await mk(A.prac2.practitionerId), theirs2 = await mk(A.prac2.practitionerId);
  const notes: string[] = [];
  let ok = true;
  // UI, colleague first (nothing cancelled yet): the control is absent, or clicking it is refused; either way the row is unchanged.
  await p1.goto(`/calendar/${theirs}`);
  const btn = p1.getByRole("button", { name: "Cancel appointment" });
  let uiTheirs: string;
  if (await btn.count()) {
    await btn.click();
    const refused = await p1.getByText("You don't have permission to cancel this appointment.").first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    uiTheirs = refused ? "control shown, click refused with the sentence" : "control shown, click NOT refused";
    if (!refused) ok = false;
  } else uiTheirs = "control not offered";
  const unchanged = (await apptRow(theirs)).status !== "cancelled";
  if (!unchanged) ok = false;
  notes.push(`colleague's appointment, UI: ${uiTheirs}; row ${unchanged ? "unchanged" : "CANCELLED"}`);
  await shot(p1, "cancel-colleague-ui");
  // UI, own, capturing the POST.
  const cap = await capture(p1, mine, async () => { await p1.goto(`/calendar/${mine}`); await p1.getByRole("button", { name: "Cancel appointment" }).click(); });
  const mineDone = (await apptRow(mine)).status === "cancelled";
  notes.push(`own appointment, UI: ${mineDone ? "cancelled" : "NOT cancelled"}`);
  if (!mineDone || !cap) { rec({ id, status: "BLOCKED", realPath: false, detail: `positive marker missing (own cancel ${mineDone ? "worked" : "failed"}, capture ${cap ? "ok" : "missing"}); ${notes.join("; ")}` }); return test.skip(true, "no positive marker"); }
  // Direct replay against the colleague's id.
  const txt = await replay(p1Ctx, cap, mine, theirs);
  const replayRefused = (await apptRow(theirs)).status !== "cancelled";
  notes.push(`direct replay on the colleague's id: ${replayRefused ? "refused, row unchanged" : "ACCEPTED"} (${txt.slice(0, 0)}response ${txt.includes("permission") ? "names the permission" : "no permission sentence"})`);
  if (!replayRefused) ok = false;
  // Owner control on a colleague's appointment in the same state.
  await replay(ownerCtx, cap, mine, theirs2);
  const ownerOk = (await apptRow(theirs2)).status === "cancelled";
  notes.push(`owner on a colleague's appointment: ${ownerOk ? "allowed" : "NOT allowed"}`);
  if (!ownerOk) ok = false;
  rec({ id, status: ok ? "PASS" : "FAIL", realPath: true, detail: notes.join("; ") });
  expect(ok).toBe(true);
});

// ----------------------------------------------------------------------------------------------- appt.move at Own
test("appt.move at Own: own appointment allowed, a colleague's refused in the UI and on a direct replay", async () => {
  const id = "appt.move-own-vs-colleague";
  expect(await setScope("appt.move", "own"), "appt.move at Own").toBeNull();
  const mine = await mk(A.prac1.practitionerId), theirs = await mk(A.prac2.practitionerId), theirs2 = await mk(A.prac2.practitionerId);
  const notes: string[] = [];
  let ok = true;
  let dialogError = "";
  const dialogMove = async (apptId: string) => {
    await p1.goto(`/calendar/${apptId}`);
    await p1.getByRole("button", { name: "Move appointment" }).first().click();
    const dlg = p1.getByRole("dialog", { name: "Move appointment" });
    try {
      // The first time (12:00 AM) is preselected: pick the SECOND so the move is a real change. The confirm button is "Move appointment".
      await dlg.getByRole("button", { name: /^\d{1,2}:\d{2}\s?[AP]M$/ }).nth(1).click({ timeout: 10_000 });
      await dlg.getByRole("button", { name: /^Move appointment$/ }).click({ timeout: 10_000 });
    } catch (e) {
      // Say what the dialog showed instead (for example "No available times on this date.") rather than timing out silently.
      dialogError = `${(await dlg.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 200)} | ${String(e).split("\n")[0].slice(0, 120)}`;
      await shot(p1, "move-dialog-miss");
      throw e;
    }
  };
  // UI, colleague's: the control is absent, or the move is refused; the row is unchanged either way.
  const before = (await apptRow(theirs)).starts_at;
  await p1.goto(`/calendar/${theirs}`);
  let uiTheirs: string;
  if (await p1.getByRole("button", { name: "Move appointment" }).count()) {
    let refused = false;
    try { await dialogMove(theirs); refused = await p1.getByText("You don't have permission to move this appointment.").first().waitFor({ timeout: 8000 }).then(() => true, () => false); } catch { refused = false; }
    uiTheirs = refused ? "control shown, move refused with the sentence" : "control shown, move NOT refused (or the dialog could not be driven)";
    if (!refused) ok = false;
  } else uiTheirs = "control not offered";
  const unchanged = (await apptRow(theirs)).starts_at === before;
  if (!unchanged) ok = false;
  notes.push(`colleague's appointment, UI: ${uiTheirs}; time ${unchanged ? "unchanged" : "MOVED"}`);
  await shot(p1, "move-colleague-ui");
  // UI, own, capturing the POST.
  const mineBefore = (await apptRow(mine)).starts_at;
  let cap: Cap | undefined;
  try { cap = await capture(p1, mine, () => dialogMove(mine)); } catch { cap = undefined; }
  const moved = (await apptRow(mine)).starts_at !== mineBefore;
  notes.push(`own appointment, UI: ${moved ? "moved" : "NOT moved"}`);
  if (!moved || !cap) { rec({ id, status: "BLOCKED", realPath: false, detail: `positive marker missing (own move ${moved ? "worked" : "failed or no slot offered"}, capture ${cap ? "ok" : "missing"}); dialog said: ${dialogError || "n/a"}; ${notes.join("; ")}` }); return test.skip(true, "no positive marker"); }
  const t2 = (await apptRow(theirs)).starts_at;
  const txt = await replay(p1Ctx, cap, mine, theirs);
  const refused = (await apptRow(theirs)).starts_at === t2;
  notes.push(`direct replay on the colleague's id: ${refused ? "refused, time unchanged" : "ACCEPTED"} (response ${txt.includes("permission") ? "names the permission" : "no permission sentence"})`);
  if (!refused) ok = false;
  const t3 = (await apptRow(theirs2)).starts_at;
  const mask = (t: string) => t.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/\s+/g, " ").slice(0, 300);
  // The own move already took the captured slot, so replaying it for the owner would answer "conflict" (seen at 134aeaa0b), which says nothing about
  // permission. The owner's control targets the colleague's appointment's OWN expected times and a slot four days later that nothing occupies.
  const iso = (await sql<{ iso: string }>(`select to_char(starts_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as iso from public.appointments where id = $1`, [theirs2]))[0]!.iso;
  const st = new Date(iso);
  const arr = JSON.parse(cap.body.split(mine).join(theirs2)) as Array<Record<string, unknown>>;
  const [yy, mm, dd] = String(arr[0]!.localDate).split("-").map(Number);
  const later = new Date(Date.UTC(yy!, mm! - 1, dd! + 4)).toISOString().slice(0, 10);
  arr[0] = { ...arr[0], expectedStartsAt: st.toISOString(), expectedEndsAt: new Date(st.getTime() + 60 * 60_000).toISOString(), localDate: later, localTime: "03:00" };
  const ownerTxt = await (await ownerCtx.request.post(cap.url, { headers: { "Next-Action": cap.action, "Content-Type": cap.ct }, data: JSON.stringify(arr) })).text();
  const ownerOk = (await apptRow(theirs2)).starts_at !== t3;
  // Record what the OWNER's replay returned (ids masked) and the captured action body shape, so a refusal, a slot conflict and an accepted move can be told apart.
  notes.push(`owner on a colleague's appointment: ${ownerOk ? "allowed" : "NOT allowed"}; owner response: [${mask(ownerTxt)}]; captured body: [${mask(cap.body)}]`);
  if (!ownerOk) ok = false;
  rec({ id, status: ok ? "PASS" : "FAIL", realPath: true, detail: `${notes.join("; ")}. appt.move is deny_only: Own is the snapshot value.` });
  expect(ok).toBe(true);
});

// ----------------------------------------------------------------------------------------------- aftercare timeline
test("clin.view_aftercare off: the Sessions-tab timeline shows the notice and no postcare send time or attempts", async () => {
  const id = "clin.view_aftercare-timeline";
  const SENT = "2026-10-30T15:42:00.000Z";
  await sql(`update public.appointments set postcare_email_sent_at = $2, postcare_email_send_attempts = 3 where id = $1`, [chartApptId, SENT]); // synthetic fixture state
  expect(await setScope("clin.view_records", "studio")).toBeNull(); // the timeline needs the chart key; only aftercare goes off
  expect(await setScope("clin.view_aftercare", "studio")).toBeNull();
  const url = `/clients/${clientId}?tab=sessions`;
  const openGroups = async (p: Page) => { await p.evaluate(() => document.querySelectorAll("details").forEach((d) => { (d as HTMLDetailsElement).open = true; })); };
  await p1.goto(url); await openGroups(p1);
  const onMarker = await p1.getByText(/Postcare sent/).first().isVisible().catch(() => false);
  const onAttempts = await p1.getByText(/3 attempts/).first().isVisible().catch(() => false);
  if (!onMarker) { rec({ id, status: "BLOCKED", realPath: false, detail: "positive marker missing: with the key on the timeline did not show 'Postcare sent' (tab or fixture not as expected)" }); await shot(p1, "aftercare-on-miss"); return test.skip(true, "no positive marker"); }
  expect(await setScope("clin.view_aftercare", "off")).toBeNull();
  await p1.goto(url); await openGroups(p1);
  const notice = await p1.getByTestId("aftercare-not-available").isVisible().catch(() => false);
  const noticeText = notice ? ((await p1.getByTestId("aftercare-not-available").textContent()) ?? "").trim() : "";
  const sentGone = (await p1.getByText(/Postcare sent/).count()) === 0;
  const attemptsGone = (await p1.getByText(/\d+ attempts/).count()) === 0;
  // The raw page payload as well: the send time must not be in the response at all, not merely hidden.
  const html = await (await p1Ctx.request.get(url)).text();
  const notInPayload = !html.includes("2026-10-30T15:42") && !html.includes("postcare_email_sent_at");
  await shot(p1, "aftercare-off-timeline");
  // owner control in the same state
  await op.goto(url); await openGroups(op);
  const ownerSees = await op.getByText(/Postcare sent/).first().isVisible().catch(() => false);
  const ok = notice && noticeText === "Aftercare details are not available to your role." && sentGone && attemptsGone && notInPayload && ownerSees;
  rec({
    id, status: ok ? "PASS" : "FAIL", realPath: true,
    detail: `on: 'Postcare sent' shown${onAttempts ? " with attempts" : ""}; off: notice ${notice ? `shown ("${noticeText}")` : "MISSING"}, send time ${sentGone ? "absent" : "PRESENT"}, attempts ${attemptsGone ? "absent" : "PRESENT"}, send time ${notInPayload ? "not in the page payload" : "IN the page payload"}; owner in the same state ${ownerSees ? "still sees it" : "does NOT"}`,
  });
  await setScope("clin.view_aftercare", "studio");
  expect(ok).toBe(true);
});

test("summary: every own-vs-colleague and timeline row is recorded", async () => {
  const need = ["appt.cancel-own-vs-colleague", "appt.move-own-vs-colleague", "clin.view_aftercare-timeline"];
  const have = new Set(rowsOnDisk().map((r) => r.id));
  const missing = need.filter((n) => !have.has(n));
  expect(missing, `rows without a result: ${missing.join(", ")}`).toEqual([]);
});
