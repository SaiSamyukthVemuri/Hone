import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seedE2eEndedAppointmentSession, seedE2eIntake, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { markResendLedger, readResendLedger } from "./helpers/resend-ledger";
import { seedStudioWithStaff, type StudioWithStaff } from "./helpers/multistaff-seed";
import { getRoles, jwtFor, rpc, saveRole } from "./helpers/roles-r1-client";
import { blockUnlessKeysReleased } from "./helpers/roles-release";

// Roles R6, AFFECTED BEHAVIOUR of Team's #1341 523c387fa (gated chart writes, intake link rule, assisted intake, inactive-by-prerequisite).
// Plan-stage: typechecked only, NEVER run until the slot. Every row is NOT RUN until it exercises the real path.
//
// Real path only: the owner changes the practitioner role with the real R1 save command (real GoTrue JWT through PostgREST); a real
// signed-in practitioner browser session captures the server-action POST while the key is ON (an OPEN TAB); the key is then turned OFF
// and the captured POST is REPLAYED with the practitioner's own cookies and a CHANGED payload (so a refusal cannot be mistaken for a no-op).
// Matched controls: the key ON accepts, and the OWNER replays the same payload in the same denied state. Positive markers are required
// before any "refused" assertion counts; a missing marker is a BLOCKED row, never a pass. Synthetic data, owned isolated stack, fake providers.
test.use({ bypassCSP: true });

const OUT = process.env.ROLES_R6_OUT;
const REASON = "Integrated verification of the affected behaviour on a synthetic studio.";
const login = (p: Page, email: string) => (loginByMagicLink as (...a: unknown[]) => Promise<void>)(p, email, { openRowDetails: false });
const NOT_AVAILABLE = "Not available to your role."; // the chart actions' refusal sentence at 523c387fa
const ASSISTED_NOT_PERMITTED = "This intake can no longer be completed with the client.";
const START_NOT_PERMITTED = "This client's intake cannot be started from here.";

type Row = { id: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "OBSERVED" | "RESIDUAL"; realPath: boolean; detail?: string };
const results: Row[] = [];
const ROWS_FILE = OUT ? path.join(OUT, "roles-r6-affected-behaviour.rows.jsonl") : null;
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
let chart: { clientId: string; sessionId: string };
let intakeClient: { clientId: string; email: string; intakeId: string };
const original = new Map<string, string>();

async function stateOf(key: string): Promise<{ version: number; eff: string }> {
  const g = (await getRoles(tOwner, S)).body;
  return { version: g.version as number, eff: g.roles?.practitioner?.[key]?.effective as string };
}
/** Owner sets the PRACTITIONER role's scope with the real save command. Returns a refusal summary instead of throwing. */
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
  mkdirSync(path.join(OUT, "affected-shots"), { recursive: true });
  await p.screenshot({ path: path.join(OUT, "affected-shots", `${name}.png`), fullPage: true });
};

type Cap = { url: string; action: string; ct: string; body: string };
/** Runs `drive` and captures the server-action POSTs whose body contains `needle`. */
async function capture(p: Page, needle: string, drive: () => Promise<void>): Promise<Cap | undefined> {
  const caps: Cap[] = [];
  const h = (r: import("@playwright/test").Request) => {
    const a = r.headers()["next-action"];
    if (a && r.method() === "POST" && (r.postData() ?? "").includes(needle)) caps.push({ url: r.url(), action: a, ct: r.headers()["content-type"] ?? "", body: r.postData() ?? "" });
  };
  p.on("request", h);
  try { await drive(); await p.waitForTimeout(800); } finally { p.off("request", h); }
  return caps[caps.length - 1];
}
async function replay(ctx: BrowserContext, cap: Cap, edit: (b: string) => string = (b) => b): Promise<string> {
  const res = await ctx.request.post(cap.url, { headers: { "Next-Action": cap.action, "Content-Type": cap.ct }, data: edit(cap.body) });
  return res.text();
}
const blocked = (id: string, detail: string) => { rec({ id, status: "BLOCKED", realPath: false, detail }); test.skip(true, detail); };

// A fresh stack has every key PENDING, which makes a stored Off inert: report BLOCKED (skipped, with the reason) instead of a false FAIL.
blockUnlessKeysReleased(test);

test.beforeAll(async ({ browser }) => {
  A = await seedStudioWithStaff();
  S = A.seed.studioId;
  tOwner = (await jwtFor(A.seed.ownerEmail)).token;
  const c1 = await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, clientEmail: `rbac-aff-chart-${Date.now()}@harness.local` });
  chart = { clientId: c1.clientId, sessionId: c1.sessionId };
  const email = `success+rbac-aff-intake-${Date.now()}@harness.local`;
  const c2 = await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, clientEmail: email, endedHoursAgo: 10 }); // distinct slot: appointments cannot overlap studio-wide
  intakeClient = { clientId: c2.clientId, email, intakeId: await seedE2eIntake(S, c2.clientId, "in_progress", { has_allergies: "no" }) };
  for (const k of ["clin.view_records", "clin.view_intake", "clin.edit_records"]) original.set(k, (await stateOf(k)).eff);
  ownerCtx = await browser.newContext({ bypassCSP: true });
  p1Ctx = await browser.newContext({ bypassCSP: true });
  for (const c of [ownerCtx, p1Ctx]) await c.route(/\/monitoring/, (r) => r.fulfill({ status: 200, body: "{}" })); // Sentry fence, browser side
  op = await ownerCtx.newPage(); p1 = await p1Ctx.newPage();
  await login(op, A.seed.ownerEmail);
  await login(p1, A.prac1.email);
});
test.afterAll(async () => {
  for (const [k, v] of original) if (v === "off" || v === "own" || v === "studio") await setScope(k, v as "off" | "own" | "studio");
  await ownerCtx?.close(); await p1Ctx?.close();
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "roles-r6-affected-behaviour.json"), JSON.stringify({ accepted: false, originalEffective: Object.fromEntries(original), results: rowsOnDisk() }, null, 1));
});

// ------------------------------------------------------------------------- 1. open-tab replay of chart actions, clin.view_records off
test("clin.view_records: chart writes replayed from an open tab are refused when the key goes off", async () => {
  const id = "clin.view_records-open-tab-chart-action-replay";
  const sessionUrl = `/clients/${chart.clientId}/sessions/${chart.sessionId}`;
  expect(await setScope("clin.view_records", "studio"), "view_records on").toBeNull();
  const note = (await sql<{ next_session_note: string | null }>(`select next_session_note from public.sessions where id = $1`, [chart.sessionId]));
  const notes: string[] = [];
  let anyFail = false;

  // (a) next-session note
  const N1 = `RBAC-AFF-NOTE-A-${Date.now()}`, N2 = `RBAC-AFF-NOTE-B-${Date.now()}`, N3 = `RBAC-AFF-NOTE-C-${Date.now()}`;
  await p1.goto(sessionUrl);
  const capNote = await capture(p1, chart.sessionId, async () => {
    await p1.getByPlaceholder(/Upper lip: start lower/).fill(N1);
    await p1.getByRole("button", { name: "Save note" }).click();
  });
  const readNote = async () => (await sql<{ n: string | null }>(`select next_session_note as n from public.sessions where id = $1`, [chart.sessionId]))[0]?.n;
  if (!capNote || (await readNote()) !== N1) { rec({ id: `${id}:next-session-note`, status: "BLOCKED", realPath: false, detail: "could not capture a saving POST with the key on (positive marker missing)" }); anyFail = true; }
  else {
    // control 1: ON accepts a changed payload
    const onTxt = await replay(p1Ctx, capNote, (b) => b.split(N1).join(N2));
    const onOk = (await readNote()) === N2;
    expect(await setScope("clin.view_records", "off"), "view_records off (the tab stays open)").toBeNull();
    const offTxt = await replay(p1Ctx, capNote, (b) => b.split(N1).join(N3));
    const refused = (await readNote()) === N2 && offTxt.includes(NOT_AVAILABLE);
    const ownerTxt = await replay(ownerCtx, capNote, (b) => b.split(N1).join(N3));
    const ownerOk = (await readNote()) === N3;
    notes.push(`next-session note: on ${onOk ? "accepted" : "NOT accepted"}; off ${refused ? "refused with the sentence and unchanged" : "NOT refused"}; owner in the same state ${ownerOk ? "accepted" : "NOT accepted"}`);
    if (!(onOk && refused && ownerOk)) anyFail = true;
    void onTxt; void ownerTxt;
    await setScope("clin.view_records", "studio");
  }

  // (b) edit session start time
  const fmt = (ms: number) => { const d = new Date(Date.now() - ms); const z = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
  const T1 = fmt(5 * 3600e3), T2 = fmt(7 * 3600e3), T3 = fmt(9 * 3600e3);
  await p1.goto(sessionUrl);
  const readStart = async () => String((await sql<{ s: string }>(`select started_at::text as s from public.sessions where id = $1`, [chart.sessionId]))[0]?.s);
  const capStart = await capture(p1, T1, async () => {
    await p1.getByRole("button", { name: "Edit time" }).click();
    await p1.locator('input[type="datetime-local"]').fill(T1);
    await p1.getByRole("button", { name: "Save", exact: true }).click();
  });
  const afterCap = await readStart();
  if (!capStart) { rec({ id: `${id}:edit-start-time`, status: "BLOCKED", realPath: false, detail: "could not capture the edit-time POST with the key on (positive marker missing)" }); anyFail = true; }
  else {
    expect(await setScope("clin.view_records", "off")).toBeNull();
    const offTxt = await replay(p1Ctx, capStart, (b) => b.split(T1).join(T2));
    const refused = (await readStart()) === afterCap && offTxt.includes(NOT_AVAILABLE);
    await replay(ownerCtx, capStart, (b) => b.split(T1).join(T3));
    const ownerOk = (await readStart()) !== afterCap;
    notes.push(`edit start time: off ${refused ? "refused and unchanged" : "NOT refused"}; owner in the same state ${ownerOk ? "accepted" : "NOT accepted"}`);
    if (!(refused && ownerOk)) anyFail = true;
    await setScope("clin.view_records", "studio");
  }
  void note;
  // (c) the rest of the gated chart writes (remove entry, void session or block, remove area, whole-session copy commit, machine setup and
  // readings, block create/update, treatment area create/update, add entry) are NOT driven here: no stable UI path was confirmed at 523c387fa.
  rec({ id, status: anyFail ? "FAIL" : "PASS", realPath: true, detail: `${notes.join("; ")}. NOT RUN in this file: remove entry, void session/block, remove area, whole-session copy commit, machine setup/readings, block and area create/update, add entry.` });
  await shot(p1, "chart-replay-final");
  expect(anyFail, "every captured chart write is refused with the key off and accepted for the owner").toBe(false);
});

// ------------------------------------------------------------------------- 2. intake resend returns no URL when clin.view_intake is off
test("clin.view_intake: resend returns no intake URL when off, and the email still goes", async () => {
  const id = "clin.view_intake-resend-no-url";
  expect(await setScope("clin.view_intake", "studio")).toBeNull();
  // The resend is rate limited per practitioner and client, so every send in this test goes to its OWN client with its own in-progress
  // intake: ON capture (client A, practitioner), OFF replay (client B, same practitioner), owner control (client C, owner).
  const mkIntakeClient = async (hours: number) => {
    const email = `success+rbac-aff-resend-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@harness.local`;
    const c = await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, clientEmail: email, endedHoursAgo: hours });
    return { clientId: c.clientId, email, intakeId: await seedE2eIntake(S, c.clientId, "in_progress", { has_allergies: "no" }) };
  };
  const cA = await mkIntakeClient(22), cB = await mkIntakeClient(26), cC = await mkIntakeClient(30);
  const sent = (m: ReturnType<typeof markResendLedger>, email: string) => readResendLedger(m).filter((r) => r.to === email).length;
  // The action's return object, parsed from the Flight text: the first {"ok":...} object. NEVER inferred from the card UI.
  const result = (txt: string): { ok?: boolean; intakeUrl?: string | null; emailSent?: boolean; error?: string } | null => {
    const m = txt.match(/\{"ok":(?:true|false)[^\n]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  };
  const mask = (t: string) => t.slice(0, 260).replace(/https?:\/\/\S+/g, "<url>");
  await p1.goto(`/clients/${cA.clientId}?tab=health`); // the resend card lives on the Health & Forms tab
  const markA = markResendLedger();
  const cap = await capture(p1, cA.intakeId, async () => { await p1.getByRole("button", { name: /^(re)?send/i }).first().click({ timeout: 10_000 }); });
  if (!cap) { await shot(p1, "resend-capture-miss"); return blocked(id, "could not capture the resend POST with the key on"); }
  expect(await waitUntil(async () => sent(markA, cA.email) > 0), "positive marker: the ON resend emailed client A").toBe(true);
  const swap = (b: string, to: { clientId: string; intakeId: string }) => b.split(cA.intakeId).join(to.intakeId).split(cA.clientId).join(to.clientId);
  const onTxt = await (await p1Ctx.request.post(cap.url, { headers: { "Next-Action": cap.action, "Content-Type": cap.ct }, data: swap(cap.body, { clientId: cA.clientId, intakeId: cA.intakeId }) })).text().catch(() => "");
  void onTxt;
  expect(await setScope("clin.view_intake", "off")).toBeNull();
  const markB = markResendLedger();
  const offTxt = await replay(p1Ctx, cap, (b) => swap(b, cB)); // the practitioner's own cookies, client B
  const offRes = result(offTxt);
  const emailB = await waitUntil(async () => sent(markB, cB.email) > 0);
  const ownerTxt = await replay(ownerCtx, cap, (b) => swap(b, cC)); // the owner's cookies, client C, same denied state
  const ownerRes = result(ownerTxt);
  const detail = `off (practitioner, client B): ${offRes ? `ok=${offRes.ok} intakeUrl=${offRes.intakeUrl === null ? "null" : offRes.intakeUrl ? "HAS A VALUE" : "absent"} emailSent=${offRes.emailSent} error=${offRes.error ?? "-"}` : "no parsable result"}; email to B ${emailB ? "sent (ledger +1)" : "not seen"}; owner (client C): ${ownerRes ? `ok=${ownerRes.ok} intakeUrl=${ownerRes.intakeUrl ? "HAS A VALUE" : String(ownerRes.intakeUrl)} error=${ownerRes.error ?? "-"}` : "no parsable result"}. raw off: [${mask(offTxt)}] raw owner: [${mask(ownerTxt)}]`;
  const usable = offRes?.ok === true && ownerRes?.ok === true;
  const leak = offRes?.ok === true && !!offRes.intakeUrl;
  rec({
    id, realPath: true,
    // An { ok:false } (a refusal or a rate limit) is NOT read as present or absent: it makes the row BLOCKED, never a pass or a leak.
    status: leak ? "FAIL" : !usable ? "BLOCKED" : offRes.intakeUrl === null && !!ownerRes.intakeUrl && emailB ? "PASS" : "FAIL",
    detail,
  });
  await setScope("clin.view_intake", "studio");
  expect(leak, "no intake URL is returned with the key off").toBe(false);
  expect(usable, "both responses were ok:true results (not refusals or rate limits)").toBe(true);
  expect(ownerRes?.intakeUrl, "the owner still gets the URL").toBeTruthy();
});

// ------------------------------------------------------------------------- 3. assisted intake start and step refused
test("clin.view_intake: assisted-intake start and step are refused when off", async () => {
  const id = "clin.view_intake-assisted-start-step-refused";
  expect(await setScope("clin.view_intake", "studio")).toBeNull();
  const notes: string[] = [];
  let fail = false;

  // step: capture the editor's own save while ON, then replay with the key OFF (the revision is stale by then on purpose: a permission
  // refusal must come BEFORE any revision check, and the owner's control must reach the revision check instead).
  await p1.goto(`/clients/${intakeClient.clientId}/intake/assist`);
  const capStep = await capture(p1, intakeClient.intakeId, async () => { await p1.getByRole("button", { name: "Save and leave" }).click({ timeout: 10_000 }); }); // Continue refuses blank required answers and never saves; Save and leave persists the step
  const revBefore = async () => JSON.stringify((await sql<{ revision: string; responses: unknown }>(`select revision::text, responses from public.client_intake_forms where id = $1`, [intakeClient.intakeId]))[0]);
  if (!capStep) { await shot(p1, "assist-step-capture-miss"); rec({ id: `${id}:step`, status: "BLOCKED", realPath: false, detail: "could not capture the assisted save-step POST with the key on" }); fail = true; }
  else {
    const snap = await revBefore();
    expect(await setScope("clin.view_intake", "off")).toBeNull();
    const offTxt = await replay(p1Ctx, capStep);
    const refused = offTxt.includes(ASSISTED_NOT_PERMITTED) && (await revBefore()) === snap;
    const ownerTxt = await replay(ownerCtx, capStep);
    const ownerPast = !ownerTxt.includes(ASSISTED_NOT_PERMITTED); // the owner passes the permission gate (stale revision or success are both fine)
    notes.push(`step: off ${refused ? "refused with the unchanged intake" : "NOT refused"}; owner reaches the revision check ${ownerPast ? "yes" : "NO"}`);
    if (!(refused && ownerPast)) fail = true;
    await setScope("clin.view_intake", "studio");
  }

  // start: a client with no intake. Capture while ON, replay against ANOTHER such client with the key OFF: no intake row may appear.
  let hrs = 38; // above the resend test's 22/26/30 hours-ago slots: the studio's reservations may not overlap
  const mkClient = async () => (await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, endedHoursAgo: (hrs += 4), clientEmail: `rbac-aff-start-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@harness.local` })).clientId;
  const c3 = await mkClient(), c4 = await mkClient();
  const count = async (cid: string) => Number((await sql<{ n: string }>(`select count(*)::text as n from public.client_intake_forms where client_id = $1`, [cid]))[0]?.n);
  await p1.goto(`/clients/${c3}?tab=health`); // the start button lives on the Health & Forms tab, gated on no intake
  const capStart = await capture(p1, c3, async () => { await p1.getByTestId("start-intake-with-client").click({ timeout: 10_000 }); });
  if (!capStart) { await shot(p1, "start-capture-miss"); rec({ id: `${id}:start`, status: "BLOCKED", realPath: false, detail: "could not capture the start POST with the key on" }); fail = true; }
  else {
    expect(await count(c3), "positive marker: ON start created an intake").toBeGreaterThan(0);
    expect(await setScope("clin.view_intake", "off")).toBeNull();
    const offTxt = await replay(p1Ctx, capStart, (b) => b.split(c3).join(c4));
    const refused = offTxt.includes(START_NOT_PERMITTED) && (await count(c4)) === 0;
    await replay(ownerCtx, capStart, (b) => b.split(c3).join(c4));
    const ownerOk = (await count(c4)) > 0;
    notes.push(`start: off ${refused ? "refused, no intake row" : "NOT refused"}; owner in the same state ${ownerOk ? "creates one" : "does NOT"}`);
    if (!(refused && ownerOk)) fail = true;
    await setScope("clin.view_intake", "studio");
  }
  rec({ id, status: fail ? "FAIL" : "PASS", realPath: true, detail: `${notes.join("; ")}. handOffAssistedIntakeAction is gated the same way but is NOT driven here.` });
  expect(fail).toBe(false);
});

// ------------------------------------------------------------------------- 4. clin.edit_records inactive by prerequisite
test("clin.edit_records: stored choice is kept, effective access is off capped by clin.view_records, and the page explains it", async () => {
  test.setTimeout(300_000); // the Roles page's first load on a fresh production build can exceed the 120 s default; the waits below are bounded
  const id = "clin.edit_records-inactive-capped-by-view_records";
  const stored = async () => (await sql<{ scope: string }>(`select scope from public.studio_role_permissions where studio_id = $1 and role = 'practitioner' and key = 'clin.edit_records'`, [S]))[0]?.scope;
  const effective = async () => {
    const r = (await rpc(tOwner, "effective_access", { p_studio: S, p_membership: A.prac1.practitionerId })).body;
    return (r?.rows as Array<{ key: string; scope: string; capped_by?: string; source?: string }> | undefined)?.find((x) => x.key === "clin.edit_records");
  };
  expect(await setScope("clin.view_records", "studio")).toBeNull();
  let fixture = "";
  if (!(await stored())) {
    const r = await setScope("clin.edit_records", "studio"); // at the default this is a no-op (nothing_changed) and stores nothing
    if (r || !(await stored())) {
      // clin.edit_records is not_yet: the save may be refused. Fall back to a SQL fixture for the STORED state only (the assertions stay on the real resolver and page).
      await sql(`insert into public.studio_role_permissions (studio_id, role, key, scope) values ($1, 'practitioner', 'clin.edit_records', 'studio') on conflict do nothing`, [S]);
      fixture = ` stored row set by a SQL fixture (${r ?? "the save stored nothing"})`;
    }
  }
  const storedOn = await stored();
  if (!storedOn || storedOn === "off") return blocked(id, `no non-off stored clin.edit_records row could be set up (${fixture || "none"})`);
  const effOn = await effective();
  expect(await setScope("clin.view_records", "off")).toBeNull();
  const storedOff = await stored();
  const effOff = await effective();
  const capOk = effOff?.scope === "off" && effOff?.capped_by === "requires:clin.view_records";
  await op.goto("/settings/roles");
  // Same navigation roles-r6-wired-keys proved: Permissions and Practitioner are TABS; the row lives in a closed <details>.
  await op.getByRole("tab", { name: /^Permissions/ }).click({ timeout: 8000 }).catch(() => undefined);
  await op.getByRole("tab", { name: /^Practitioner/ }).click({ timeout: 5000 }).catch(() => undefined);
  const row = op.locator('[data-permission-row="clin.edit_records"]');
  await row.scrollIntoViewIfNeeded().catch(() => undefined);
  const det = row.locator("xpath=ancestor::details[1]");
  if (await det.count()) await det.evaluate((d) => ((d as HTMLDetailsElement).open = true)).catch(() => undefined);
  const note = row.getByText(/Inactive: needs/).first();
  const seen = (await row.count()) === 1 && (await note.isVisible().catch(() => false));
  const pageText = seen ? ((await note.textContent()) ?? "").slice(0, 160) : "";
  await shot(op, "edit-records-inactive-page");
  rec({
    id, realPath: true,
    status: storedOff === storedOn && capOk && seen ? "PASS" : "FAIL",
    detail: `stored row ${storedOn} -> ${storedOff} (kept=${storedOff === storedOn}); effective_access on: ${JSON.stringify(effOn ?? null)}; off: ${JSON.stringify(effOff ?? null)}; page explanation ${seen ? `shown: "${pageText}"` : "NOT found"}.${fixture} clin.edit_records is not_yet: engine and page only, no charting effect asserted.`,
  });
  await setScope("clin.view_records", "studio");
  expect(storedOff, "the stored choice stays").toBe(storedOn);
  expect(capOk, "effective access is off, capped_by the prerequisite").toBe(true);
  expect(seen, "the page explains the inactive row").toBe(true);
});

async function waitUntil(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
}

test("summary: every affected-behaviour row is recorded", async () => {
  const need = ["clin.view_records-open-tab-chart-action-replay", "clin.view_intake-resend-no-url", "clin.view_intake-assisted-start-step-refused", "clin.edit_records-inactive-capped-by-view_records"];
  const have = new Set(rowsOnDisk().map((r) => r.id));
  const missing = need.filter((n) => !have.has(n));
  expect(missing, `rows without a result: ${missing.join(", ")}`).toEqual([]);
});
