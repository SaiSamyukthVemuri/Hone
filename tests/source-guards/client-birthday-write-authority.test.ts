import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// HON-58: an existing client's date_of_birth is changed only through update_client_profile_if_unchanged (0281), which
// compares the value the caller loaded with the stored one in the same statement. A direct UPDATE or upsert that names
// date_of_birth is a blind overwrite. New-client inserts and the intake sync RPC are different writes and are not matched.
//
// The standalone birthday action was removed in this slice: it had no caller, an exported server action is still reachable
// by a direct POST, and it read the current value itself and passed it as "expected", which made the compare vacuous.

const files = execFileSync("git", ["ls-files", "app", "lib", "components"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f));

const WRITE = /\.(update|upsert)\(\s*(\{[^}]*\}|[A-Za-z_$][\w$.]*)/gs;

describe("date_of_birth write authority", () => {
  it("no direct update or upsert names date_of_birth in app, lib or components", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("date_of_birth")) continue;
      for (const m of src.matchAll(WRITE)) {
        if (/date_of_birth/.test(m[0])) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the profile save is the one place that sends date_of_birth to an existing client, through the function", () => {
    const src = readFileSync("app/(app)/clients/[id]/actions.ts", "utf8");
    expect(src).toMatch(/\.rpc\(\s*"update_client_profile_if_unchanged"/);
  });

  it("the standalone birthday action stays removed", () => {
    expect(files.filter((f) => /birthday-actions\.tsx?$/.test(f))).toEqual([]);
    expect(files.filter((f) => /updateClientBirthdayAction/.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});
