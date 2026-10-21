import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  createLocalAuthUser,
  insertBareStudio,
  insertPendingInvite,
  insertMembershipInStudio,
  sql,
} from "./helpers/seed";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";
import { E2E_APP_ORIGIN } from "./helpers/local-env";

// LEAD-ALERT-01 (#831): the operator lead alert, accepted END TO END through
// the real surfaces against the local stack and the FAKE Resend transport
// (the lane's LEAD_ALERT_EMAIL is a `success+` address on ADMIN_EMAILS; no
// real provider exists in this lane).
//
//   1. A prospect's /demo request is saved, its alert is sent once to the
//      operator inbox and recorded as ACCEPTED (never "delivered"), and the
//      console says exactly that.
//   2. A FAILED alert is durable and visible; the operator's Retry sends it
//      under a NEW generation and it is accepted.
//   3. An operator who opens the lead link signed out, with a pending studio
//      invitation, accepts the invitation and lands on the lead (Codex P2
//      4263663458). A non-operator following the same path never reaches it.
//
// Worker-level failure, deadline and lease proofs live in
// tests/lib/platform-leads/*.test.ts and tests/db/platform-lead-alerts.db.test.ts.

const OPERATOR = "e2e-lead-operator@harness.local";
const RECIPIENT = "success+lead-ops@harness.local";
const RETURN_STUDIO_PREFIX = "e2e-lead-return-";

type AlertRow = {
  id: string;
  status: string;
  attempt_count: number;
  send_generation: number;
  provider_message_id: string | null;
  last_error_code: string | null;
};

async function alertForDemo(email: string): Promise<(AlertRow & { lead_id: string }) | null> {
  const rows = await sql<AlertRow & { lead_id: string }>(
    `select a.id, a.status, a.attempt_count, a.send_generation, a.provider_message_id,
            a.last_error_code, d.id as lead_id
       from public.platform_lead_alerts a
       join public.demo_requests d on d.id = a.demo_request_id
      where d.email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

/** A demo request saved the way the form saves it, with its alert. */
async function recordDemo(email: string): Promise<{ leadId: string; alertId: string }> {
  const [row] = await sql<{ result: string; lead_id: string; alert_id: string }>(
    "select * from public.record_platform_demo_request($1, $2, 'E2E Clinic', 'Toronto', null, null, null, null)",
    ["E2E Prospect", email],
  );
  expect(row.result).toBe("recorded");
  return { leadId: row.lead_id, alertId: row.alert_id };
}

/** This spec's operator back to no studio: only rows this spec created. */
async function resetOperator(): Promise<void> {
  await sql(
    `delete from public.practitioners p
      using public.studios s
      where p.studio_id = s.id and lower(p.email) = lower($1) and s.slug like $2`,
    [OPERATOR, `${RETURN_STUDIO_PREFIX}%`],
  );
  await sql("delete from public.pending_invitations where lower(email) = lower($1)", [OPERATOR]);
}

async function ensureOperator(): Promise<void> {
  const [{ count }] = await sql<{ count: string }>(
    "select count(*)::text as count from auth.users where lower(email) = lower($1)",
    [OPERATOR],
  );
  if (count === "0") await createLocalAuthUser(OPERATOR);
}

/** The real magic-link sign-in, in this page's browser context. */
async function signIn(page: Page, email: string): Promise<void> {
  if (!/\/login/.test(page.url())) await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
}

const leadPath = (leadId: string) => `/admin/leads/demo-request/${leadId}`;

test.describe("operator lead alerts — fake Resend", () => {
  test.skip(process.env.HONE_E2E_FAKE_RESEND === "0", "requires the lane's fake Resend transport");

  test.beforeAll(async () => {
    await ensureOperator();
    await resetOperator();
  });
  test.afterAll(async () => {
    await resetOperator();
  });

  test("a /demo request: saved, alert accepted once, and the console says accepted, not delivered", async ({ page }) => {
    const prospect = `success+prospect-${randomUUID().slice(0, 8)}@lead-alert-e2e.test`;
    await page.goto("/demo");
    await page.getByLabel("Your name").fill("Avery Prospect");
    await page.getByLabel("Email").fill(prospect);
    await page.getByLabel("Studio or practice name").fill("Maple Clinic");
    await page.getByRole("button", { name: "Request my walkthrough" }).click();
    await expect(page.getByText(/a real person will email you/i)).toBeVisible({ timeout: 30_000 });

    // Sent after the response, once, and recorded as ACCEPTED by the provider.
    await expect.poll(async () => (await alertForDemo(prospect))?.status, { timeout: 30_000 }).toBe("accepted");
    const alert = (await alertForDemo(prospect))!;
    expect(alert).toMatchObject({ attempt_count: 1, send_generation: 1, last_error_code: null });
    expect(alert.provider_message_id).toBeTruthy();

    await signIn(page, OPERATOR);
    await page.goto("/admin#lead-alerts");
    const card = page.locator("#lead-alerts");
    await expect(card.getByRole("heading", { name: "Lead alerts" })).toBeVisible();
    await expect(card).toContainText("On");
    // The recipient is masked; the address itself is never on the page.
    await expect(card).toContainText("s•••@h•••.local");
    await expect(page.getByText(RECIPIENT)).toHaveCount(0);
    await expect(card).toContainText("It does not confirm that it reached the inbox.");

    await page.goto(leadPath(alert.lead_id));
    const status = page.getByTestId("admin-lead-alert");
    await expect(status).toContainText("Alert accepted");
    await expect(status).toContainText("Inbox delivery is not confirmed");
    await expect(page.getByText(/\bdelivered\b/i)).toHaveCount(0);
  });

  test("a failed alert is durable and visible; Retry sends it under a new generation and it is accepted", async ({ page }) => {
    const prospect = `fail-${randomUUID().slice(0, 8)}@lead-alert-e2e.test`;
    const { alertId } = await recordDemo(prospect);
    // An attempt the provider refused for good, recorded by the worker's own commands.
    const [claim] = await sql<{ result: string; claim_token: string }>(
      "select result, claim_token from public.claim_platform_lead_alert($1, 120)",
      [alertId],
    );
    expect(claim.result).toBe("claimed");
    const [settled] = await sql<{ r: string }>(
      "select public.settle_platform_lead_alert($1, $2, 'fail', null, 'provider_rejected', 'validation_error') as r",
      [alertId, claim.claim_token],
    );
    expect(settled.r).toBe("failed");

    await signIn(page, OPERATOR);
    await page.goto("/admin#lead-alerts");
    const failed = page.getByTestId("lead-alerts-failed");
    await expect(failed).toBeVisible();
    const row = failed.locator("li", { has: page.locator(`input[name="id"][value="${alertId}"]`) });
    await expect(row).toContainText("1 of 5 attempts");
    await row.getByRole("button", { name: "Retry" }).click();

    await expect.poll(async () => (await alertForDemo(prospect))?.status, { timeout: 30_000 }).toBe("accepted");
    expect(await alertForDemo(prospect)).toMatchObject({ send_generation: 2, attempt_count: 1, last_error_code: null });
    const [audit] = await sql<{ n: string }>(
      "select count(*)::text as n from public.admin_action_events where action = 'platform_lead_alert_retried' and target_id = $1 and outcome = 'succeeded'",
      [alertId],
    );
    expect(audit.n).toBe("1");
  });

  test("an operator with a pending invitation signs in from the lead link, accepts, and lands on the lead", async ({ page }) => {
    const { leadId } = await recordDemo(`return-${randomUUID().slice(0, 8)}@lead-alert-e2e.test`);
    const studio = await insertBareStudio(RETURN_STUDIO_PREFIX.slice(4, -1));
    expect(studio.slug.startsWith(RETURN_STUDIO_PREFIX)).toBe(true);
    await insertPendingInvite(studio.studioId, OPERATOR);

    // Signed out: the lead link goes to sign-in, remembering the lead.
    await page.goto(leadPath(leadId));
    await page.waitForURL(/\/login/);
    await signIn(page, OPERATOR);

    // The invitation comes first, and is not skipped.
    await page.waitForURL(/\/accept-invitation/, { timeout: 30_000 });
    await expect(page.getByText(studio.name).first()).toBeVisible();
    await page.getByLabel(/I agree to the current/).check();
    await page.getByRole("button", { name: /Join .* as/ }).click();

    // Then the lead the operator opened.
    await page.waitForURL((url) => url.pathname === leadPath(leadId), { timeout: 30_000 });
    await expect(page.getByTestId("admin-lead-detail")).toBeVisible();
    const [m] = await sql<{ n: string }>(
      `select count(*)::text as n from public.practitioners p join auth.users u on u.id = p.user_id
        where lower(u.email) = lower($1) and p.studio_id = $2 and p.active`,
      [OPERATOR, studio.studioId],
    );
    expect(m.n).toBe("1");
  });

  test("a non-operator following the same lead link never reaches it", async ({ page }) => {
    const { leadId } = await recordDemo(`nonop-${randomUUID().slice(0, 8)}@lead-alert-e2e.test`);
    const person = `lead-nonop-${randomUUID().slice(0, 8)}@harness.local`;
    await createLocalAuthUser(person);

    await page.goto(leadPath(leadId));
    await page.waitForURL(/\/login/);
    await signIn(page, person);
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"), { timeout: 30_000 });
    expect(new URL(page.url()).pathname.startsWith("/admin")).toBe(false);
    await page.goto(leadPath(leadId));
    expect(new URL(page.url()).pathname.startsWith("/admin")).toBe(false);
    await expect(page.getByTestId("admin-lead-detail")).toHaveCount(0);
  });
});

// SEC-002: actual Hone document and RSC requests, not a framework fixture.
// No role grants or allowlist changes: a former-operator fixture is currently
// outside ADMIN_EMAILS. Revocation between requests is covered by guard units.
test.describe("SEC-002 admin document and RSC authorization", () => {
  test.describe.configure({ mode: "serial" });
  const run = randomUUID().slice(0, 8);
  const identities = ["member-a", "member-b", "deactivated", "former-operator"] as const;
  const emails = Object.fromEntries(identities.map((role) => [role, `sec002-${role}-${run}@harness.local`]));
  const studios: Array<{ studioId: string; name: string; ownerEmail: string }> = [];

  test.beforeAll(async () => {
    await ensureOperator();
    studios.push(await insertBareStudio(`sec002-a-${run}`), await insertBareStudio(`sec002-b-${run}`));
    for (const [index, role] of identities.entries()) {
      const userId = await createLocalAuthUser(emails[role]);
      await insertMembershipInStudio(studios[index % 2].studioId, userId, emails[role], role !== "deactivated");
    }
  });
  test.afterAll(async () => {
    // Only this suite's two exact synthetic studio IDs; auth identities remain
    // available for failure investigation. Never reset a retained target.
    for (const studio of studios) await sql("delete from public.studios where id = $1", [studio.studioId]);
  });

  const paths = () => ["/admin", ...studios.map((s) => `/admin/studios/${s.studioId}`),
    `/admin/studios/new?created=${studios[0].studioId}`, "/admin/ops-alerts", "/admin/delivery"];

  // Positive content canary runs first, in the same serial group/request shape.
  // RSC prefetch can return an empty router skeleton; it is NOT this proof.
  test("current platform operator proves full document and RSC page content", async ({ page }) => {
    await signIn(page, OPERATOR);
    for (const pathname of paths()) {
      const expected = pathname === "/admin" ? studios.map((s) => s.name)
        : pathname === "/admin/ops-alerts" ? ["Ops alerts"]
        : pathname === "/admin/delivery" ? ["Message delivery"]
        : [studios.find((studio) => pathname.includes(studio.studioId))!.name];
      for (const rsc of [false, true]) {
        const response = await page.request.get(`${E2E_APP_ORIGIN}${pathname}`, {
          maxRedirects: 0,
          headers: rsc ? { RSC: "1" } : {},
        });
        expect(response.status()).toBe(200);
        if (rsc) expect(response.headers()["content-type"]).toContain("text/x-component");
        const body = await response.text();
        for (const canary of expected) expect(body).toContain(canary);
      }
    }
  });

  for (const role of identities) {
    test(`${role} cannot read either studio through documents or RSC`, async ({ page }) => {
      await signIn(page, emails[role]);
      await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
      for (const pathname of paths()) {
        for (const rsc of [false, true]) {
          const response = await page.request.get(`${E2E_APP_ORIGIN}${pathname}`, {
            maxRedirects: 0,
            headers: rsc ? { RSC: "1" } : {},
          });
          const body = await response.text();
          const refused = [301, 302, 303, 307, 308, 401, 403, 404].includes(response.status())
            || (rsc && response.status() === 200 && /NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK;404/.test(body));
          expect(refused, `${role} ${pathname} ${rsc ? "RSC" : "document"} ${response.status()}`).toBe(true);
          for (const studio of studios) {
            expect(body).not.toContain(studio.name);
            expect(body).not.toContain(studio.ownerEmail);
          }
          expect(body).not.toContain("admin-lead-detail");
        }
      }
    });
  }


});
