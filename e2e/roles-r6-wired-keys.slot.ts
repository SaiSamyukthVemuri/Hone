import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { seedE2eEndedAppointmentSession, seedE2eIntake, sql } from "./helpers/seed";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "./helpers/local-env";
import { loginByMagicLink } from "./helpers/flows";
import { seedAppointmentFor, seedStudioWithStaff, type StudioWithStaff } from "./helpers/multistaff-seed";
import { can, getRoles, jwtFor, saveRole } from "./helpers/roles-r1-client";
import { blockUnlessKeysReleased } from "./helpers/roles-release";

// Roles R6, newly wired keys (Team's #1341 77422359d on General's gen/roles-integrated): appt.cancel, appt.mark_no_show,
// appt.edit_notes, clin.view_records, clin.view_photos (incl. the STORAGE signing path), clin.view_intake, clin.view_aftercare,
// plus appt.complete in OBSERVE mode (never blocks, logs permission_observe_would_deny). Plan-stage: typechecked only, NEVER run.
// General's own keys (appt.move, appt.book, and the editor/save chain) are deliberately not repeated here.
//
// Real enforcement path only: the owner changes the practitioner role with the real R1 save command (a real GoTrue JWT through
// PostgREST), then a real signed-in practitioner browser session drives the real server action or page. For actions the captured
// server-action POST is replayed with the practitioner's own cookies and a different appointment id, so the UI is bypassed too.
// MATCHED CONTROLS in the same run, for every key: (1) the same action allowed when the key is on, (2) the same denied state does
// not block a sibling action (specificity), (3) the owner performs the same action in the same denied state, (4) restoring the key
// re-allows (so the denial was the policy, not a stuck fixture), (5) for scope keys, own appointment vs colleague's appointment.
// A positive marker must be found before any "absent" assertion counts; if it is not found the row is BLOCKED, never a pass.
// Synthetic data, owned isolated stack, fake providers. Nothing is accepted.
test.use({ bypassCSP: true }); // local storage is http://127.0.0.1; the app CSP only allows https. This changes the TEST browser only.
// Independent tests: a failure restarts the worker and the next test seeds its own studio, so one failure never hides the rest.

const OUT = process.env.ROLES_R6_OUT;
const OBS_LOG = process.env.OBSERVE_LOG; // runner tees the Playwright output (incl. [WebServer] lines) to this file
const REASON = "Integrated verification of the wired keys on a synthetic studio.";
const login = (p: Page, email: string) => (loginByMagicLink as (...a: unknown[]) => Promise<void>)(p, email, { openRowDetails: false });

type Row = { id: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "OBSERVED" | "RESIDUAL"; realPath: boolean; detail?: string };
const results: Row[] = [];
// Rows are appended to disk as they happen, so a failure (which restarts the worker and re-runs beforeAll) never loses earlier rows.
const ROWS_FILE = OUT ? path.join(OUT, "roles-r6-wired-keys.rows.jsonl") : null;
const rec = (r: Row) => {
  results.push(r);
  if (ROWS_FILE) { mkdirSync(OUT!, { recursive: true }); appendFileSync(ROWS_FILE, JSON.stringify(r) + "\n"); }
};
const rowsOnDisk = (): Row[] => (ROWS_FILE && existsSync(ROWS_FILE) ? readFileSync(ROWS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : results);

let A: StudioWithStaff;
let S = "";
let tOwner = "", tP1 = "";
let ownerCtx: BrowserContext, p1Ctx: BrowserContext;
let op: Page, p1: Page;
let clientId = "", sessionId = "", chartApptId = "";
const original = new Map<string, string>();
let storageUp = false;

const KEYS = ["appt.cancel", "appt.mark_no_show", "appt.edit_notes", "appt.complete", "clin.view_records", "clin.view_photos", "clin.view_intake", "clin.view_aftercare"] as const;

async function stateOf(key: string): Promise<{ version: number; eff: string }> {
  const g = (await getRoles(tOwner, S)).body;
  return { version: g.version as number, eff: g.roles?.practitioner?.[key]?.effective as string };
}
const REFUSAL_CODES = ["widening_not_yet", "not_enforced"];
/** Sets the PRACTITIONER role's scope with the real owner save command. Returns a refusal summary instead of throwing. */
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

async function waitFor(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const apptRow = async (id: string) => (await sql<{ status: string; notes: string | null }>(`select status, notes from public.appointments where id = $1`, [id]))[0];
const shot = async (p: Page, name: string) => {
  if (!OUT) return;
  mkdirSync(path.join(OUT, "wired-shots"), { recursive: true });
  await p.screenshot({ path: path.join(OUT, "wired-shots", `${name}.png`), fullPage: true });
};

// ---- the four appointment actions: how a person drives them and how the database shows the effect ----
type ApptKey = "appt.cancel" | "appt.mark_no_show" | "appt.edit_notes" | "appt.complete";
const NOTE = (id: string) => `RBAC-WIRED-NOTE-${id.slice(0, 8)}`;
const ACTIONS: Record<ApptKey, { minutes: number; drive: (p: Page, id: string) => Promise<void>; done: (id: string) => Promise<boolean>; deny?: string }> = {
  "appt.cancel": {
    minutes: 600,
    drive: async (p, id) => { await p.goto(`/calendar/${id}`); await p.getByRole("button", { name: "Cancel appointment" }).click(); },
    done: async (id) => (await apptRow(id)).status === "cancelled",
    deny: "You don't have permission to cancel this appointment.",
  },
  "appt.mark_no_show": {
    minutes: -180, // ends 2 h ago: the control is enabled only after the end time
    drive: async (p, id) => {
      await p.goto(`/calendar/${id}`);
      await p.getByRole("button", { name: "Mark no-show" }).first().click();
      await p.getByRole("button", { name: /mark no-show/i }).last().click(); // the confirm dialog's own button
    },
    done: async (id) => (await apptRow(id)).status === "no_show",
    deny: "You don't have permission to mark this appointment as a no-show.",
  },
  "appt.edit_notes": {
    minutes: 600,
    drive: async (p, id) => {
      await p.goto(`/calendar/${id}`);
      await p.getByRole("button", { name: /^(Add notes|Edit)$/ }).first().click();
      await p.locator("textarea[name=notes]").fill(NOTE(id));
      await p.getByRole("button", { name: "Save notes" }).click();
    },
    done: async (id) => (await apptRow(id)).notes === NOTE(id),
  },
  "appt.complete": {
    minutes: -30, // started, not ended: completion is gated on the start
    drive: async (p, id) => {
      await p.goto(`/calendar/${id}`);
      await p.getByRole("button", { name: /^Mark complete/i }).first().click();
      await p.getByRole("button", { name: /mark complete/i }).last().click();
    },
    done: async (id) => (await apptRow(id)).status === "completed",
  },
};

type Cap = { url: string; action: string; ct: string; body: string };
/** Drives the UI and captures the server-action POST that carried this appointment id. */
async function driveCapture(p: Page, key: ApptKey, id: string): Promise<Cap | undefined> {
  const caps: Cap[] = [];
  const h = (r: import("@playwright/test").Request) => {
    const a = r.headers()["next-action"];
    if (a && r.method() === "POST" && (r.postData() ?? "").includes(id)) caps.push({ url: r.url(), action: a, ct: r.headers()["content-type"] ?? "", body: r.postData() ?? "" });
  };
  p.on("request", h);
  try { await ACTIONS[key].drive(p, id); await p.waitForTimeout(600); } finally { p.off("request", h); }
  return caps[0];
}
async function replay(ctx: BrowserContext, cap: Cap, oldId: string, newId: string): Promise<string> {
  const res = await ctx.request.post(cap.url, { headers: { "Next-Action": cap.action, "Content-Type": cap.ct }, data: cap.body.split(oldId).join(newId) });
  return res.text();
}
// Appointments cannot overlap studio-wide (no_overlapping_appointments_studio_wide), so each one gets its own two-hour slot:
// future ones from 2000 min ahead, past ones from a day back (completion is gated on the start, no-show on the end).
let slot = 0;
const mk = (key: ApptKey, practitionerId: string) => {
  const n = slot++;
  return seedAppointmentFor(S, practitionerId, clientId, ACTIONS[key].minutes > 0 ? 2000 + n * 120 : -(1440 + n * 120));
};

// A fresh stack has every key PENDING, which makes a stored Off inert: report BLOCKED (skipped, with the reason) instead of a false FAIL.
blockUnlessKeysReleased(test);

test.beforeAll(async ({ browser }) => {
  A = await seedStudioWithStaff();
  S = A.seed.studioId;
  tOwner = (await jwtFor(A.seed.ownerEmail)).token;
  tP1 = (await jwtFor(A.prac1.email)).token;
  const ended = await seedE2eEndedAppointmentSession(A.seed, { status: "completed", charted: true, clientEmail: `rbac-wired-${Date.now()}@harness.local` });
  clientId = ended.clientId; sessionId = ended.sessionId; chartApptId = ended.appointmentId;
  await seedE2eIntake(S, clientId, "submitted", { has_allergies: "no" });
  for (const k of KEYS) original.set(k, (await stateOf(k)).eff);
  storageUp = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then((r) => r.ok, () => false);
  ownerCtx = await browser.newContext({ bypassCSP: true });
  p1Ctx = await browser.newContext({ bypassCSP: true });
  // Sentry fence, browser side: the app's /monitoring tunnel is answered locally so nothing reaches the production project.
  for (const c of [ownerCtx, p1Ctx]) await c.route(/\/monitoring/, (r) => r.fulfill({ status: 200, body: "{}" }));
  op = await ownerCtx.newPage(); p1 = await p1Ctx.newPage();
  await login(op, A.seed.ownerEmail);
  await login(p1, A.prac1.email);
});

test.afterAll(async () => {
  for (const [k, v] of original) if (v === "off" || v === "own" || v === "studio") await setScope(k, v as "off" | "own" | "studio");
  await ownerCtx?.close(); await p1Ctx?.close();
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "roles-r6-wired-keys.json"), JSON.stringify({ accepted: false, storageUp, originalEffective: Object.fromEntries(original), results: rowsOnDisk() }, null, 1));
});

// ------------------------------------------------------------------------------------------- appt.cancel / no_show / edit_notes
for (const key of ["appt.cancel", "appt.mark_no_show", "appt.edit_notes"] as const) {
  test(`${key}: allowed, denied, bypass, controls, own versus colleague, restored`, async () => {
    test.setTimeout(300_000);
    const act = ACTIONS[key];
    const sibling = key === "appt.edit_notes" ? "appt.cancel" : "appt.edit_notes";
    const notes: string[] = [];

    // 1. ALLOWED (positive control): whole studio.
    let why = await setScope(key, "studio");
    if (why) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
    const a1 = await mk(key, A.prac1.practitionerId);
    expect(await can(tP1, S, key, { appt: a1 }), "engine says yes").toBe(true);
    const cap = await driveCapture(p1, key, a1);
    expect(await waitFor(() => act.done(a1)), "allowed: the action took effect").toBe(true);
    notes.push("allowed(studio): effect seen");

    // 2. DENIED: off. Same practitioner session, no re-login.
    why = await setScope(key, "off");
    if (why) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
    const a2 = await mk(key, A.prac1.practitionerId);
    expect(await can(tP1, S, key, { appt: a2 }), "engine says no on the next call").toBe(false);
    await act.drive(p1, a2);
    await p1.waitForTimeout(4000);
    expect(await act.done(a2), "denied: nothing changed").toBe(false);
    if (act.deny) await expect(p1.getByText(act.deny)).toBeVisible({ timeout: 10_000 });
    await shot(p1, `${key.replace(".", "-")}-denied`);
    notes.push("denied(off): UI refused, no effect");

    // 2b. DENIED through a direct server-action call (UI bypassed): the captured POST, own cookies, a different appointment.
    const a3 = await mk(key, A.prac1.practitionerId);
    if (cap) {
      const text = await replay(p1Ctx, cap, a1, a3);
      expect(await act.done(a3), "direct call: nothing changed").toBe(false);
      if (act.deny) expect(text).toContain(act.deny);
      notes.push("direct replay refused");
    } else {
      rec({ id: `${key}-direct-call`, status: "BLOCKED", realPath: false, detail: "no server-action POST was captured during the allowed phase" });
    }

    // 3. MATCHED CONTROLS in the same denied state.
    //   (a) specificity: a sibling key is still true for the same person, so the refusal is this key, not a broken session.
    expect(await can(tP1, S, sibling, { appt: a2 }), `sibling ${sibling} unaffected`).toBe(true);
    //   (b) the OWNER performs the same action in the same state (owner permissions are fixed).
    const a4 = await mk(key, A.prac1.practitionerId);
    await act.drive(op, a4);
    expect(await waitFor(() => act.done(a4)), "owner is allowed in the same state").toBe(true);
    notes.push("controls: sibling key unaffected; owner allowed");

    // 4. OWN scope: own appointment allowed, a colleague's appointment denied. Then STUDIO scope: the colleague's is allowed.
    why = await setScope(key, "own");
    if (!why) {
      const mine = await mk(key, A.prac1.practitionerId);
      const theirs = await mk(key, A.prac2.practitionerId);
      expect(await can(tP1, S, key, { appt: mine }), "own: assigned to me").toBe(true);
      expect(await can(tP1, S, key, { appt: theirs }), "own: assigned to a colleague").toBe(false);
      await act.drive(p1, theirs);
      await p1.waitForTimeout(4000);
      expect(await act.done(theirs), "own scope: the colleague's appointment is untouched").toBe(false);
      await act.drive(p1, mine);
      expect(await waitFor(() => act.done(mine)), "own scope: my own appointment works").toBe(true);
      notes.push("own: mine allowed, colleague's denied");
    } else {
      rec({ id: `${key}-own-scope`, status: "BLOCKED", realPath: false, detail: why });
    }

    // 5. RESTORED: back to the whole studio re-allows (the denial was the policy, not a stuck fixture).
    why = await setScope(key, "studio");
    expect(why).toBeNull();
    const a6 = await mk(key, A.prac2.practitionerId);
    await act.drive(p1, a6);
    expect(await waitFor(() => act.done(a6)), "restored: allowed again, colleague's appointment").toBe(true);
    notes.push("restored(studio): colleague's appointment allowed");
    rec({ id: `${key}-matrix`, status: "PASS", realPath: true, detail: notes.join("; ") });
  });
}

// --------------------------------------------------------------------------------------------- appt.complete is OBSERVE-ONLY
test("appt.complete: never blocks, and logs would-deny only when the engine says no", async () => {
  test.setTimeout(240_000);
  const key = "appt.complete";
  const act = ACTIONS[key];
  const logHas = async (id: string): Promise<boolean | null> => {
    if (!OBS_LOG || !existsSync(OBS_LOG)) return null;
    return waitFor(async () => /permission_observe_would_deny/.test(readFileSync(OBS_LOG, "utf8")) && readFileSync(OBS_LOG, "utf8").split("\n").some((l) => l.includes("permission_observe_would_deny") && l.includes(key) && l.includes(id)), 12_000);
  };
  // would-deny: off. The engine says no, the action still succeeds.
  const why = await setScope(key, "off");
  if (why) { rec({ id: "appt.complete-observe", status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
  const a1 = await mk(key, A.prac1.practitionerId);
  expect(await can(tP1, S, key, { appt: a1 }), "the engine would deny").toBe(false);
  await act.drive(p1, a1);
  expect(await waitFor(() => act.done(a1)), "observe-only: completion is NOT blocked").toBe(true);
  const sawDeny = await logHas(a1);

  // control: allowed. The action succeeds and NO would-deny line is written for it.
  // Widening to the whole studio is a gated change (ship gate): recorded as observed. The control uses the key's own original
  // scope (assigned-only) on the practitioner's own appointment.
  const widen = await setScope(key, "studio");
  rec({ id: "appt.complete-widen-to-studio", status: "OBSERVED", realPath: true, detail: widen ?? "widening to studio was accepted" });
  // OPS 3 Nov: the direct-action refusal codes for a key that cannot be widened are widening_not_yet / not_enforced. Record which came back.
  if (widen) rec({ id: "appt.complete-widen-refusal-code", status: REFUSAL_CODES.some((c) => widen.includes(c)) ? "PASS" : "OBSERVED", realPath: true, detail: `${widen} (expected one of ${REFUSAL_CODES.join(" / ")}; gate_unmet was the earlier code)` });
  const back = original.get(key) as "off" | "own" | "studio";
  expect(await setScope(key, back), "restore the original scope").toBeNull();
  const a2 = await mk(key, A.prac1.practitionerId);
  expect(await can(tP1, S, key, { appt: a2 }), "the engine allows (original scope, own appointment)").toBe(true);
  await act.drive(p1, a2);
  expect(await waitFor(() => act.done(a2)), "allowed completion works").toBe(true);
  const sawAllowedLine = await logHas(a2);

  if (sawDeny === null) {
    rec({ id: "appt.complete-observe", status: "BLOCKED", realPath: true, detail: "completion not blocked while the engine says no: PASS on the database/UI path. The would-deny LOG LINE is NOT RUN: OBSERVE_LOG was not set to a file holding the app server's output" });
    return;
  }
  expect(sawDeny, "would-deny logged for the denied-by-engine completion").toBe(true);
  expect(sawAllowedLine, "no would-deny line for the allowed completion (negative control)").toBe(false);
  rec({ id: "appt.complete-observe", status: "PASS", realPath: true, detail: "not blocked while engine=false; one would-deny line (ids only) for that appointment; none for the allowed control" });
});

// --------------------------------------------------------------------------------- the three page keys: records, intake, aftercare
async function status(p: Page, url: string): Promise<number> { return (await p.goto(url))?.status() ?? 0; }
const missingId = "00000000-0000-4000-8000-000000000000";

test("clin.view_records: the chart is the same not-found as a missing chart when off", async () => {
  const key = "clin.view_records";
  const url = `/clients/${clientId}/sessions/${sessionId}`;
  const why = await setScope(key, "studio");
  if (why) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
  expect(await can(tP1, S, key, { client: clientId }), "engine yes").toBe(true);
  expect(await status(p1, url), "allowed: the chart renders").toBe(200);
  expect(await status(op, url), "owner control").toBe(200);
  expect(await setScope(key, "off")).toBeNull();
  expect(await can(tP1, S, key, { client: clientId }), "engine no on the next call").toBe(false);
  const denied = await status(p1, url);
  const missing = await status(p1, `/clients/${clientId}/sessions/${missingId}`);
  await shot(p1, "clin-view-records-denied");
  expect(denied, "denied looks exactly like a missing chart").toBe(missing);
  expect(denied).toBe(404);
  expect(await status(op, url), "owner still sees it in the same state").toBe(200);
  expect(await status(p1, `/clients/${clientId}/images`), "sibling page still loads").toBe(200);
  expect(await setScope(key, "studio")).toBeNull();
  expect(await status(p1, url), "restored").toBe(200);
  rec({ id: `${key}-matrix`, status: "PASS", realPath: true, detail: "200 allowed, 404 off (== missing id), owner 200, sibling page 200, restored 200" });
});

test("clin.view_intake: the intake answers are the same not-found as a missing client when off", async () => {
  const key = "clin.view_intake";
  const url = `/clients/${clientId}/intake`;
  const why = await setScope(key, "studio");
  if (why) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
  expect(await can(tP1, S, key, { client: clientId }), "engine yes").toBe(true);
  expect(await status(p1, url), "allowed: the intake page renders").toBe(200);
  expect(await setScope(key, "off")).toBeNull();
  expect(await can(tP1, S, key, { client: clientId }), "engine no on the next call").toBe(false);
  const denied = await status(p1, url);
  const missing = await status(p1, `/clients/${missingId}/intake`);
  await shot(p1, "clin-view-intake-denied");
  expect(denied, "denied looks exactly like a missing client").toBe(missing);
  expect(denied).toBe(404);
  expect(await status(op, url), "owner still sees it in the same state").toBe(200);
  expect(await status(p1, `/clients/${clientId}/images`), "sibling page still loads").toBe(200);
  expect(await setScope(key, "studio")).toBeNull();
  expect(await status(p1, url), "restored").toBe(200);
  rec({ id: `${key}-matrix`, status: "PASS", realPath: true, detail: "200 allowed, 404 off (== missing client), owner 200, sibling 200, restored 200" });
});

test("clin.view_aftercare: the aftercare section is absent when off, present when on, page otherwise intact", async () => {
  const key = "clin.view_aftercare";
  const url = `/calendar/${chartApptId}`;
  const marker = (p: Page) => p.locator("main").getByText(/postcare/i);
  const why = await setScope(key, "studio");
  if (why) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
  expect(await can(tP1, S, key, { appt: chartApptId }), "engine yes").toBe(true);
  expect(await status(p1, url)).toBe(200);
  const present = await marker(p1).count();
  if (present === 0) { rec({ id: `${key}-matrix`, status: "BLOCKED", realPath: false, detail: "positive marker (postcare text) not found with the key on: an 'absent' check would be vacuous" }); test.skip(true, "positive marker missing"); }
  expect(await setScope(key, "off")).toBeNull();
  expect(await can(tP1, S, key, { appt: chartApptId }), "engine no on the next call").toBe(false);
  expect(await status(p1, url), "page still loads").toBe(200);
  expect(await marker(p1).count(), "aftercare section absent when off").toBe(0);
  await expect(p1.getByText("Appointment notes")).toBeVisible(); // control: the rest of the page is intact
  await shot(p1, "clin-view-aftercare-denied");
  expect(await status(op, url)).toBe(200);
  expect(await marker(op).count(), "owner still sees it in the same state").toBeGreaterThan(0);
  expect(await setScope(key, "studio")).toBeNull();
  await p1.goto(url);
  expect(await marker(p1).count(), "restored").toBeGreaterThan(0);
  rec({ id: `${key}-matrix`, status: "PASS", realPath: true, detail: `postcare marker count ${present} on, 0 off (page intact), owner still sees it, restored` });
});

// ------------------------------------------------------------------------------------------------- clin.view_photos: STORAGE
async function syntheticPng(): Promise<Buffer> {
  const w = 1600, h = 1200, raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; raw[i] = (x * 255) / w; raw[i + 1] = (y * 255) / h; raw[i + 2] = (x ^ y) & 0xff; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}
const CELL = 'main button[aria-label="View larger treatment photo"] img';

test("clin.view_photos: no signed URL is issued when off (storage plane), issued when on", async () => {
  test.setTimeout(300_000);
  const key = "clin.view_photos";
  if (!storageUp) {
    rec({ id: `${key}-storage`, status: "BLOCKED", realPath: false, detail: "storage-api is not running on this stack (the usual isolated stack excludes it). Needs a stack started WITHOUT '-x storage-api'. The page-level 'Image not available' path is not exercised either, because no photo can be stored" });
    test.skip(true, "storage-api not running");
  }
  const why = await setScope(key, "studio");
  if (why) { rec({ id: `${key}-storage`, status: "BLOCKED", realPath: false, detail: why }); test.skip(true, why); }
  const images = `/clients/${clientId}/images`;

  // The OWNER attaches one synthetic photo (the real upload path).
  await op.goto(images);
  await op.locator('input[type="file"][name="file"]').setInputFiles([{ name: "synthetic-0.png", mimeType: "image/png", buffer: await syntheticPng() }]);
  await op.getByRole("button", { name: /^Attach/ }).click();
  await expect(op.locator(CELL)).toHaveCount(1, { timeout: 120_000 });
  const stored = (await sql<{ storage_bucket: string; storage_path: string }>(`select storage_bucket, storage_path from public.treatment_images where client_id = $1 and deleted_at is null`, [clientId]))[0];
  expect(stored, "one stored photo row").toBeTruthy();

  // ALLOWED: the practitioner's grid gets a signed URL that really serves an image; capture the 'View larger' signing call.
  expect(await can(tP1, S, key, { client: clientId }), "engine yes").toBe(true);
  const caps: Cap[] = [];
  p1.on("request", (r) => { const a = r.headers()["next-action"]; if (a && r.method() === "POST") caps.push({ url: r.url(), action: a, ct: r.headers()["content-type"] ?? "", body: r.postData() ?? "" }); });
  await p1.goto(images);
  await expect(p1.locator(CELL)).toHaveCount(1, { timeout: 60_000 });
  const src = (await p1.locator(CELL).first().getAttribute("src")) ?? "";
  expect(src, "the grid image is a signed storage URL").toMatch(/\/storage\/v1\/object\/sign\//);
  const served = await p1Ctx.request.get(src);
  expect(served.status(), "the signed URL serves the image").toBe(200);
  expect(served.headers()["content-type"] ?? "").toMatch(/^image\//);
  caps.length = 0; // only the signing call made by this click counts
  await p1.locator('main button[aria-label="View larger treatment photo"]').first().click();
  await p1.waitForTimeout(1500);
  await p1.keyboard.press("Escape");
  const signCap = caps[0];
  const objectUrl = `${E2E_SUPABASE_URL}/storage/v1/object/authenticated/${stored!.storage_bucket}/${stored!.storage_path}`;
  const direct = async (token: string) => (await fetch(objectUrl, { headers: { Authorization: `Bearer ${token}`, apikey: process.env.E2E_SUPABASE_ANON_KEY ?? "" } })).status;
  const controlService = await direct(E2E_SERVICE_ROLE_KEY);
  expect(controlService, "control: the service role can read the object, so a refusal below is not a wrong path").toBe(200);
  const directOn = await direct(tP1);

  // DENIED: off. The same open session, next load.
  expect(await setScope(key, "off")).toBeNull();
  expect(await can(tP1, S, key, { client: clientId }), "engine no on the next call").toBe(false);
  await p1.goto(images);
  await expect(p1.getByText("Photos are not available to your role.").first()).toBeVisible({ timeout: 30_000 });
  expect(await p1.locator('img[src*="/storage/v1/object/sign/"]').count(), "no signed URL on the denied page").toBe(0);
  await shot(p1, "clin-view-photos-denied");
  // The signing server action, replayed directly with the practitioner's cookies, issues no URL.
  if (signCap) {
    const text = await p1Ctx.request.post(signCap.url, { headers: { "Next-Action": signCap.action, "Content-Type": signCap.ct }, data: signCap.body }).then((r) => r.text());
    expect(text, "direct signing call returns no signed URL").not.toMatch(/\/storage\/v1\/object\/sign\//);
    rec({ id: `${key}-sign-action-replay`, status: "PASS", realPath: true, detail: "replayed 'View larger' signing call with the practitioner's cookies while off: no signed URL in the response" });
  } else {
    rec({ id: `${key}-sign-action-replay`, status: "BLOCKED", realPath: false, detail: "the 'View larger' signing POST was not captured" });
  }
  // Matched controls in the same denied state.
  await op.goto(images);
  await expect(op.locator(CELL)).toHaveCount(1, { timeout: 60_000 });
  expect(await status(p1, `/clients/${clientId}/intake`), "sibling page still loads for the practitioner").toBe(200);
  // OPS correction (3 Nov): the treatment-images bucket is service-role only (0093), so a practitioner's own JWT must be REFUSED on
  // the object route whatever the key says. Expected REFUSAL in both states (PASS when refused). The signing gate is the
  // clin.view_photos enforcement, covered above. The service-role read (200) is the control that the object and path are real.
  const directOff = await direct(tP1);
  const refused = (c: number) => c >= 400;
  rec({ id: `${key}-direct-storage-read`, status: refused(directOn) && refused(directOff) ? "PASS" : "FAIL", realPath: true, detail: `practitioner token on the object route: HTTP ${directOn} with the key on, ${directOff} with it off (service-role control ${controlService}); expected refused in both (bucket is service-role only, 0093)` });
  expect(refused(directOn), "direct read refused with the key on (bucket is service-role only)").toBe(true);
  expect(refused(directOff), "direct read refused with the key off").toBe(true);
  // Documented residual window, OBSERVED not asserted: a URL minted before the revoke lives out its 60 s.
  const oldUrlAfter = (await p1Ctx.request.get(src)).status();
  rec({ id: `${key}-residual-window`, status: "OBSERVED", realPath: true, detail: `URL minted before the revoke, fetched right after: HTTP ${oldUrlAfter} (documented residual window, <= 60 s expiry)` });

  // RESTORED
  expect(await setScope(key, "studio")).toBeNull();
  await p1.goto(images);
  await expect(p1.locator(CELL)).toHaveCount(1, { timeout: 60_000 });
  rec({ id: `${key}-storage`, status: "PASS", realPath: true, detail: "signed URL served image while on; 'Photos are not available to your role.' and no signed URL while off; owner unaffected; restored" });
});

// ------------------------------------------------------------------------------- deny_only: appt.move cannot be widened
// enforcement 'deny_only': turning the key off refuses, but a legacy check stands in front, so widening grants nothing yet. The Roles
// page must disable the wider options, and a direct save wider than the studio's current value must be refused or capped.
test("appt.move (deny_only): the owner cannot widen above the snapshot, and narrowing still works", async () => {
  test.setTimeout(240_000);
  const key = "appt.move";
  const ORDER = ["off", "own", "studio"] as const;
  const LABEL = { off: "Off", own: "Own assigned", studio: "Whole studio" } as const;
  const cur = (await stateOf(key)).eff as (typeof ORDER)[number];
  const wider = ORDER.filter((x) => ORDER.indexOf(x) > ORDER.indexOf(cur));
  const narrower = ORDER.filter((x) => ORDER.indexOf(x) < ORDER.indexOf(cur));
  if (wider.length === 0) { rec({ id: "appt.move-deny-only", status: "BLOCKED", realPath: false, detail: `current scope is ${cur}: no wider option exists, so widening cannot be tested` }); test.skip(true, "no wider option"); }
  const mine = await seedAppointmentFor(S, A.prac1.practitionerId, clientId, 9000);
  const theirs = await seedAppointmentFor(S, A.prac2.practitionerId, clientId, 9120);
  const notes: string[] = [`current scope ${cur}`];

  // NARROWING still works (also the matched control that the save path itself is healthy).
  if (narrower.length) {
    expect(await setScope(key, narrower[0]), `narrowing to ${narrower[0]} is accepted`).toBeNull();
    expect(await stateOf(key).then((x) => x.eff), "narrowed value is effective").toBe(narrower[0]);
    if (narrower[0] === "off") expect(await can(tP1, S, key, { appt: mine }), "narrowed to off: the engine refuses my own appointment").toBe(false);
    expect(await setScope(key, cur)).toBeNull();
    notes.push(`narrowing to ${narrower[0]} accepted and effective, restored`);
  }

  // UI: wider options disabled, current and narrower options enabled (nothing is saved through the UI here).
  await op.goto("/settings/roles");
  await op.getByRole("tab", { name: /^Permissions/ }).click();
  await op.getByRole("tab", { name: /^Practitioner/ }).click();
  const r = op.locator(`[data-permission-row="${key}"]`);
  await r.scrollIntoViewIfNeeded();
  const details = r.locator("xpath=ancestor::details[1]");
  if (await details.count()) await details.evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await expect(r, "the appt.move row is on the page").toHaveCount(1);
  for (const w of wider) await expect(r.getByRole("radio", { name: LABEL[w], exact: true }), `wider option ${LABEL[w]} is disabled`).toBeDisabled();
  for (const n of [cur, ...narrower]) await expect(r.getByRole("radio", { name: LABEL[n], exact: true }), `option ${LABEL[n]} stays enabled`).toBeEnabled();
  await shot(op, "appt-move-deny-only-row");
  notes.push("UI: wider options disabled; current and narrower enabled");

  // DIRECT save wider than the snapshot: refused, or capped so it grants nothing.
  const before = await stateOf(key);
  const res = (await saveRole(tOwner, S, before.version, { practitioner: { [key]: wider[wider.length - 1] } }, REASON, true)).body;
  const after = await stateOf(key);
  const engineTheirs = await can(tP1, S, key, { appt: theirs });
  const engineMine = await can(tP1, S, key, { appt: mine });
  const widened = ORDER.indexOf(after.eff as (typeof ORDER)[number]) > ORDER.indexOf(cur) || (cur !== "studio" && engineTheirs);
  rec({
    id: "appt.move-deny-only", status: widened ? "RESIDUAL" : "PASS", realPath: true, // a direct RPC save past the app is the OPS-accepted residual: the database cannot know the flag; the server-action refusal (widening_not_yet / not_enforced) is proven by General's R9
    detail: `${notes.join("; ")}; direct save to ${wider[wider.length - 1]}: ${res?.ok ? "accepted" : "refused (" + String(res?.code ?? JSON.stringify(res)).slice(0, 80) + ")"}; effective after = ${after.eff} (was ${cur}); colleague's appointment allowed=${engineTheirs}, mine=${engineMine}`,
  });
  // Always put the studio back before asserting.
  await setScope(key, cur);
  // not asserted: save_role_permissions called directly cannot know deny_only (the flag lives in the TS catalog; OPS decision)
});

test("summary: every newly wired key has a recorded row", () => {
  const have = new Set(rowsOnDisk().map((r) => r.id));
  const need = ["appt.cancel-matrix", "appt.mark_no_show-matrix", "appt.edit_notes-matrix", "appt.complete-observe", "clin.view_records-matrix", "clin.view_intake-matrix", "clin.view_aftercare-matrix", "clin.view_photos-storage", "appt.move-deny-only"];
  const missing = need.filter((n) => !have.has(n));
  expect(missing, "keys with no recorded result (a skipped test must have recorded why)").toEqual([]);
});
