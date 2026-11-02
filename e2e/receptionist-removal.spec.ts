import { test, expect } from "@playwright/test";
import { seedE2eStudio, createLocalAuthUser, getOwnerPractitionerId, sql } from "./helpers/seed";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "./helpers/local-env";
import { listMessageIds, waitForMagicLink } from "./helpers/mail";

// Receptionist desk: invite -> accept -> remove -> the SAME session cookie is refused (the browser half of the revocation
// proof; the old-JWT half over every receptionist function is tests/db/receptionist-removal-immediacy.db.test.ts).
//
// HELD, like fett-client-portrait.spec.ts: the app server must run with HONE_RECEPTIONIST_DESK_ENABLED=true, which the lane
// never sets. It self-skips everywhere except a dedicated run on an OWNED isolated stack (OPS heavy slot). Synthetic data
// only; no real invitation, mailbox or account. The invite UI is not wired into the Team page yet, so the pending invitation
// is inserted directly (the invite command itself is unit-tested in tests/desk/receptionist-owner-actions.test.ts).
const DESK_ON = E2E_WEB_SERVER_ENV.HONE_RECEPTIONIST_DESK_ENABLED === "true";
test.beforeEach(() => {
  test.skip(!DESK_ON, "the desk is OFF on this server (HONE_RECEPTIONIST_DESK_ENABLED is not true)");
});

async function signInAsReceptionist(page: import("@playwright/test").Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("I am using my invited email address").check();
  await page.locator("#login-email").fill(email);
  const seen = await listMessageIds(email);
  await page.getByRole("button", { name: /send magic link/i }).click();
  const link = await waitForMagicLink(email, E2E_APP_ORIGIN, { excludeIds: seen });
  await page.goto(link);
}

const memberships = (studioId: string, email: string) =>
  sql<{ id: string; active: boolean }>("select id, active from public.studio_receptionists where studio_id=$1 and lower(email)=lower($2)", [studioId, email]);

test("invite -> accept -> desk works -> remove -> the same cookie is refused", async ({ page, request }) => {
  const s = await seedE2eStudio();
  const email = `desk-${s.studioId.slice(0, 8)}@harness.local`;
  await createLocalAuthUser(email);

  // invite (the invitation row the owner command writes: role receptionist, pending)
  await sql(
    `insert into public.pending_invitations (studio_id, email, role, display_name, status) values ($1,$2,'receptionist','Synthetic Desk','pending')`,
    [s.studioId, email],
  );
  expect(await memberships(s.studioId, email)).toEqual([]); // an invitation alone grants nothing

  // accept = the invitee signs in; the membership appears, the desk answers
  await signInAsReceptionist(page, email);
  await expect.poll(async () => (await memberships(s.studioId, email)).filter((m) => m.active).length, { timeout: 30_000 }).toBe(1);
  await page.goto("/desk");
  await expect(page).toHaveURL(/\/desk/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // remove (the locked command the owner's Remove calls), then the SAME cookie
  const [m] = await memberships(s.studioId, email);
  const result = await sql<{ r: string }>(
    "select public.set_studio_receptionist_active($1,$2,$3,false) as r",
    [s.studioId, await getOwnerPractitionerId(s.studioId), m.id],
  );
  expect(result[0].r).toBe("updated");

  await page.goto("/desk");
  await expect(page).toHaveURL(/\/no-access|\/login/);
  await expect(page.locator("body")).not.toContainText(s.studioName);
  // the prefetch/RSC channel with the old cookie answers no desk content either
  const rsc = await request.get("/desk", { headers: { RSC: "1" }, maxRedirects: 0 });
  const text = await rsc.text();
  expect(text).not.toContain("Synthetic Desk");
  expect(text).not.toContain(s.studioName);
});
