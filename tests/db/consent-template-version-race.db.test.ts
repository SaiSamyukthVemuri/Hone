import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { buildConsentTemplateSnapshot } from "@/lib/consent/template-snapshot";

// The DB-observable half of the stale-form race.
//
// The behavioural fix lives in lib/consent/sign-consent-form.ts and is proven
// by tests/app/portal/consent-stale-form-integrity.test.ts. What THIS file
// pins is the database property that makes the race reachable in the first
// place, because that property is a schema fact and not an application one:
//
//   editing a live consent template changes title/body/version but leaves
//   status='active' AND is_live=true UNTOUCHED,
//
// which is exactly why the signing action's four-clause lookup still resolves
// the row after an edit and would happily snapshot the new text. If a future
// migration ever made an edit drop a template out of 'live' (a plausible
// "fix" someone might reach for), the integrity comparison would still be
// correct but this test would go red and tell them the threat model moved.
//
// It also pins that the canonical hash actually discriminates across such an
// edit -- a hash that did not change would make the comparison vacuous.

afterAll(async () => {
  await closePool();
});

type TemplateRow = {
  title: string;
  body: string;
  version: number;
  status: string;
  is_live: boolean;
};

async function readTemplate(id: string): Promise<TemplateRow> {
  const { rows } = await adminQuery(
    `select title, body, version, status, is_live
       from public.consent_form_templates where id = $1`,
    [id],
  );
  return rows[0] as TemplateRow;
}

function hashOf(t: TemplateRow): string {
  return buildConsentTemplateSnapshot({
    title: t.title,
    body: t.body,
    version: t.version,
  }).templateHash;
}

describe("consent template edits keep the row signable (why the race exists)", () => {
  it("a title/body/version edit leaves status='active' and is_live=true", async () => {
    const studio = await seedStudio("consentRace");
    const templateId = randomUUID();
    await adminQuery(
      `insert into public.consent_form_templates
         (id, studio_id, title, body, form_type, version, status, is_live)
       values ($1,$2,$3,$4,'treatment_consent',1,'active',true)`,
      [templateId, studio.studioId, "Treatment consent", "Version one text."],
    );

    const before = await readTemplate(templateId);
    expect(before.status).toBe("active");
    expect(before.is_live).toBe(true);

    // Exactly what updateConsentTemplateAction does: rewrite the content and
    // bump the version, touching neither status nor is_live.
    await adminQuery(
      `update public.consent_form_templates
          set title = $2, body = $3, version = version + 1
        where id = $1`,
      [templateId, "Treatment consent (revised)", "Version two text."],
    );

    const after = await readTemplate(templateId);
    expect(after.version).toBe(before.version + 1);
    expect(after.title).not.toBe(before.title);
    expect(after.body).not.toBe(before.body);

    // THE POINT: still live, still active, so the signing action's
    // four-clause lookup still resolves it. Nothing at the DB layer stops a
    // post-edit submission from finding this row -- which is precisely why
    // the integrity comparison has to exist in the application.
    expect(after.status).toBe("active");
    expect(after.is_live).toBe(true);
  });

  it("the canonical hash changes across that edit, so the comparison is not vacuous", async () => {
    const studio = await seedStudio("consentRaceHash");
    const templateId = randomUUID();
    await adminQuery(
      `insert into public.consent_form_templates
         (id, studio_id, title, body, form_type, version, status, is_live)
       values ($1,$2,$3,$4,'photo_consent',1,'active',true)`,
      [templateId, studio.studioId, "Photo consent", "Photo terms, version one."],
    );
    const renderedHash = hashOf(await readTemplate(templateId));

    await adminQuery(
      `update public.consent_form_templates
          set body = $2, version = version + 1 where id = $1`,
      [templateId, "Photo terms, version two."],
    );
    const currentHash = hashOf(await readTemplate(templateId));

    expect(currentHash).not.toBe(renderedHash);
  });

  it("a version-only bump also changes the hash", async () => {
    // The version participates in the canonical form, so a bump with
    // identical text is still a different document for signing purposes.
    const studio = await seedStudio("consentRaceVer");
    const templateId = randomUUID();
    await adminQuery(
      `insert into public.consent_form_templates
         (id, studio_id, title, body, form_type, version, status, is_live)
       values ($1,$2,$3,$4,'treatment_consent',1,'active',true)`,
      [templateId, studio.studioId, "Treatment consent", "Unchanged text."],
    );
    const renderedHash = hashOf(await readTemplate(templateId));

    await adminQuery(
      `update public.consent_form_templates
          set version = version + 1 where id = $1`,
      [templateId],
    );

    expect(hashOf(await readTemplate(templateId))).not.toBe(renderedHash);
  });

  it("client_consent_signatures is still INSERT-only for authenticated users", async () => {
    // The ceremony's immutability posture is unchanged by this PR: the table
    // has only a SELECT policy, so the service-role INSERT in the core
    // remains the sole write path.
    const { rows } = await adminQuery(
      `select cmd from pg_policies
        where schemaname = 'public' and tablename = 'client_consent_signatures'`,
    );
    const cmds = rows.map((r) => (r as { cmd: string }).cmd).sort();
    expect(cmds).toEqual(["SELECT"]);
  });
});
