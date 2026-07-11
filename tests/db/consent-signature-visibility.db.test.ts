import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// P1-A: a same-studio practitioner can read the COMPLETE signed consent record
// (body snapshot + photo response); another studio cannot. RLS on
// client_consent_signatures is is_studio_member(studio_id) SELECT-only (0057).

afterAll(async () => {
  await closePool();
});

async function seedSignature(
  studio: SeededStudio,
  formType: string,
  response: string,
): Promise<{ templateId: string; signatureId: string }> {
  const templateId = randomUUID();
  await adminQuery(
    `insert into public.consent_form_templates (id, studio_id, title, body, form_type, version, status)
     values ($1,$2,$3,$4,$5,1,'active')`,
    [templateId, studio.studioId, "Photo consent", "I agree to the photo terms above.", formType],
  );
  const signatureId = randomUUID();
  await adminQuery(
    `insert into public.client_consent_signatures
       (id, studio_id, client_id, template_id, template_title_snapshot, template_body_snapshot,
        template_version, template_hash, signature_name, response, response_label_snapshot)
     values ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)`,
    [
      signatureId,
      studio.studioId,
      studio.clientId,
      templateId,
      "Photo consent",
      "I agree to the photo terms above.",
      "a".repeat(64),
      "Jane Client",
      response,
      response === "denied" ? "I do not consent to photo use." : "I consent to photo use as described above.",
    ],
  );
  return { templateId, signatureId };
}

describe("consent signature visibility (RLS)", () => {
  it("a same-studio member reads the full signed record incl. the photo response + body", async () => {
    const a = await seedStudio("consentA");
    const { signatureId } = await seedSignature(a, "photo_consent", "denied");

    const rows = await userQuery(
      a.userId,
      "select template_body_snapshot, response, response_label_snapshot from public.client_consent_signatures where id = $1",
      [signatureId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].response).toBe("denied");
    expect(rows.rows[0].response_label_snapshot).toMatch(/do not consent/i);
    expect(rows.rows[0].template_body_snapshot).toMatch(/photo terms/i);
  });

  it("an accepted photo response reads back correctly", async () => {
    const a = await seedStudio("consentAcc");
    const { signatureId } = await seedSignature(a, "photo_consent", "accepted");
    const rows = await userQuery(
      a.userId,
      "select response from public.client_consent_signatures where id = $1",
      [signatureId],
    );
    expect(rows.rows[0].response).toBe("accepted");
  });

  it("another studio's member CANNOT read the signed consent record", async () => {
    const a = await seedStudio("consentIsoA");
    const b = await seedStudio("consentIsoB");
    const { signatureId } = await seedSignature(a, "photo_consent", "denied");

    const foreign = await userQuery(
      b.userId,
      "select id from public.client_consent_signatures where id = $1",
      [signatureId],
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("no browser role may INSERT/UPDATE/DELETE a signature (append-only, immutable)", async () => {
    const a = await seedStudio("consentImm");
    const { signatureId } = await seedSignature(a, "treatment_consent", "accepted");
    // UPDATE by a same-studio member is denied (no UPDATE policy → 0 rows).
    const upd = await userQuery(
      a.userId,
      "update public.client_consent_signatures set signature_name = 'x' where id = $1",
      [signatureId],
    );
    expect(upd.rowCount).toBe(0);
  });
});
