import { writeFileSync } from "node:fs";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { seedE2eStudio, seedE2eMember, seedConfirmedAppointment, getOwnerPractitionerId, sql } from "./helpers/seed";
import { loginAsOwner, loginByMagicLink } from "./helpers/flows";

// HON-44/HON-49 settlement-attestation role check, browser half (Machines). Privacy flagged that a practitioner may be able
// to record "paid by cash / e-transfer". 0254 and the app gates say no; this proves it through the real UI and through a
// replayed server action, with an OWNER positive control on the same page and fixture.
// Synthetic studio, the local stack, no Stripe call (recording a settlement never calls a provider). Self-contained: no
// feature flag; nothing here is held. Viewports 1280 and 390.
const VIEWPORTS = [{ name: "1280", width: 1280, height: 800 }, { name: "390", width: 390, height: 844 }] as const;
const MONEY_UI = /paid cash|paid by e-?transfer|paid another way|record how this was settled|waive the fee/i;

async function completedToday(studioId: string, hoursAgo = 3): Promise<{ appointmentId: string; clientId: string }> {
  const practitionerId = await getOwnerPractitionerId(studioId);
  const [client] = await sql<{ id: string }>("insert into public.clients (id, studio_id, name, email) values (gen_random_uuid(), $1, 'Settle Client', $2) returning id", [studioId, `sc-${studioId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}@harness.local`]);
  const start = new Date(Date.now() - hoursAgo * 3600_000);
  start.setUTCMinutes(0, 0, 0);
  const id = await seedConfirmedAppointment(studioId, practitionerId, client.id, start.toISOString(), new Date(start.getTime() + 3600_000).toISOString());
  await sql("update public.appointments set status='completed' where id=$1", [id]);
  return { appointmentId: id, clientId: client.id };
}

const settlements = (studioId: string) => sql<{ method: string }>("select method from public.appointment_settlements where studio_id=$1", [studioId]);

async function assertNoMoneyControls(page: Page, label: string) {
  await expect(page.locator('[data-testid^="settlement-open-"]'), `${label}: settlement buttons`).toHaveCount(0);
  await expect(page.locator('[data-testid="appointment-settlement-controls"]'), `${label}: settlement panel`).toHaveCount(0);
  await expect(page.locator("body"), `${label}: text`).not.toContainText(MONEY_UI);
}

async function signedIn(browser: Browser, email: string, vp: (typeof VIEWPORTS)[number]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  await loginByMagicLink(page, email);
  return { ctx, page };
}

for (const vp of VIEWPORTS) {
  test(`UI @${vp.name}: a practitioner sees and can use no paid-by-cash / e-transfer control; the owner can (control)`, async ({ browser }) => {
    const s = await seedE2eStudio();
    const member = await seedE2eMember(s);
    const { appointmentId } = await completedToday(s.studioId);
    const urls = ["/dashboard", "/calendar", `/calendar/${appointmentId}`];

    // Practitioner: every money surface is clean, and a Checkout button (if one is shown at all) yields no settlement panel.
    const prac = await signedIn(browser, member.email, vp);
    for (const url of urls) {
      await prac.page.goto(url);
      await prac.page.waitForLoadState("networkidle");
      await assertNoMoneyControls(prac.page, `practitioner ${url}`);
      const checkout = prac.page.getByTestId("checkout-button").first();
      if (await checkout.count()) {
        await checkout.click();
        await prac.page.waitForTimeout(1500);
        await assertNoMoneyControls(prac.page, `practitioner ${url} after Checkout`);
      }
    }
    expect(await settlements(s.studioId)).toEqual([]);

    // Owner control: the SAME completed visit offers the controls through Checkout on the dashboard.
    const owner = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const op = await owner.newPage();
    await loginAsOwner(op, s);
    await op.goto("/dashboard");
    await op.getByTestId("checkout-button").first().click();
    await expect(op.getByTestId("settlement-open-paid_cash")).toBeVisible({ timeout: 30_000 });
    await expect(op.getByTestId("settlement-open-paid_e_transfer")).toBeVisible();
  });
}

test("server action: a practitioner's replay of the owner's recordAppointmentSettlement call is refused and writes nothing", async ({ browser }) => {
  const s = await seedE2eStudio();
  const member = await seedE2eMember(s);
  // SETUP: recording a settlement needs a verified payment country and currency (0214/0224); the fixture studio has none.
  await sql(`select * from public.set_studio_payment_jurisdiction($1,'CA','cad',$2,$3,false,$4)`, [s.studioId, "fixture:e2e", "Synthetic verified onboarding pair", `fixture:${s.studioId.slice(0, 8)}`]);
  const a = await completedToday(s.studioId); // the owner records this one (capture)
  const b = await completedToday(s.studioId, 6); // the practitioner's replay targets this one

  const owner = await browser.newContext();
  const op = await owner.newPage();
  await loginAsOwner(op, s);
  await op.goto("/dashboard");
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  op.on("request", (req) => {
    const h = req.headers();
    const body = req.postDataBuffer()?.toString("utf8") ?? "";
    if (req.method() === "POST" && h["next-action"] && (body.includes(a.appointmentId) || body.includes(b.appointmentId))) captured = { url: req.url(), headers: h, body };
  });
  await op.getByTestId("checkout-button").first().click();
  await op.getByTestId("settlement-open-paid_cash").click();
  await op.getByTestId("settlement-amount").fill("50");
  await op.getByTestId("settlement-confirm-paid_cash").click();
  await expect.poll(async () => (await settlements(s.studioId)).length, { timeout: 30_000 }).toBe(1);
  expect(captured, "the owner's server action request was captured").not.toBeNull();
  const cap = captured as unknown as { url: string; headers: Record<string, string>; body: string };

  // Replay with the PRACTITIONER's cookies against the OTHER visit.
  const prac = await browser.newContext();
  const pp = await prac.newPage();
  await loginByMagicLink(pp, member.email);
  const headers: Record<string, string> = {};
  for (const k of ["content-type", "next-action", "next-router-state-tree", "accept"]) if (cap.headers[k]) headers[k] = cap.headers[k];
  // The dashboard's first Checkout may be either visit: swap whichever id the owner's call carried for the OTHER visit.
  const [from, to] = cap.body.includes(a.appointmentId) ? [a.appointmentId, b.appointmentId] : [b.appointmentId, a.appointmentId];
  const res = await prac.request.post(cap.url, { headers, data: cap.body.split(from).join(to) });
  const text = await res.text();
  expect(text).not.toMatch(/"ok":\s*true/);
  // The refusal must be the owner gate itself (not a stale action id or an unrelated failure that merely looks like a refusal).
  expect(text).toMatch(/not_owner|Only the studio owner can do that/);
  if (process.env.SETTLE_REPLAY_OUT) writeFileSync(process.env.SETTLE_REPLAY_OUT, `status=${res.status()}\n${text.slice(0, 600)}\n`);
  const after = await sql<{ appointment_id: string; method: string }>("select appointment_id, method from public.appointment_settlements where studio_id=$1", [s.studioId]);
  expect(after).toEqual([{ appointment_id: from, method: "paid_cash" }]); // only the owner's visit; nothing for the replayed one
});
