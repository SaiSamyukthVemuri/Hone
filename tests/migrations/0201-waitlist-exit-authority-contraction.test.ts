import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion } from "./helpers/migration-state";

// 0201 — WAIT-P1-EXIT SUCCESSOR. The exit stops reading `public.appointments`.
//
// The migration is applied and frozen; behaviour is proved against a real
// database in tests/db/waitlist-exit-authority-contraction.db.test.ts. This
// file pins the live action's result vocabulary to the codes the deployed
// command can return.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0201";
const FILE = fileForVersion(VERSION);
const SQL_BYTES = readFileSync(path.join(ROOT, "supabase/migrations", FILE));
const SQL = SQL_BYTES.toString("utf8");

describe("0201 and the application layer agree about what Close can answer", () => {
  // 0200's command could return `converted_instead` and `booking_unresolved`;
  // 0201's cannot, because Close no longer reads `public.appointments`.
  const ACTION = readFileSync(
    path.join(ROOT, "app/(app)/settings/waitlist/actions.ts"),
    "utf8",
  );
  const UNION = ACTION.slice(
    ACTION.indexOf("type CloseUnbookedInvitationResult"),
    ACTION.indexOf("const CLOSE_REFUSALS"),
  );

  it("every code this migration can return is declared by the action", () => {
    const body = SQL.slice(SQL.indexOf("function public.close_unbooked"));
    const fn = body.slice(0, body.indexOf("$$;"));
    const returned = new Set([...fn.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]));
    expect(returned.size, "the command returns nothing at all").toBeGreaterThan(0);
    // The three authority codes reach the union through the shared
    // `OwnerResolutionResult` alias rather than as literals, so they are
    // satisfied by that reference and not by their own spelling.
    const OWNER = new Set(["not_owner", "not_a_member", "invalid_input"]);
    for (const code of returned) {
      if (OWNER.has(code)) continue;
      expect(UNION, `the action does not declare ${code}`).toContain(`"${code}"`);
    }
    expect(
      UNION,
      "the propagated authority codes are no longer referenced",
    ).toContain("OwnerResolutionResult");
  });

  it("and the action declares NOTHING this migration cannot return", () => {
    // The direction that actually caught a defect: after 0201 the action still
    // declared the two retired codes and still listed `converted_instead` as a
    // success, so the surface advertised an outcome the database had stopped
    // producing.
    const body = SQL.slice(SQL.indexOf("function public.close_unbooked"));
    const fn = body.slice(0, body.indexOf("$$;"));
    const returned = new Set([...fn.matchAll(/return '([a-z_]+)'/g)].map((m) => m[1]));
    const declared = [...UNION.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const owner = new Set(["not_owner", "not_a_member", "invalid_input"]);
    for (const code of declared) {
      if (owner.has(code)) continue;
      expect(
        returned.has(code),
        `the action declares ${code}, which this command can never return`,
      ).toBe(true);
    }
  });

  it("the close action treats exactly ONE code as success", () => {
    const call = ACTION.slice(ACTION.indexOf("closeUnbookedWaitlistInvitationAction"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/successCode:\s*"closed"/);
  });
});
