import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// SPELLING-BASED TRIPWIRE, NOT PROOF. It reads source text for an update/upsert call that names date_of_birth.
// Blind spot: a payload built through a property access or a call result (for example .update(plan.patch) or
// .update(build())) is not seen; neither is a patch passed by variable. Brackets are matched, so nested objects ARE seen. The database function's own tests, not this file, prove the atomic behaviour.
//
// HON-58: an existing client's date_of_birth is changed only through update_client_profile_if_unchanged (0281), which
// compares the value the caller loaded with the stored one in the same statement. A direct UPDATE or upsert that names
// date_of_birth is a blind overwrite. New-client inserts and the intake sync RPC are different writes and are not matched.
//
// The standalone birthday action was removed in this slice: it had no caller, an exported server action is still reachable
// by a direct POST, and it read the current value itself and passed it as "expected", which made the compare vacuous.

const files = execFileSync("git", ["ls-files", "app", "lib", "components"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f));

/** The text of every .update( / .upsert( call's argument list, found by matching brackets so nested objects stay inside. */
export function writeCallArgs(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.(update|upsert)\(/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(src.slice(start, i));
  }
  return out;
}

describe("date_of_birth write authority (spelling-based tripwire, not proof)", () => {
  it("tripwire: no direct update or upsert call spells date_of_birth in app, lib or components", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("date_of_birth")) continue;
      for (const args of writeCallArgs(src)) {
        if (/date_of_birth/.test(args)) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the scanner sees a nested object, a multi-line call and an upsert, and ignores unrelated writes", () => {
    expect(writeCallArgs("x.update({ a: { x: 1 }, date_of_birth: v })").some((a) => /date_of_birth/.test(a))).toBe(true);
    expect(writeCallArgs("x.update(\n {\n a: [1, { b: 2 }],\n date_of_birth: v })").some((a) => /date_of_birth/.test(a))).toBe(true);
    expect(writeCallArgs("x.upsert({ date_of_birth: v }, { onConflict: 'id' })").some((a) => /date_of_birth/.test(a))).toBe(true);
    expect(writeCallArgs("x.update({ a: { x: 1 } }).eq('date_of_birth', 1)").some((a) => /date_of_birth/.test(a))).toBe(false);
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
