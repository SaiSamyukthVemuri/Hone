import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";

// HON-75: the version-predicate update the action now uses, on the real schema. Two saves that both read version 1: exactly one updates; the other matches zero
// rows and the first one's text is intact. Synthetic data.
afterAll(async () => {
  await closePool();
});

describe("consent template edit: compare-and-swap on version", () => {
  it("of two concurrent saves that read the same version, only one lands", async () => {
    const studio = await seedStudio("hon75-tpl");
    const id = randomUUID();
    await adminQuery(`insert into public.consent_form_templates (id, studio_id, title, body, version, status) values ($1, $2, 'T', 'original', 1, 'active')`, [id, studio.studioId]);
    const save = (body: string) =>
      adminQuery(`update public.consent_form_templates set body = $2, version = 2 where id = $1 and studio_id = $3 and version = 1 returning id`, [id, body, studio.studioId]);
    const [a, b] = await Promise.all([save("owner A text"), save("owner B text")]);
    expect(a.rows.length + b.rows.length, "exactly one update matched").toBe(1);
    const row = (await adminQuery(`select body, version from public.consent_form_templates where id = $1`, [id])).rows[0];
    expect(Number(row.version)).toBe(2);
    expect(row.body).toBe(a.rows.length === 1 ? "owner A text" : "owner B text");
  });
});
