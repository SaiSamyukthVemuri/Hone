import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  SESSION_FINANCIAL_COLUMNS,
  SESSION_NON_FINANCIAL_COLUMNS,
} from "@/lib/clients/session-columns";

// RBAC G-1: the non-owner client-profile read names its `sessions` columns, so the
// list must stay the table's exact column set minus the financial column(s). A column
// added later fails here instead of silently vanishing from the practitioner's profile
// (or a new money column silently riding along in the owner list).

afterAll(async () => {
  await closePool();
});

describe("sessions column split matches the live table", () => {
  it("non-financial + financial columns are exactly the table's columns", async () => {
    const r = await adminQuery(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions'`,
    );
    const live = r.rows.map((x: { column_name: string }) => x.column_name).sort();
    const declared = [...SESSION_NON_FINANCIAL_COLUMNS, ...SESSION_FINANCIAL_COLUMNS].sort();
    expect(declared).toEqual(live);
  });
});
