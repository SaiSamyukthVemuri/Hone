// LOCAL-ONLY synthetic Fett twin (#825): ONE payment step against the served twin, so a scenario can put a
// server restart BETWEEN steps (the walkthrough runs its charge and refund in one process lifetime).
//
//   node scripts/fett-twin/pay-step.mjs charge <daysAgo>   electrologist 1 charges client 05's visit <daysAgo> days back
//   node scripts/fett-twin/pay-step.mjs refund <daysAgo>   the owner refunds that visit's charge
//
// The seed provides client-05 visits 1, 2 and 3 days back; the walkthrough uses the newest (1). Prints one
// JSON line: the attempt row as the database records it after the step. Same ports/env as walkthrough.mjs.
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
const D = "@fett-twin.synth.local";
if (/:(5432[1-4])\b/.test(`${MAIL} ${DB}`)) throw new Error("refusing: the shared fleet stack is not a twin target");

const [action, daysArg] = process.argv.slice(2);
const daysAgo = Number(daysArg);
if (!["charge", "refund"].includes(action) || !Number.isInteger(daysAgo) || daysAgo < 1 || daysAgo > 3) {
  throw new Error("usage: pay-step.mjs charge|refund <1..3>");
}

const db = new Client({ connectionString: DB });
await db.connect();
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const studio = await one(`select id from public.studios where slug = 'fett-twin'`);
const c05 = await one(`select id from public.clients where studio_id = $1 and name = 'SYNTH-FETT Client 05'`, [studio.id]);
// Visits are ordered newest first; daysAgo 1 is the newest.
const visit = (await db.query(`select id from public.sessions where studio_id = $1 and client_id = $2 order by started_at desc`, [studio.id, c05.id])).rows[daysAgo - 1];
if (!visit) throw new Error(`no client-05 visit ${daysAgo} days back: reseed with scripts/fett-twin/reset.sh`);

async function magicLogin(page, email) {
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
        await page.waitForURL(/dashboard|choose|onboarding|welcome/, { timeout: 30_000 });
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no magic link for ${email}`);
}

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await magicLogin(page, action === "charge" ? `electrologist-1${D}` : `owner${D}`);
  await page.goto(`${APP}/clients/${c05.id}/sessions/${visit.id}`);
  const region = page.getByRole("region", { name: "Session payment" });
  if (action === "charge") {
    await region.getByText("Final charge (USD)").waitFor({ timeout: 20_000 });
    await region.getByRole("button", { name: /prepare session payment/i }).click();
    await region.getByRole("button", { name: /^run charge$/i }).click();
    await region.getByRole("button", { name: /confirm: run charge/i }).click();
    await region.getByTestId("payment-summary-paid").filter({ hasText: /Paid · \$150\.00 USD/ }).waitFor({ timeout: 30_000 });
  } else {
    await region.getByRole("button", { name: /^refund charge$/i }).click({ timeout: 20_000 });
    await region.getByRole("button", { name: /confirm: refund charge/i }).click();
    await page.getByText("Refund succeeded.").waitFor({ timeout: 30_000 });
  }
  const a = await one(
    `select id, status, currency, amount_cents, refund_status, stripe_payment_intent_id from public.payment_charge_attempts where session_id = $1 order by created_at desc limit 1`,
    [visit.id],
  );
  console.log(JSON.stringify({ action, daysAgo, attempt: a }));
} finally {
  await browser.close();
  await db.end();
}
