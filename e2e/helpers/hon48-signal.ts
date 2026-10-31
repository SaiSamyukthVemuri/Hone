import { randomUUID } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "./local-env";
import { loginAsOwner, loginByMagicLink } from "./flows";
import {
  getE2eServiceId, getOwnerPractitionerId, getStudioTimezone, seedE2eMember, seedE2eStudio,
  seedServiceEligibility, setStudioCapacityBookingEnabled, setStudioCapacityEnabled, sql,
  type E2eSeed,
} from "./seed";

// HON-48 Q7 browser proofs: shared harness. Synthetic data only. Nothing here reads or writes a hosted project.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = "Hon48-synthetic-pass-1!";
type Row = Record<string, unknown>;

export type Session = { email: string; userId: string; token: string };
export type Seat = { label: string; email: string; page: Page; ctx: BrowserContext; rsc: number[] };
export type Studio = { seed: E2eSeed; tz: string; day: string; serviceId: string; pracIds: string[]; desk: Session; clients: { id: string; name: string }[]; nextClient: () => { id: string; name: string } };

async function gotrue(path: string, method: string, json?: unknown): Promise<Response> {
  return fetch(`${E2E_SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

export async function withPassword(email: string): Promise<Session> {
  const user = (await sql<{ id: string }>(`select id from auth.users where lower(email) = lower($1)`, [email]))[0];
  const set = await gotrue(`/admin/users/${user.id}`, "PUT", { password: PASSWORD });
  if (!set.ok) throw new Error(`could not set a synthetic password: ${set.status}`);
  const grant = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!grant.ok) throw new Error(`password grant failed: ${grant.status}`);
  return { email, userId: user.id, token: ((await grant.json()) as { access_token: string }).access_token };
}

/** The platform precondition: Realtime is running and migration 0271's listen policy exists. Fails loudly, never skips. */
export async function requireSignalPlatform(): Promise<void> {
  const r = await sql<{ policy: number; emitter: boolean }>(
    `select (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages')::int as policy,
            to_regproc('public.emit_schedule_signal') is not null as emitter`);
  expect(r[0].emitter, "migration 0271 emitter is absent: run on a stack with 0271 applied").toBe(true);
  expect(r[0].policy, "realtime.messages has no listen policy: Realtime must be running when 0271 is applied (re-run the file after it initialises)").toBeGreaterThan(0);
}

export async function createBooking(s: Studio, practitionerId: string, hhmm: string, client?: { id: string; name: string }, daysAhead = 2): Promise<{ id: string; name: string; sentAt: number; ms: number }> {
  const c = client ?? s.nextClient();
  const start = new Date((await sql<{ t: string }>(
    `select ((((now() at time zone $1)::date + $2::int)::text || ' ' || $3)::timestamp at time zone $1) as t`, [s.tz, daysAhead, hhmm]))[0].t).toISOString();
  const sentAt = Date.now();
  const res = await fetch(`${E2E_SUPABASE_URL}/rest/v1/rpc/receptionist_create_appointment`, {
    method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${s.desk.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_studio_id: s.seed.studioId, p_target_practitioner_id: practitionerId, p_client_id: c.id, p_service_id: s.serviceId, p_starts_at: start }),
  });
  const body = (await res.json()) as Row[] | Row;
  const row = (Array.isArray(body) ? body[0] : body) as Row;
  expect(row?.result, `booking refused: ${JSON.stringify(body).slice(0, 120)}`).toBe("created");
  return { id: row.appointment_id as string, name: c.name, sentAt, ms: Date.now() - sentAt };
}

/** One studio with `members` practitioners besides the owner, a desk session that commits through the real RPC, and a synthetic day. */
export async function seedStudio(members: number): Promise<Studio & { memberEmails: string[] }> {
  const seed = await seedE2eStudio();
  const tz = await getStudioTimezone(seed.studioId);
  await setStudioCapacityEnabled(seed.studioId, true);
  await setStudioCapacityBookingEnabled(seed.studioId, true);
  const ownerPrac = await getOwnerPractitionerId(seed.studioId);
  const ms = [];
  for (let i = 0; i < members; i++) ms.push(await seedE2eMember(seed));
  const pracIds = [ownerPrac, ...ms.map((m) => m.practitionerId)];
  const serviceId = await getE2eServiceId(seed.studioId);
  for (const id of pracIds) await seedServiceEligibility(seed.studioId, serviceId, id);
  const deskEmail = `e2e-desk-${seed.runId}@harness.local`;
  const created = (await (await gotrue("/admin/users", "POST", { email: deskEmail, email_confirm: true })).json()) as { id: string };
  await sql(`insert into public.studio_receptionists (studio_id, user_id, display_name, active) values ($1,$2,'Synthetic Front Desk',true)`, [seed.studioId, created.id]);
  const desk = await withPassword(deskEmail);
  const clients: { id: string; name: string }[] = [];
  for (let i = 0; i < 80; i++) {
    const id = randomUUID(); const name = `Synthetic Signal ${seed.runId}-${i}`;
    await sql(`insert into public.clients (id, studio_id, name) values ($1,$2,$3)`, [id, seed.studioId, name]);
    clients.push({ id, name });
  }
  let ci = 0;
  const day = (await sql<{ d: string }>(`select ((now() at time zone $1)::date + 2)::text as d`, [tz]))[0].d;
  return { seed, tz, day, serviceId, pracIds, desk, clients, nextClient: () => clients[ci++], memberEmails: ms.map((m) => m.email) };
}

/** A signed-in browser on the team day. Counts every RSC request the page makes for /calendar, which is exactly a router.refresh() or navigation. */
export async function openSeat(browser: Browser, label: string, email: string, seed: E2eSeed, owner: boolean, day: string, teamGrid = true): Promise<Seat> {
  // The app CSP allows only wss:// to the Supabase host (correct for hosted); the local stack is ws://, so bypass CSP in the test, never in the app.
  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  const rsc: number[] = [];
  page.on("request", (r) => { if (r.url().includes("/calendar") && r.url().includes("_rsc=")) rsc.push(Date.now()); });
  if (owner) await loginAsOwner(page, seed); else await loginByMagicLink(page, email);
  await page.goto(`/calendar?view=day&day=${day}`);
  if (teamGrid) await expect(page.getByTestId("team-day-column-header").first()).toBeVisible({ timeout: 60_000 });
  else await expect(page).toHaveURL(/\/calendar/);
  return { label, email, page, ctx, rsc };
}

/** Resolves with Date.now() at the moment `probe` is in the DOM (no reload, no router call from the test), or null at the timeout. */
export function whenVisible(page: Page, probe: string, timeoutMs: number): Promise<number | null> {
  return page.evaluate(({ probe, timeoutMs }) => new Promise<number | null>((resolve) => {
    const has = () => document.body.innerText.includes(probe);
    if (has()) return resolve(-1);
    const mo = new MutationObserver(() => { if (has()) { mo.disconnect(); resolve(Date.now()); } });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { mo.disconnect(); resolve(null); }, timeoutMs);
  }), { probe, timeoutMs });
}

export const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
export const summary = (xs: number[]) => (xs.length ? { n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)) } : { n: 0 });
export const since = (seat: Seat, t: number) => seat.rsc.filter((x) => x >= t).length;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pretend the tab is hidden/visible (headless has no real tab switching): the same document state and event the app listens to. */
export async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  await page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => st === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}
