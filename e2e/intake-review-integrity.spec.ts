import { expect, test, type Page } from "@playwright/test";
import {
  countReviewedIntakes,
  getIntakeRow,
  getOwnerPractitionerId,
  markReviewedOutOfBand,
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  type E2eSeed,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";

// F-CLIN-004 — intake review integrity, proven in a real browser against the
// real local database.
//
// DATABASE STATE IS THE ORACLE. Every assertion that matters reads the
// client_intake_forms row back with getIntakeRow(); on-screen copy is checked
// only where the copy itself is the deliverable (the in-progress notice, the
// confirmation text, the safe failure string).
//
// SCOPE. This proves the APPLICATION and UI path. It does NOT prove the
// database boundary — an authenticated direct PostgREST PATCH can still drive
// in_progress -> reviewed, because migration 0118 nests its review guards under
// `if old.status in ('submitted','reviewed')`. Closing that needs a separately
// authorized migration 0162. See docs/production/known-limitations.md L22.
//
// Both viewports are exercised from this one spec: 390x844 (the iPhone-class
// width the operator actually uses) and 1280x800 desktop.

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

// The single generic refusal the action returns for EVERY non-success outcome.
const SAFE_FAILURE =
  "This intake can only be reviewed after this client submits it. Refresh and check the current intake status.";

// After the refusal the page calls router.refresh(). If the settled server row
// turns out to be already reviewed, the UI re-words the refusal so it does not
// contradict the Reviewed banner rendered beneath it. Both strings are safe and
// carry no provider detail; which one is on screen depends only on the settled
// status, so tests must not assume the pre-refresh wording survives.
const ALREADY_REVIEWED =
  "This intake was already reviewed. The current record is shown below.";

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  // 1px rounding tolerance; more than that is a real horizontal scroll.
  expect(o.scroll).toBeLessThanOrEqual(o.client + 1);
}

// Measured in a live layout, not grepped from a class name.
async function assertTouchTargets(page: Page, testIds: string[]): Promise<void> {
  for (const id of testIds) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} should be laid out`).not.toBeNull();
    expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(44);
  }
}

let seed: E2eSeed;

test.beforeAll(async () => {
  seed = await seedE2eStudio();
});

test.describe("F-CLIN-004 intake review integrity", () => {
  // -------------------------------------------------------------------------
  // A. In-progress intake
  // -------------------------------------------------------------------------
  test("A. in-progress: warning shown, no review CTA, notes still save, review fields stay NULL", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "in_progress");

    await loginAsOwner(page, seed);

    for (const viewport of [DESKTOP, MOBILE]) {
      await page.setViewportSize(viewport);
      await page.goto(`/clients/${clientId}/intake`);

      // The pre-existing incomplete-answers warning is retained.
      await expect(
        page.getByText(/The client has not submitted their intake yet/i),
      ).toBeVisible();

      // Durable explanation, and NO review CTA anywhere on the page.
      await expect(page.getByTestId("intake-review-blocked-notice")).toContainText(
        "The client must submit this intake before it can be marked reviewed.",
      );
      await expect(page.getByTestId("intake-mark-reviewed")).toHaveCount(0);
      // The confirmation cannot exist either, since there is nothing to confirm.
      await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);

      await assertNoHorizontalOverflow(page);
      await assertTouchTargets(page, ["intake-save-notes"]);
    }

    // Notes remain editable and actually persist in a NON-reviewable status.
    const noteText = `in-progress note ${seed.runId}`;
    await page.getByLabel("Practitioner notes").fill(noteText);
    await page.getByTestId("intake-save-notes").click();
    await expect(page.getByTestId("intake-review-hint")).toHaveText("Notes saved.");

    // ORACLE: the note landed; every review field is still NULL.
    const row = await getIntakeRow(intakeId);
    expect(row?.practitioner_notes).toBe(noteText);
    expect(row?.status).toBe("in_progress");
    expect(row?.submitted_at).toBeNull();
    expect(row?.reviewed_at).toBeNull();
    expect(row?.reviewed_by).toBeNull();
  });

  // -------------------------------------------------------------------------
  // B. Submitted intake — confirmation required, Cancel writes nothing
  // -------------------------------------------------------------------------
  test("B. submitted: confirmation required, Cancel/Esc write nothing, Confirm transitions once and is reload-durable", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted");
    const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);

    await loginAsOwner(page, seed);
    await page.setViewportSize(MOBILE);
    await page.goto(`/clients/${clientId}/intake`);

    await expect(page.getByTestId("intake-mark-reviewed")).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertTouchTargets(page, ["intake-mark-reviewed", "intake-save-notes"]);

    // --- Cancel: opening and cancelling must write NOTHING. ----------------
    // Count server-action POSTs for the whole open/cancel cycle; it must be 0.
    let actionPosts = 0;
    const countActions = (req: import("@playwright/test").Request) => {
      if (req.method() === "POST" && req.headers()["next-action"]) actionPosts++;
    };
    page.on("request", countActions);

    await page.getByTestId("intake-mark-reviewed").click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("role", "alertdialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText(
      "Hone will record you as the reviewer and stamp the current time",
    );
    await assertTouchTargets(page, [
      "confirm-dialog-confirm",
      "confirm-dialog-cancel",
    ]);
    await assertNoHorizontalOverflow(page);

    await page.getByTestId("confirm-dialog-cancel").click();
    await expect(dialog).toHaveCount(0);

    // Escape also closes without writing.
    await page.getByTestId("intake-mark-reviewed").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    page.off("request", countActions);
    // Two full open/cancel cycles issued ZERO server actions.
    expect(actionPosts).toBe(0);

    // ORACLE: nothing was written by opening or cancelling.
    const afterCancel = await getIntakeRow(intakeId);
    expect(afterCancel?.status).toBe("submitted");
    expect(afterCancel?.reviewed_at).toBeNull();
    expect(afterCancel?.reviewed_by).toBeNull();

    // --- Confirm: exactly one transition. ----------------------------------
    await page.getByTestId("intake-mark-reviewed").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // The durable Reviewed state arrives from the refreshed SERVER render.
    await expect(page.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(page.getByTestId("intake-mark-reviewed")).toHaveCount(0);

    // ORACLE: persisted attribution is the authenticated practitioner.
    const reviewed = await getIntakeRow(intakeId);
    expect(reviewed?.status).toBe("reviewed");
    expect(reviewed?.reviewed_by).toBe(ownerPractitionerId);
    expect(reviewed?.reviewed_at).not.toBeNull();
    expect(reviewed?.submitted_at).not.toBeNull();

    // Reload: still Reviewed, still no second review button — not a toast.
    await page.reload();
    await expect(page.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(page.getByTestId("intake-mark-reviewed")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    // Same durable state at desktop width.
    await page.setViewportSize(DESKTOP);
    await page.reload();
    await expect(page.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(page.getByTestId("intake-mark-reviewed")).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    // Notes are still editable AFTER review, and saving them does not disturb
    // the review attribution.
    await page.getByLabel("Practitioner notes").fill("post-review note");
    await page.getByTestId("intake-save-notes").click();
    await expect(page.getByTestId("intake-review-hint")).toHaveText("Notes saved.");
    const afterNotes = await getIntakeRow(intakeId);
    expect(afterNotes?.practitioner_notes).toBe("post-review note");
    expect(afterNotes?.reviewed_at).toBe(reviewed?.reviewed_at);
    expect(afterNotes?.reviewed_by).toBe(reviewed?.reviewed_by);
    expect(afterNotes?.status).toBe("reviewed");
  });

  // -------------------------------------------------------------------------
  // C. Same-studio cross-client FORGED request
  // -------------------------------------------------------------------------
  test("C. a forged same-studio cross-client review fails safely and changes neither intake", async ({
    page,
  }) => {
    // Two clients in the SAME studio. The practitioner is legitimately
    // authenticated for both, so RLS alone does not stop this.
    const displayed = await seedE2eClient(seed);
    const victim = await seedE2eClient(seed);
    const displayedIntake = await seedE2eIntake(
      seed.studioId,
      displayed.clientId,
      "submitted",
    );
    const victimIntake = await seedE2eIntake(
      seed.studioId,
      victim.clientId,
      "submitted",
    );

    await loginAsOwner(page, seed);
    await page.setViewportSize(MOBILE);
    await page.goto(`/clients/${displayed.clientId}/intake`);
    await expect(page.getByTestId("intake-mark-reviewed")).toBeVisible();

    const before = await countReviewedIntakes(seed.studioId);

    // THE FORGERY. Rewrite the intake id inside the in-flight server-action
    // request body, so the action receives intake_id = the VICTIM's row while
    // client_id remains the DISPLAYED client. This is a genuine forged request
    // carrying the practitioner's real session — not a simulated one.
    let forged = false;
    await page.route("**/*", async (route) => {
      const req = route.request();
      const body = req.postData();
      if (
        req.method() === "POST" &&
        req.headers()["next-action"] &&
        body &&
        body.includes(displayedIntake)
      ) {
        forged = true;
        await route.continue({
          postData: body.split(displayedIntake).join(victimIntake),
        });
        return;
      }
      await route.continue();
    });

    await page.getByTestId("intake-mark-reviewed").click();
    await page.getByTestId("confirm-dialog-confirm").click();

    // The forged request must produce the SAFE, generic failure — never a
    // misleading success.
    await expect(page.getByTestId("intake-review-error")).toHaveText(SAFE_FAILURE);
    await page.unroute("**/*");
    expect(forged, "the server-action body was actually rewritten").toBe(true);

    // No success copy anywhere.
    await expect(page.getByTestId("intake-reviewed-state")).toHaveCount(0);
    await expect(page.getByTestId("intake-review-hint")).toHaveCount(0);

    // ORACLE: the VICTIM's intake is completely untouched.
    const victimRow = await getIntakeRow(victimIntake);
    expect(victimRow?.status).toBe("submitted");
    expect(victimRow?.reviewed_at).toBeNull();
    expect(victimRow?.reviewed_by).toBeNull();

    // ORACLE: the DISPLAYED intake is untouched too — the action did not fall
    // back to the route's own row.
    const displayedRow = await getIntakeRow(displayedIntake);
    expect(displayedRow?.status).toBe("submitted");
    expect(displayedRow?.reviewed_at).toBeNull();
    expect(displayedRow?.reviewed_by).toBeNull();

    // Studio-wide: zero new reviewed rows.
    expect(await countReviewedIntakes(seed.studioId)).toBe(before);
  });

  test("C2. a stale submitted page settles safely and never rewrites attribution", async ({
    page,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted");
    const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);

    await loginAsOwner(page, seed);
    await page.setViewportSize(MOBILE);
    await page.goto(`/clients/${clientId}/intake`);
    await expect(page.getByTestId("intake-mark-reviewed")).toBeVisible();

    // Another device reviews the row while this tab sits on its stale render.
    await markReviewedOutOfBand(intakeId, ownerPractitionerId);
    const stamped = await getIntakeRow(intakeId);
    expect(stamped?.status).toBe("reviewed");

    // The stale tab still shows the CTA. Confirming must fail safely.
    // NOTE: we do not assert the pre-refresh wording here — the failure path
    // immediately calls router.refresh(), so the copy legitimately settles to
    // ALREADY_REVIEWED below. Asserting the transient string would be a race.
    await page.getByTestId("intake-mark-reviewed").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId("intake-review-error")).toBeVisible();

    // ORACLE: attribution was NOT rewritten.
    const after = await getIntakeRow(intakeId);
    expect(after?.status).toBe("reviewed");
    expect(after?.reviewed_at).toBe(stamped?.reviewed_at);
    expect(after?.reviewed_by).toBe(stamped?.reviewed_by);

    // The page settles onto its real current state after the refresh, and the
    // refusal copy is reconciled with it: the generic "must submit first"
    // string must NOT sit above a Reviewed banner contradicting it.
    await expect(page.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(page.getByTestId("intake-mark-reviewed")).toHaveCount(0);
    await expect(page.getByTestId("intake-review-error")).toHaveText(
      ALREADY_REVIEWED,
    );
    await assertNoHorizontalOverflow(page);
  });

  // -------------------------------------------------------------------------
  // D. Concurrent review from two tabs
  // -------------------------------------------------------------------------
  test("D. two concurrent confirms produce exactly one transition and one durable reviewed row", async ({
    page,
    context,
  }) => {
    const { clientId } = await seedE2eClient(seed);
    const intakeId = await seedE2eIntake(seed.studioId, clientId, "submitted");

    await loginAsOwner(page, seed);

    // Two tabs in the SAME authenticated context, both rendered while the row
    // is still submitted — the real "two devices, one intake" race.
    const tabA = page;
    const tabB = await context.newPage();
    await tabA.setViewportSize(MOBILE);
    await tabB.setViewportSize(DESKTOP);
    await tabA.goto(`/clients/${clientId}/intake`);
    await tabB.goto(`/clients/${clientId}/intake`);
    await expect(tabA.getByTestId("intake-mark-reviewed")).toBeVisible();
    await expect(tabB.getByTestId("intake-mark-reviewed")).toBeVisible();

    const before = await countReviewedIntakes(seed.studioId);

    // Open both confirmations, then fire both as close to simultaneously as
    // the harness allows.
    await tabA.getByTestId("intake-mark-reviewed").click();
    await tabB.getByTestId("intake-mark-reviewed").click();
    await expect(tabA.getByTestId("confirm-dialog")).toBeVisible();
    await expect(tabB.getByTestId("confirm-dialog")).toBeVisible();

    await Promise.all([
      tabA.getByTestId("confirm-dialog-confirm").click(),
      tabB.getByTestId("confirm-dialog-confirm").click(),
    ]);

    // Exactly one tab reports success and the other reports the safe failure.
    //
    // CLASSIFY BY THE ERROR MARKER, NOT THE REVIEWED MARKER. The losing tab
    // calls router.refresh() after its safe failure, so it settles onto the
    // durable Reviewed state too — within a moment BOTH tabs carry
    // `intake-reviewed-state`, and classifying on that marker is a race that
    // would intermittently score the loser as a second "success". The error
    // marker is the only true discriminator: the winner never sets it, and on
    // the loser it is client state that survives router.refresh().
    const outcomes = await Promise.all(
      [tabA, tabB].map(async (p) => {
        const ok = p.getByTestId("intake-reviewed-state");
        const bad = p.getByTestId("intake-review-error");
        await expect(ok.or(bad).first()).toBeVisible({ timeout: 20_000 });
        return (await bad.count()) > 0 ? "failure" : "success";
      }),
    );
    expect(outcomes.filter((o) => o === "success")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "failure")).toHaveLength(1);

    // The failing tab shows one of the two SAFE strings — never a provider or
    // Postgres error. Which one depends on whether its router.refresh() has
    // already settled the status to reviewed, so accept either and assert the
    // absence of provider detail explicitly.
    const failing = (await tabA.getByTestId("intake-review-error").count())
      ? tabA
      : tabB;
    const failText = await failing.getByTestId("intake-review-error").innerText();
    expect([SAFE_FAILURE, ALREADY_REVIEWED]).toContain(failText.trim());
    expect(failText).not.toMatch(/duplicate key|constraint|relation|permission denied|PGRST|\b\d{5}\b/i);

    // ORACLE: exactly ONE new reviewed row studio-wide.
    expect(await countReviewedIntakes(seed.studioId)).toBe(before + 1);

    const row = await getIntakeRow(intakeId);
    expect(row?.status).toBe("reviewed");
    expect(row?.reviewed_at).not.toBeNull();
    expect(row?.reviewed_by).not.toBeNull();

    // Attribution is stable — the loser did not rewrite the winner's stamp.
    const firstAt = row?.reviewed_at;
    const firstBy = row?.reviewed_by;
    await tabA.reload();
    await tabB.reload();
    await expect(tabA.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(tabB.getByTestId("intake-reviewed-state")).toBeVisible();
    await expect(tabA.getByTestId("intake-mark-reviewed")).toHaveCount(0);
    await expect(tabB.getByTestId("intake-mark-reviewed")).toHaveCount(0);

    const again = await getIntakeRow(intakeId);
    expect(again?.reviewed_at).toBe(firstAt);
    expect(again?.reviewed_by).toBe(firstBy);

    await tabB.close();
  });
});
