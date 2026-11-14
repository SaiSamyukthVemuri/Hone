import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  getOwnerPractitionerId,
  mintIntakeToken,
  seedE2eClient,
  seedE2eIntake,
  seedE2eStudio,
  setIntakeCurrentStep,
  sql,
} from "./helpers/seed";
import { loginAsOwner } from "./helpers/flows";
import { INTAKE_STEPS, TOTAL_STEPS } from "@/lib/intake/questions";

// 0340 (HON-78): one intake taken through every legitimate browser writer, in order, against the real local
// database with 0340 in the chain: the client's token-page save, the client's submit, the owner's review, then the
// owner's notes. After every step the row still belongs to the same client and studio and is not hidden.
//
// DATABASE STATE IS THE ORACLE (as in intake-live-consent-forms and intake-review-integrity). The refusals of a
// direct member write are proven in tests/db/intake-terminal-identity.db.test.ts, not here; this spec proves the
// guard leaves the real journey intact.

const MOBILE = { width: 390, height: 844 };
const TREATMENT_BODY = "IDENTITY JOURNEY TREATMENT CONSENT. Synthetic wording for a local browser test.";

function answeredQuestionnaire(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required || q.conditional) continue;
      if (q.type === "multi_select") out[q.key] = [q.options?.[0]?.value ?? "x"];
      else if (q.type === "checkbox") out[q.key] = true;
      else if (q.type === "single_select") out[q.key] = q.options?.[0]?.value ?? "x";
      else if (q.type === "yes_no") out[q.key] = "no";
      else if (q.type === "date") out[q.key] = "1990-01-01";
      else out[q.key] = "provided";
    }
  }
  return out;
}

type Ident = { studio_id: string; client_id: string; deleted_at: string | null; status: string; revision: number };
async function ident(intakeId: string): Promise<Ident> {
  const rows = await sql<Ident>(
    `select studio_id, client_id, deleted_at::text as deleted_at, status, revision::int as revision
       from public.client_intake_forms where id = $1`,
    [intakeId],
  );
  return rows[0];
}

test("0340 journey: token save, token submit, owner review and notes; the intake keeps its client and studio", async ({
  page,
  browser,
}) => {
  const seed = await seedE2eStudio();
  await sql(
    `insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status, is_live)
     values ($1, $2, 'Treatment Consent', $3, 'treatment_consent', 1, 'active', true)`,
    [randomUUID(), seed.studioId, TREATMENT_BODY],
  );
  const { clientId } = await seedE2eClient(seed);
  const { clientId: otherClientId } = await seedE2eClient(seed); // a second client of the same studio
  const intakeId = await seedE2eIntake(seed.studioId, clientId, "in_progress", answeredQuestionnaire());
  await setIntakeCurrentStep(intakeId, TOTAL_STEPS);
  const expected = { studio_id: seed.studioId, client_id: clientId, deleted_at: null };
  const start = await ident(intakeId);
  expect(start).toMatchObject({ ...expected, status: "in_progress" });

  // 1. The client's token page: Continue saves the last questionnaire step through the governed revision write.
  const client = await browser.newContext({ viewport: MOBILE });
  const cp = await client.newPage();
  await cp.goto(`/intake/${mintIntakeToken(intakeId)}`);
  await cp.getByRole("button", { name: "Continue" }).click();
  await expect(cp.getByRole("heading", { name: "Consent forms" })).toBeVisible();
  await expect.poll(async () => (await ident(intakeId)).revision).toBeGreaterThan(start.revision);
  expect(await ident(intakeId)).toMatchObject({ ...expected, status: "in_progress" });

  // 2. The client submits.
  await cp.getByTestId("intake-consent-agree").check();
  await cp.getByRole("button", { name: "Submit intake" }).click();
  await cp.waitForURL("**/intake/thank-you");
  expect(await ident(intakeId)).toMatchObject({ ...expected, status: "submitted" });
  await client.close();

  // 3. The owner reviews it in the app.
  const ownerPractitionerId = await getOwnerPractitionerId(seed.studioId);
  await loginAsOwner(page, seed);
  await page.setViewportSize(MOBILE);
  await page.goto(`/clients/${clientId}/intake`);
  await page.getByTestId("intake-mark-reviewed").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByTestId("intake-reviewed-state")).toBeVisible();
  expect(await ident(intakeId)).toMatchObject({ ...expected, status: "reviewed" });
  const reviewer = await sql<{ reviewed_by: string }>(`select reviewed_by from public.client_intake_forms where id = $1`, [intakeId]);
  expect(reviewer[0].reviewed_by).toBe(ownerPractitionerId);

  // 4. The owner saves notes after review.
  await page.getByLabel("Practitioner notes").fill("identity journey note");
  await page.getByTestId("intake-save-notes").click();
  await expect(page.getByTestId("intake-review-hint")).toHaveText("Notes saved.");
  const notes = await sql<{ practitioner_notes: string }>(`select practitioner_notes from public.client_intake_forms where id = $1`, [intakeId]);
  expect(notes[0].practitioner_notes).toBe("identity journey note");
  expect(await ident(intakeId)).toMatchObject({ ...expected, status: "reviewed" });

  // The other client of the studio gained no intake from any of this.
  const other = await sql<{ n: number }>(`select count(*)::int n from public.client_intake_forms where client_id = $1`, [otherClientId]);
  expect(other[0].n).toBe(0);
});
