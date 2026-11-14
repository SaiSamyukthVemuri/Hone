import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedStudio } from "./helpers/harness";
import { previewAuditMetadata, printAuditMetadata } from "@/lib/records/print/day-audit";

// HON-46 M2. The day packet's audit metadata is built by lib/records/print/
// day-audit.ts and accepted or refused by migration 0233 in the database. This
// ties the two together with the REAL builders, so a drift in either side (a key
// added to the builder, or a tightened allow-list) fails here instead of in
// production. The print-binding refusals themselves (different client, actor,
// scope, older than 30 minutes) are already proved by
// tests/db/clinical-records-audit-command.db.test.ts and are not repeated.

afterAll(() => closePool());

const DAY = "2026-09-15";
const code = (e: unknown) => (e as { code?: string }).code;

describe("day packet audit: the lib builders are accepted by 0233", () => {
  it("the real preview metadata, then the real print metadata citing it, are recorded as the owner", async () => {
    const s = await seedStudio("hon46dp");
    const call = (action: string, meta: Record<string, string>) =>
      asUser(s.userId, (q) => q(`select public.record_clinical_records_audit($1, $2, $3) as id`, [s.clientId, action, meta]));
    const preview = await call("clinical_records_previewed", previewAuditMetadata(DAY));
    const previewId = preview.rows[0].id as string;
    const printed = await call("clinical_records_printed", printAuditMetadata(DAY, previewId));
    expect(printed.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = (await adminQuery(`select action, metadata from public.audit_logs where entity_id = $1 order by created_at`, [s.clientId])).rows;
    expect(rows.map((r) => r.action)).toEqual(["clinical_records_previewed", "clinical_records_printed"]);
    expect(rows[0].metadata).toEqual({ scope: "day", day: DAY });
    expect(rows[1].metadata).toEqual({ scope: "day", day: DAY, preview_audit_id: previewId });
  });

  it("the day scope refuses any other key or a non-date day, each 22023", async () => {
    const s = await seedStudio("hon46dp2");
    for (const [why, meta] of [
      ["an extra range key", { ...previewAuditMetadata(DAY), from: DAY }],
      ["an extra client-name key", { ...previewAuditMetadata(DAY), client_name: "x" }],
      ["an impossible month", previewAuditMetadata("2026-13-01")],
      ["a datetime instead of a date", previewAuditMetadata(`${DAY}T00:00`)],
      ["no day", { scope: "day" }],
    ] as const) {
      await expect(
        asUser(s.userId, (q) => q(`select public.record_clinical_records_audit($1, 'clinical_records_previewed', $2)`, [s.clientId, meta])),
        why,
      ).rejects.toSatisfy((e) => code(e) === "22023");
    }
    expect((await adminQuery(`select count(*)::int as n from public.audit_logs where entity_id = $1`, [s.clientId])).rows[0].n).toBe(0);
  });
});
