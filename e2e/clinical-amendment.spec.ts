import { test, expect } from "@playwright/test";
import {
  seedE2eStudio,
  seedFinalizedSession,
  setStudioCorrectionsEnabled,
  getAmendmentCount,
  getClinicalAuditEventCount,
  getSessionRecordState,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// ===========================================================================
// Amendment path — real browser, real stack (PR: amendment-path reliability).
//
// Drives the FULL amend path the way a practitioner does: UI (Amend record
// tab) -> client submit handler -> server action -> PostgREST RPC
// (amend_finalized_session) -> amendment row + clinical audit event ->
// router.refresh() -> the amendment appears in Version history. Then it drives
// a REAL server-side failure (the studio flag is revoked between page render
// and submit, so the action re-reads it and refuses) to prove the prominent
// error UI: "Nothing was saved", a reference id, fields retained, no false
// success, and NO amendment persisted.
//
// Deterministic by construction: unique e2e-prefixed seed per run, disposable
// local DB, real magic-link login (no auth bypass), dummy provider keys.
// ===========================================================================

test.describe.configure({ mode: "serial" });

let seed: E2eSeed;
let ok: { clientId: string; sessionId: string; snapshotId: string };
let bad: { clientId: string; sessionId: string; snapshotId: string };

test("finalized-record amendment: valid flow persists exactly one amendment + audit event, original untouched", async ({
  page,
}) => {
  await test.step("seed studio + two native, finalized, corrections-enabled sessions", async () => {
    seed = await seedE2eStudio();
    ok = await seedFinalizedSession(seed);
    bad = await seedFinalizedSession(seed);
  });

  await test.step("owner logs in via a real magic link", async () => {
    await loginAsOwner(page, seed);
  });

  const before = await getSessionRecordState(ok.sessionId);

  await test.step("open the finalized session's Amend record tab", async () => {
    await page.goto(`/clients/${ok.clientId}/sessions/${ok.sessionId}`);
    await expect(
      page.getByRole("heading", { name: /corrections & amendments/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /amend record/i }).click();
  });

  const reason = `Forgot to note the aftercare advice ${seed.runId}`;
  const body = `Advised the client to avoid sun exposure for 48 hours ${seed.runId}`;

  await test.step("submit a valid amendment and see the explicit success state", async () => {
    await page.getByLabel(/reason \(required\)/i).fill(reason);
    await page.getByLabel(/information to append/i).fill(body);
    await page.getByRole("button", { name: /add amendment/i }).click();
    // Explicit success — not merely "the action resolved".
    await expect(page.getByText(/later information added\./i)).toBeVisible({
      timeout: 20_000,
    });
    // No error panel appeared.
    await expect(page.getByText(/nothing was saved\./i)).toHaveCount(0);
  });

  await test.step("the amendment appears in Version history after refresh", async () => {
    await page.getByRole("button", { name: /version history/i }).click();
    await expect(page.getByText(new RegExp(`Reason: ${reason}`, "i"))).toBeVisible();
    await expect(page.getByText(body, { exact: false })).toBeVisible();
  });

  await test.step("DB ground truth: exactly one amendment + one audit event; original unchanged", async () => {
    expect(await getAmendmentCount(ok.sessionId)).toBe(1);
    expect(await getClinicalAuditEventCount(ok.sessionId, "amendment")).toBe(1);
    const after = await getSessionRecordState(ok.sessionId);
    expect(after.record_version).toBe(before.record_version);
    expect(after.current_snapshot_id).toBe(before.current_snapshot_id);
    expect(after.current_snapshot_id).toBe(ok.snapshotId);
  });
});

test("finalized-record amendment: a real server-side failure shows a prominent error, keeps the fields, and persists nothing", async ({
  page,
}) => {
  await test.step("open the second finalized session's Amend record tab (flag still on)", async () => {
    await page.goto(`/clients/${bad.clientId}/sessions/${bad.sessionId}`);
    await expect(
      page.getByRole("heading", { name: /corrections & amendments/i }),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /amend record/i }).click();
  });

  const reason = `Reason that must survive the error ${seed.runId}`;
  const body = `Body text that must survive the error ${seed.runId}`;

  await test.step("revoke the studio flag server-side, then submit", async () => {
    await page.getByLabel(/reason \(required\)/i).fill(reason);
    await page.getByLabel(/information to append/i).fill(body);
    // The panel is already on screen; the action re-reads the flag on submit,
    // so this produces a genuine end-to-end failure (no mock, no network stub).
    await setStudioCorrectionsEnabled(seed.studioId, false);
    await page.getByRole("button", { name: /add amendment/i }).click();
  });

  await test.step("a prominent 'Nothing was saved' error with a reference id appears", async () => {
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(/nothing was saved\./i);
    await expect(alert).toContainText(/reference:/i);
    // No false success.
    await expect(page.getByText(/later information added\./i)).toHaveCount(0);
  });

  await test.step("the fields are retained and nothing was persisted", async () => {
    await expect(page.getByLabel(/reason \(required\)/i)).toHaveValue(reason);
    await expect(page.getByLabel(/information to append/i)).toHaveValue(body);
    expect(await getAmendmentCount(bad.sessionId)).toBe(0);
    expect(await getClinicalAuditEventCount(bad.sessionId, "amendment")).toBe(0);
  });

  await test.step("restore the flag for any later steps", async () => {
    await setStudioCorrectionsEnabled(seed.studioId, true);
  });
});
