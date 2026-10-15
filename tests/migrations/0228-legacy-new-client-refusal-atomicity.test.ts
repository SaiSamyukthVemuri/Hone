import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { countVersion, migrationVersions } from "./helpers/migration-state";
import {
  grantedRoles,
  revokedRoles,
  REQUIRED_REVOKES,
  BLANKET_FUNCTION_GRANT,
} from "./helpers/grant-posture";

const VERSION = "0228";
const FILE = "supabase/migrations/0228_legacy_new_client_refusal_atomicity.sql";
const sql = readFileSync(FILE, "utf8");
/** Executable SQL only — line comments stripped before block comments. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top level only: this file's function INSERTS a client at runtime and must. */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

const FN = "create_public_appointment_for_new_client";
const ARGS =
  "uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid";

describe("0228 sits correctly in the migration sequence", () => {
  it("is present under its own version, and what it repairs is still there", () => {
    // NO isRepoMax PIN, for the reason 0225's test records: that is a claim
    // about which TREE the test runs in, and it goes red in composition where
    // higher numbers exist. The central tripwire owns "nothing above me".
    const versions = migrationVersions();
    expect(versions, "0228's own file is gone or renumbered").toContain(VERSION);
    expect(
      versions,
      "0228 redefines a function 0204 created; renumber 0204 away and this " +
        "migration redefines something that does not exist",
    ).toContain("0204");
    expect(
      versions,
      "the delegate it calls is 0170's create_public_appointment",
    ).toContain("0170");
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms (CLAUDE.md section 5).
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });
});

describe("0228 keeps the APPLIED migration frozen", () => {
  it("does not touch 0204's bytes", () => {
    // THE WHOLE REASON THIS FILE EXISTS. 0204 is applied (hosted is well above
    // it), so CLAUDE.md section 5 forbids editing it: the repair goes forward.
    // Pinned by content hash so an edit to 0204 cannot pass as a 0228 change.
    const legacy = readFileSync(
      "supabase/migrations/0204_new_client_admission_mode.sql",
      "utf8",
    );
    expect(
      createHash("sha256").update(legacy, "utf8").digest("hex"),
      "0204 is APPLIED and frozen — repair it forward, never in place",
    ).toBe("186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219");
  });

  it("redefines exactly ONE function, and it is the legacy wrapper", () => {
    const created = [
      ...TOP_LEVEL.matchAll(/create or replace function public\.([a-z_0-9]+)/g),
    ].map((m) => m[1]);
    expect(created).toEqual([FN]);
  });

  it("alters no schema object and writes no rows WHEN APPLIED", () => {
    for (const banned of [
      /\bcreate table\b/i, /\balter table\b/i, /\bdrop table\b/i,
      /\bcreate index\b/i, /\bcreate trigger\b/i, /\bcreate policy\b/i,
      /\binsert into\b/i, /\bupdate \w/i, /\bdelete from\b/i, /\btruncate\b/i,
      /\bdrop function\b/i, /\bdrop column\b/i, /\balter column\b/i,
    ]) {
      expect(TOP_LEVEL, `0228 must not contain ${banned} at top level`).not.toMatch(banned);
    }
  });
});

describe("0228 makes a refused legacy booking atomic", () => {
  it("encloses the client INSERT and the delegate in ONE subtransaction", () => {
    // THE CORRECTNESS OF THIS PATCH IS ITS SCOPE, and getting it wrong is
    // silent. A plpgsql exception block rolls back only to the start of its own
    // block, so a block opened AFTER the insert would catch the refusal and undo
    // nothing. The order must be: subtransaction opens, client is inserted,
    // delegate is called, refusal raises.
    const openAt = EXECUTABLE.indexOf("\n  begin\n");
    const insertAt = EXECUTABLE.indexOf("insert into public.clients");
    const delegateAt = EXECUTABLE.indexOf("public.create_public_appointment(");
    const raiseAt = EXECUTABLE.indexOf("hone_refused");
    const handlerAt = EXECUTABLE.indexOf("when sqlstate 'HB228'");

    expect(openAt, "the subtransaction must exist").toBeGreaterThan(-1);
    expect(insertAt, "the client insert must exist").toBeGreaterThan(-1);
    expect(
      insertAt,
      "the INSERT must be inside the subtransaction, or nothing is rolled back",
    ).toBeGreaterThan(openAt);
    expect(
      delegateAt,
      "the delegate must also be inside it, after the insert",
    ).toBeGreaterThan(insertAt);
    expect(raiseAt, "a refusal must RAISE to roll the subtransaction back").toBeGreaterThan(
      delegateAt,
    );
    expect(handlerAt, "and the handler must turn it back into a returned row").toBeGreaterThan(
      raiseAt,
    );
  });

  it("only rolls back a client THIS transaction created", () => {
    // Undoing a pre-existing client -- one the caller resolved, or one the
    // unique-violation re-read adopted -- would be a worse bug than the leak.
    expect(EXECUTABLE).toMatch(/v_created_client\s+boolean\s*:=\s*false/);
    expect(EXECUTABLE).toMatch(/v_created_client\s*:=\s*true/);
    expect(
      EXECUTABLE,
      "the rollback must be conditional on this transaction having created it",
    ).toMatch(/v_result <> 'created' and v_created_client/);
  });

  it("returns the refusal rather than raising out of the function", () => {
    // The signature is unchanged: callers keep reading a result row. The
    // verdict rides out through the errcode so the refusal survives the
    // rollback that erased the row it was about.
    expect(EXECUTABLE).toMatch(/using errcode = 'HB228'/);
    expect(EXECUTABLE).toMatch(/split_part\(sqlerrm, ':', 2\)/);
  });

  it("returns NULL client fields on the rolled-back path", () => {
    // The authoritative profile was read BEFORE the delegate, so those
    // variables describe a row that no longer exists once the subtransaction
    // unwinds. Returning them would hand the caller a client id it could not
    // find.
    const handler = EXECUTABLE.slice(EXECUTABLE.indexOf("when sqlstate 'HB228'"));
    const firstReturn = handler.slice(0, handler.indexOf(";") + 1);
    expect(firstReturn).toMatch(/null::uuid/);
    expect(
      firstReturn,
      "no client variable may be returned on the rolled-back path",
    ).not.toMatch(/v_client_id|v_name|v_phone|v_consent_at|v_opted_out_at/);
  });

  it("carries the correction that 0204's frozen comment cannot", () => {
    // 0204 documents the function as already preventing this orphan. That text
    // is frozen where it sits, so the corrected statement has to travel here.
    expect(EXECUTABLE).toMatch(/comment on function public\.create_public_appointment_for_new_client/);
    expect(sql).toMatch(/[Ss]upersedes 0204/);
  });
});

describe("0228 grant posture — revoke all four by name, then service_role only", () => {
  it("revokes from public, anon, authenticated and service_role", () => {
    expect(revokedRoles(EXECUTABLE, FN, ARGS)).toEqual(REQUIRED_REVOKES);
  });

  it("grants EXECUTE to service_role and NOTHING else", () => {
    // A redefinition RESETS grants, and Supabase's ALTER DEFAULT PRIVILEGES
    // hands EXECUTE to anon, authenticated and service_role at create time --
    // so a forward repair that forgets to restate them silently widens access.
    expect(grantedRoles(EXECUTABLE, FN, ARGS)).toEqual(["service_role"]);
    // Stray-grant control against a COPY of the real source.
    expect(
      grantedRoles(
        `${EXECUTABLE}\ngrant execute on function public.${FN}(${ARGS}) to public;`,
        FN,
        ARGS,
      ),
    ).toEqual(["public", "service_role"]);
    expect(EXECUTABLE).not.toMatch(BLANKET_FUNCTION_GRANT);
  });
});
