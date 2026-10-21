// LOCAL-ONLY synthetic Fett twin WALKTHROUGH (#825 6156413624 §6). Drives the served twin like an operator:
// real magic-link logins through the stack's Mailpit, then owner -> receptionist -> practitioner -> client
// booking -> treatment capture -> USD fake settlement -> delivery recovery, plus role and tenant negatives.
//
//   FETT_TWIN_APP_PORT=3995 FETT_TWIN_API_PORT=63321 FETT_TWIN_DB_PORT=63322 FETT_TWIN_MAIL_PORT=63324 \
//   FETT_TWIN_SHOTS=<dir> node scripts/fett-twin/walkthrough.mjs
//
// It MUTATES the twin (books, charges, refunds, resolves an incident): run it once per fresh seed
// (scripts/fett-twin/reset.sh). A step is PASS only when its assertion actually ran against rendered content;
// anything it could not exercise is reported as such, never as a pass. Loopback only.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(ROOT, "package.json"));
const { chromium } = require("@playwright/test");
const { Client } = require("pg");

const env = (k, d) => process.env[k] ?? d;
const APP = `http://localhost:${env("FETT_TWIN_APP_PORT", "3995")}`;
const MAIL = `http://127.0.0.1:${env("FETT_TWIN_MAIL_PORT", "63324")}`;
const DB = `postgresql://postgres:postgres@127.0.0.1:${env("FETT_TWIN_DB_PORT", "63322")}/postgres`;
const SHOTS = env("FETT_TWIN_SHOTS", "");
const D = "@fett-twin.synth.local";
const TZ = "America/Los_Angeles";
if (/:(5432[1-4])\b/.test(`${MAIL} ${DB}`)) throw new Error("refusing: the shared fleet stack is not a twin target");

const results = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push(["PASS", name, detail ?? ""]);
  } catch (e) {
    results.push(["FAIL", name, String(e.message).split("\n")[0].slice(0, 220)]);
  }
}
const shot = async (page, n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });

const db = new Client({ connectionString: DB });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const studio = await one(`select id from public.studios where slug = 'fett-twin'`);
const ca = await one(`select id from public.studios where slug = 'fett-twin-ca'`);
if (!studio || !ca) throw new Error("no seeded twin: run scripts/fett-twin/reset.sh first");
const client = async (n) => one(`select id from public.clients where studio_id = $1 and name = $2`, [studio.id, `SYNTH-FETT Client ${n}`]);
const c01 = await client("01");
const c05 = await client("05");
const c07 = await client("07");
const caClient = await one(`select id from public.clients where studio_id = $1`, [ca.id]);
const recent = await one(
  `select s.id from public.sessions s join public.session_blocks b on b.session_id = s.id
     join public.treatment_setup_captures c on c.session_block_id = b.id
    where s.studio_id = $1 and s.client_id = $2 group by s.id, s.started_at order by s.started_at desc limit 1`,
  [studio.id, c01.id],
);
const paySession = await one(`select id from public.sessions where studio_id = $1 and client_id = $2 order by started_at desc limit 1`, [studio.id, c05.id]);
const consult = await one(`select id from public.services where studio_id = $1 and modality = 'consultation'`, [studio.id]);
const e4 = await one(`select id from public.practitioners where studio_id = $1 and email = $2`, [studio.id, `electrologist-4${D}`]);

/** The next LA weekday at least 2 days out, as YYYY-MM-DD (receptionist form date input). */
function laWeekday(minDays) {
  for (let d = minDays; d < minDays + 10; d += 1) {
    const t = new Date(Date.now() + d * 86_400_000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(t).map((p) => [p.type, p.value]));
    if (!["Sat", "Sun"].includes(parts.weekday)) return `${parts.year}-${parts.month}-${parts.day}`;
  }
  throw new Error("no weekday found");
}

async function magicLogin(page, email, landing = /dashboard|front-desk|choose|admin|onboarding|welcome/) {
  const ids = async () => (((await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()).messages) ?? []).map((m) => m.ID);
  await page.goto(`${APP}/login`);
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = new Set(await ids());
  await page.getByRole("button", { name: /send magic link/i }).click();
  for (let i = 0; i < 60; i += 1) {
    const fresh = (await ids()).find((id) => !seen.has(id));
    if (fresh) {
      const m = await (await fetch(`${MAIL}/api/v1/message/${fresh}`)).json();
      const link = `${m.Text ?? ""}\n${m.HTML ?? ""}`.match(/https?:\/\/[^\s"'<>\])]+verify[^\s"'<>\])]*/)?.[0]?.replaceAll("&amp;", "&");
      if (link) {
        await page.goto(link);
        await page.waitForURL(landing, { timeout: 30_000 });
        return page.url().replace(APP, "");
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic link for ${email}`);
}

const browser = await chromium.launch();
const newPage = async () => (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const deliveryCard = (page) => page.locator("section, article, div").filter({ has: page.getByRole("heading", { name: "Message delivery" }) }).last();

// 1. OWNER — console truthfulness against the seeded state
const owner = await newPage();
await step("1a owner magic-link login", async () => `landed ${await magicLogin(owner, `owner${D}`)}`);
await step("1b console delivery card states the seeded incidents (2 open) without client details", async () => {
  await owner.goto(`${APP}/settings/overview`);
  const card = deliveryCard(owner);
  await card.getByRole("heading", { name: "Message delivery" }).waitFor({ timeout: 20_000 });
  const text = await card.innerText();
  await shot(owner, "1b-console-delivery");
  if (!/2 open delivery problems/i.test(text)) throw new Error(`card does not state 2 open problems: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  if (/SYNTH-FETT Client|@fett-twin/.test(text)) throw new Error("card leaks client details");
  return text.replace(/\s+/g, " ").slice(0, 200);
});
await step("1c console payments + SMS readiness match the seed (US/USD test account; SMS not sending)", async () => {
  const body = (await owner.locator("main").innerText()).replace(/\s+/g, " ");
  await shot(owner, "1c-console");
  const usd = /USD|United States/.test(body);
  const smsLive = /SMS (is )?(live|sending|active)\b/i.test(body);
  if (!usd) throw new Error("console does not state the US/USD jurisdiction");
  if (smsLive) throw new Error("console claims SMS is live, but every SMS toggle is off");
  return `US/USD stated; SMS not claimed live`;
});
await step("1d team lists the five treating electrologists", async () => {
  await owner.goto(`${APP}/settings/team`);
  const n = await owner.getByText(/SYNTH-FETT Electrologist \d/).count();
  if (n < 5) throw new Error(`only ${n} listed`);
  return `${n} listed`;
});

// 2. RECEPTIONIST — real UI booking, then a clinical denial
const desk = await newPage();
await step("2a receptionist magic-link login", async () => `landed ${await magicLogin(desk, `front-desk${D}`)}`);
await step("2b receptionist books through the front-desk UI", async () => {
  await desk.goto(`${APP}/front-desk`);
  await desk.getByRole("link", { name: "Book" }).click();
  await desk.getByRole("search", { name: "Find a client" }).getByRole("searchbox").fill("SYNTH-FETT Client 07");
  await desk.getByRole("button", { name: "Search" }).click();
  const form = desk.getByRole("form", { name: "Book an appointment" });
  // The option label carries the phone ("SYNTH-FETT Client 07 · +1555…"), so select by the owned id.
  await form.getByLabel("Client").selectOption(c07.id);
  await form.getByLabel("Service").selectOption(consult.id);
  await form.getByLabel("Practitioner").selectOption(e4.id);
  await form.getByLabel("Date").fill(laWeekday(2));
  await form.getByLabel(/^Time/).fill("14:00");
  await form.getByRole("button", { name: "Book appointment" }).click();
  await form.getByRole("status").filter({ hasText: "Appointment booked." }).waitFor({ timeout: 20_000 });
  await shot(desk, "2b-desk-booked");
  const row = await one(
    `select a.status, a.created_by_receptionist_id is not null as by_desk from public.appointments a
      where a.studio_id = $1 and a.client_id = $2 and a.practitioner_id = $3 order by a.created_at desc limit 1`,
    [studio.id, c07.id, e4.id],
  );
  if (!row?.by_desk) throw new Error(`booking not attributed to the receptionist: ${JSON.stringify(row)}`);
  return `booked, status ${row.status}, attributed to the receptionist`;
});
await step("2c receptionist is DENIED a clinical client record", async () => {
  await desk.goto(`${APP}/clients/${c01.id}`);
  const body = await desk.locator("body").innerText();
  if (/Upper lip|µA|Electrolysis Session/.test(body)) throw new Error("clinical content visible");
  return `redirected to ${desk.url().replace(APP, "")}`;
});

// 3. PRACTITIONER — treatment history, tenant negative, USD charge / receipt / refund
const e1 = await newPage();
await step("3a electrologist-1 magic-link login", async () => `landed ${await magicLogin(e1, `electrologist-1${D}`)}`);
await step("3b machine panel: latest coherent capture (revision 2, 180 µA) on the named unit", async () => {
  await e1.goto(`${APP}/clients/${c01.id}/sessions/${recent.id}`);
  await e1.getByTestId(/^edit-area-/).first().click({ timeout: 20_000 });
  await e1.getByTestId("machine-first-trigger").waitFor({ timeout: 20_000 });
  await e1.getByTestId("machine-first-open").click();
  await e1.getByTestId("machine-first-panel").waitFor({ timeout: 20_000 });
  const prior = e1.getByTestId("machine-prior-setup");
  await prior.waitFor({ timeout: 20_000 });
  const t = (await prior.innerText()).replace(/\s+/g, " ");
  await shot(e1, "3b-machine-panel");
  if (!/Room 1 demo/.test(t) || !/180/.test(t)) throw new Error(`prior setup: ${t.slice(0, 160)}`);
  return t.slice(0, 160);
});
await step("3c cross-tenant: the Canadian studio's client is NOT visible", async () => {
  const r = await e1.goto(`${APP}/clients/${caClient.id}`);
  if (/SYNTH-FETT CA Client/.test(await e1.locator("body").innerText())) throw new Error("other tenant's client rendered");
  return `status ${r?.status()}`;
});
await step("3d USD session charge through fake Stripe: paid $150.00 USD", async () => {
  await e1.goto(`${APP}/clients/${c05.id}/sessions/${paySession.id}`);
  const region = e1.getByRole("region", { name: "Session payment" });
  await region.getByText("Final charge (USD)").waitFor({ timeout: 20_000 });
  await region.getByRole("button", { name: /prepare session payment/i }).click();
  await region.getByRole("button", { name: /^run charge$/i }).click();
  await region.getByRole("button", { name: /confirm: run charge/i }).click();
  await region.getByTestId("payment-summary-paid").filter({ hasText: /Paid · \$150\.00 USD/ }).waitFor({ timeout: 30_000 });
  await shot(e1, "3d-paid");
  const a = await one(`select status, currency, amount_cents, receipt_status from public.payment_charge_attempts where studio_id = $1 order by created_at desc limit 1`, [studio.id]);
  return `attempt ${JSON.stringify(a)}`;
});
await step("3e practitioner is NOT offered a refund (owner authority)", async () => {
  await e1.reload();
  const region = e1.getByRole("region", { name: "Session payment" });
  await region.getByTestId("payment-summary-paid").waitFor({ timeout: 20_000 });
  const n = await region.getByRole("button", { name: /^refund charge$/i }).count();
  if (n !== 0) throw new Error("a practitioner was offered Refund charge");
  return "no refund control for the practitioner";
});
await step("3f owner refunds that charge (fake Stripe)", async () => {
  await owner.goto(`${APP}/clients/${c05.id}/sessions/${paySession.id}`);
  const region = owner.getByRole("region", { name: "Session payment" });
  await region.getByRole("button", { name: /^refund charge$/i }).click({ timeout: 20_000 });
  await region.getByRole("button", { name: /confirm: refund charge/i }).click();
  await owner.getByText("Refund succeeded.").waitFor({ timeout: 30_000 });
  await shot(owner, "3f-refunded");
  const a = await one(`select refund_status from public.payment_charge_attempts where studio_id = $1 order by created_at desc limit 1`, [studio.id]);
  return `refund_status ${a?.refund_status}`;
});

// 4. CLIENT — public booking with the practitioner picker
const pub = await newPage();
await step("4a public booking offers the five electrologists (capacity LIVE)", async () => {
  await pub.goto(`${APP}/book/fett-twin`);
  await pub.getByRole("button", { name: /new client/i }).first().click();
  const picker = pub.getByTestId("practitioner-picker");
  await picker.waitFor({ timeout: 20_000 });
  const n = ((await picker.innerText()).match(/Electrologist \d/g) ?? []).length;
  await shot(pub, "4a-public-picker");
  if (n < 5) throw new Error(`picker offers ${n}`);
  return `${n} offered`;
});

// 5. SUPPORT — delivery failure recovery, then the owner card reflects it
const ops = await newPage();
await step("5a support operator resolves one incident; the owner card drops to 1 open", async () => {
  await magicLogin(ops, `twin-operator${D}`, /.*/);
  await ops.goto(`${APP}/admin/delivery`);
  await ops.getByRole("heading", { name: "Message delivery", level: 1 }).waitFor({ timeout: 20_000 });
  const row = ops.getByRole("listitem").filter({ hasText: "SYNTH-FETT Twin Clinic (LA)" }).first();
  await row.getByLabel("Resolution").selectOption("acknowledged");
  await row.getByRole("button", { name: "Resolve" }).click();
  await ops.waitForTimeout(1500);
  await shot(ops, "5a-support-resolved");
  const r = await one(`select count(*) filter (where resolved_at is not null)::int as resolved, count(*)::int as total from public.delivery_incidents where studio_id = $1`, [studio.id]);
  await owner.goto(`${APP}/settings/overview`);
  const card = (await deliveryCard(owner).innerText()).replace(/\s+/g, " ");
  if (!/1 open delivery problem/i.test(card)) throw new Error(`owner card after resolve: ${card.slice(0, 160)}`);
  return `incidents resolved ${r.resolved}/${r.total}; owner card now states 1 open`;
});

await browser.close();
await db.end();
console.log("\n[fett-twin walkthrough]");
for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? `  — ${d}` : ""}`);
process.exitCode = results.some(([s]) => s === "FAIL") ? 1 : 0;
