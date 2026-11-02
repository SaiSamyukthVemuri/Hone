import { writeFileSync } from "node:fs";
import { test, expect, type BrowserContext } from "@playwright/test";
import { insertBareStudio, seedOperatorAuthUser, sql } from "./helpers/seed";
import { loginByMagicLink } from "./helpers/flows";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN, E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "./helpers/local-env";

// EMAIL-TRUST (2 Nov, Machines). Real browser, real GoTrue + Mailpit, synthetic addresses.
// Proof of mailbox control is the SESSION's (a one-time link/code redeemed), never an account's confirmed flag. A password
// session on an AUTO-CONFIRMED account (created while "Confirm email" was off) must neither accept an invitation nor be a
// platform admin; the same person after a link sent to the address must. Run against a stack with confirmations ENABLED
// (test-only workdir config) and again with them disabled: both are in scope of the fix.
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const evidence: Record<string, unknown> = {};
test.afterAll(() => { if (process.env.AUTH_TRUST_BROWSER_EVIDENCE) writeFileSync(process.env.AUTH_TRUST_BROWSER_EVIDENCE, JSON.stringify(evidence, null, 2)); });

async function gotrue(path: string, body: Record<string, unknown>, key = E2E_SERVICE_ROLE_KEY) {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Put a GoTrue password session into the browser exactly as @supabase/ssr stores it (chunked base64 cookie). */
async function injectSession(ctx: BrowserContext, session: Record<string, unknown>) {
  const name = `sb-${new URL(E2E_SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 3180) parts.push(value.slice(i, i + 3180));
  const url = E2E_APP_ORIGIN;
  await ctx.addCookies(parts.map((v, i) => ({ name: parts.length === 1 ? name : `${name}.${i}`, value: v, url, httpOnly: false, sameSite: "Lax" as const })));
}
const membership = async (studioId: string, email: string) =>
  (await sql(`select p.id from public.practitioners p join auth.users u on u.id=p.user_id where p.studio_id=$1 and lower(u.email)=lower($2)`, [studioId, email])).length;

const HOOK_ON = process.env.AUTH_HOOK_ON === "1";

test("INVITATION: a password session on an auto-confirmed account cannot accept; a link to the address can, and kills the old password", async ({ browser }) => {
  test.skip(HOOK_ON, "needs a password session; with the 0292 hook enabled GoTrue refuses it (covered by the hook-mode tests)");
  const studio = await insertBareStudio("email-trust");
  const email = `invitee-${Math.random().toString(36).slice(2, 8)}@harness.local`;
  await sql(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1,$2,'practitioner','Invited Person')`, [studio.studioId, email]);
  // SETUP: the attacker's pre-registration: auto-confirmed, password known only to them.
  const created = await gotrue("admin/users", { email, password: PASSWORD, email_confirm: true });
  expect(created.status, "setup: createUser").toBe(200);
  const pw = await gotrue("token?grant_type=password", { email, password: PASSWORD }, ANON);
  expect(pw.status, "setup: attacker password session works").toBe(200);

  const ctx = await browser.newContext();
  await injectSession(ctx, pw.body);
  const page = await ctx.newPage();

  // NEGATIVE: the accept page asks for proof and does NOT reveal the studio or offer the consent form.
  await page.goto("/accept-invitation");
  await expect(page.getByTestId("verify-mailbox")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(studio.name);
  await expect(page.locator('input[name="consent"]')).toHaveCount(0);
  expect(await membership(studio.studioId, email)).toBe(0);

  // The invitation does not link through the app's normal landing either.
  await page.goto("/dashboard");
  expect(await membership(studio.studioId, email)).toBe(0);

  // POSITIVE: ask for the link (to the session's own address), follow it, and accept.
  await page.goto("/accept-invitation");
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /email me a link/i }).click();
  await expect(page.getByTestId("verify-mailbox-sent")).toBeVisible({ timeout: 30_000 });
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
  await page.waitForURL(/accept-invitation|dashboard/, { timeout: 30_000 });
  // The callback may have linked the invitation straight away (valid evidence) or routed to explicit acceptance.
  if (!/dashboard/.test(page.url())) {
    await expect(page.locator("body")).toContainText(studio.name, { timeout: 30_000 });
    await page.locator('input[name="consent"]').check();
    await page.getByRole("button", { name: /join|accept|confirm/i }).last().click();
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
  }
  await expect.poll(() => membership(studio.studioId, email), { timeout: 30_000 }).toBe(1);

  // HARDENING is a ROLLOUT SWITCH that defaults OFF (HONE_PROOF_HARDENING). Off: the account is untouched, the old password still
  // exists (the proof gates above are what protect the invitation). `all`: the pre-registrant's password and session are gone and
  // the person who proved the mailbox is still signed in (we are on /dashboard with a live session).
  const mode = process.env.HONE_PROOF_HARDENING ?? "off";
  const passwordAfter = (await gotrue("token?grant_type=password", { email, password: PASSWORD }, ANON)).status;
  const refresh = await gotrue("token?grant_type=refresh_token", { refresh_token: pw.body.refresh_token as string }, ANON);
  if (mode === "all") {
    expect(passwordAfter).toBe(400);
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    await page.goto("/dashboard");
    expect(new URL(page.url()).pathname).not.toBe("/login");
  } else {
    expect(passwordAfter, "flag off: no password reset").toBe(200);
  }
  const meta = await sql<{ m: Record<string, unknown> }>(`select raw_app_meta_data as m from auth.users where lower(email)=lower($1)`, [email]);
  expect("email_proof_hardened_at" in meta[0].m, `marker present only when hardening ran (mode ${mode})`).toBe(mode === "all");
  evidence.invitation = { membershipAfterProof: 1, hardeningMode: mode, passwordStatusAfter: passwordAfter };
});

test("PLATFORM ADMIN: a password session on the allowlisted address is not an operator; the same address through a magic link is", async ({ browser }) => {
  test.skip(HOOK_ON, "needs a password session (see the hook-mode tests)");
  const { email } = await seedOperatorAuthUser();
  const updated = await sql<{ id: string }>(`select id from auth.users where lower(email)=lower($1)`, [email]);
  const set = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users/${updated[0].id}`, { method: "PUT", headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD, email_confirm: true }) });
  expect(set.status, "setup: operator password").toBe(200);
  const pw = await gotrue("token?grant_type=password", { email, password: PASSWORD }, ANON);
  expect(pw.status).toBe(200);

  const bad = await browser.newContext();
  await injectSession(bad, pw.body);
  const bp = await bad.newPage();
  await bp.goto("/admin");
  await bp.waitForLoadState("networkidle");
  expect(new URL(bp.url()).pathname, "NEGATIVE: not served the admin console").not.toBe("/admin");
  const apiBad = await bad.request.get(`${E2E_APP_ORIGIN}/api/admin/runtime`, { maxRedirects: 0 });
  evidence.adminProbe = { page: new URL(bp.url()).pathname, api: apiBad.status(), cookieNames: (await bad.cookies()).map((c) => c.name), body: (await apiBad.text()).slice(0, 160) };
  // The middleware turns the unproven session away (a redirect to /no-access, or the route's own 404): never a 200 with the probe.
  expect([307, 308, 404], `NEGATIVE: /api/admin/runtime refused for the unproven session (got ${apiBad.status()})`).toContain(apiBad.status());

  const good = await browser.newContext();
  const gp = await good.newPage();
  // The operator has no studio, so the link does not land on /dashboard: follow it without that wait.
  await gp.goto("/login");
  await gp.getByLabel("I am using my invited email address").check();
  await gp.locator("#login-email").fill(email);
  const seenOp = await listMessageIds(email);
  await gp.getByRole("button", { name: /send magic link/i }).click();
  await gp.goto(await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seenOp }));
  await gp.goto("/admin");
  await expect(gp).toHaveURL(/\/admin/);
  // (The runtime-probe API is for an operator WITH a studio, so it is not the positive control for a studio-less operator.)
  await expect(gp.locator("body")).not.toContainText(/no access/i);
  evidence.admin = { passwordSessionServed: false, magicLinkSessionServed: true };
});

test("CALLBACK: signup/invite/magiclink token_hash links sign in through /auth/callback and carry mailbox proof", async ({ browser }) => {
  for (const type of ["invite", "magiclink"] as const) {
    const email = `cb-${type}-${Math.random().toString(36).slice(2, 8)}@harness.local`;
    if (type === "magiclink") expect((await gotrue("admin/users", { email, email_confirm: true })).status).toBe(200);
    const link = await gotrue("admin/generate_link", { type, email });
    expect(link.status, `setup: generate_link ${type}`).toBe(200);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const res = await page.goto(`/auth/callback?token_hash=${encodeURIComponent(link.body.hashed_token as string)}&type=${type}&next=/accept-invitation`);
    expect(res?.status()).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
    // Signed in WITH proof: the accept page shows the no-invitation message, not the verify-mailbox panel.
    expect(new URL(page.url()).pathname).toBe("/accept-invitation");
    await expect(page.getByTestId("verify-mailbox")).toHaveCount(0);
    await expect(page.locator("body")).toContainText(/no pending invitation/i);
    await ctx.close();
  }
  // A garbage token is refused to the login page, not a half session.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/auth/callback?token_hash=garbage&type=magiclink`);
  expect(page.url()).toContain("/login");
  evidence.callbackTokenHash = ["invite", "magiclink"];
});

test("0292 HOOK ON: a password session is refused by GoTrue; the invited person signs in by link and accepts the invitation", async ({ browser }) => {
  test.skip(!HOOK_ON, "runs only on a stack whose test-only config enables the custom access token hook");
  const studio = await insertBareStudio("email-trust-hook");
  const email = `hook-${Math.random().toString(36).slice(2, 8)}@harness.local`;
  await sql(`insert into public.pending_invitations (studio_id, email, role, display_name) values ($1,$2,'practitioner','Hook Invitee')`, [studio.studioId, email]);
  expect((await gotrue("admin/users", { email, password: PASSWORD, email_confirm: true })).status).toBe(200);
  const pw = await gotrue("token?grant_type=password", { email, password: PASSWORD }, ANON);
  expect(pw.status, "NEGATIVE: password sign-in refused").toBe(403);
  expect(pw.body.access_token).toBeUndefined();
  // POSITIVE: the real app flow (magic link through the real /login page) still works and accepts the invitation.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  await page.goto(await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen }));
  await page.waitForURL(/accept-invitation|dashboard/, { timeout: 30_000 });
  if (!/dashboard/.test(page.url())) {
    await expect(page.locator("body")).toContainText(studio.name, { timeout: 30_000 });
    await page.locator('input[name="consent"]').check();
    await page.getByRole("button", { name: /join|accept|confirm/i }).last().click();
    await page.waitForURL(/dashboard/, { timeout: 30_000 });
  }
  await expect.poll(() => membership(studio.studioId, email), { timeout: 30_000 }).toBe(1);
  // A reload keeps the session (refresh path passes the hook).
  await page.reload();
  expect(new URL(page.url()).pathname).not.toBe("/login");
  evidence.hookOn = { passwordSignIn: pw.status, magicLinkInvitationAccepted: true, reloadKeepsSession: true };
});
