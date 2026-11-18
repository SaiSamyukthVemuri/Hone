import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { chainProblems, drift, parseFingerprint } from "../../scripts/db-baseline/verify.mjs";

const base = [
  "migrations:0001",
  "migrations:0002",
  "catalog:con|clients|c1|CHECK (((a IS NULL) OR (((length(a) >= 1) AND (length(a) <= 200)) AND (a = btrim(a)))))",
  "catalog:rel|clients|r",
  "grants:rel|clients|{postgres=arwdDxtm/postgres}|postgres",
  "grants:rel|studios|{postgres=arwdDxtm/postgres,authenticated=r/postgres}|postgres",
  "grants:fn|f(uuid)|{=X/postgres,anon=X/postgres}|postgres|",
  "extensions:btree_gist=1.7@public",
  "outside:trg|auth.users|on_auth_user_created|handle_new_user",
  "data:clients=0",
  "authusers:0",
].join("\n");
const fp = (extra: (s: string) => string = (s) => s) => parseFingerprint(extra(base));

describe("a restored database against the chain it stands in for", () => {
  it("an identical restore has no problems", () => {
    expect(chainProblems(fp(), fp())).toEqual([]);
  });

  it("a restored table with MORE grants than the chain is refused, and the extra grant is named", () => {
    // The failure that matters: pg_dump emits no GRANT for an ACL equal to the default, so the
    // target's default privileges would add anon access to an owner-only table.
    const restored = fp((s) => s.replace("grants:rel|clients|{postgres=arwdDxtm/postgres}|postgres", "grants:rel|clients|{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres}|postgres"));
    const problems = chainProblems(fp(), restored);
    expect(problems.some((p: string) => p.startsWith("EXTRA GRANT") && p.includes("anon=arwdDxtm/postgres"))).toBe(true);
  });

  it("a function that gained PUBLIC execute is an extra grant too", () => {
    const restored = fp((s) => s.replace("grants:fn|f(uuid)|{=X/postgres,anon=X/postgres}|postgres|", "grants:fn|f(uuid)||postgres|"));
    const problems = chainProblems(fp(), restored);
    expect(problems.some((p: string) => p.startsWith("EXTRA GRANT"))).toBe(true);
  });

  it("a grant the restore lost is reported as missing", () => {
    const restored = fp((s) => s.replace(",authenticated=r/postgres", ""));
    expect(chainProblems(fp(), restored).some((p: string) => p.startsWith("grant missing"))).toBe(true);
  });

  it("a CHECK constraint that only changed parenthesis after dump and restore is accepted", () => {
    const restored = fp((s) => s.replace("(((length(a) >= 1) AND (length(a) <= 200)) AND (a = btrim(a)))", "((length(a) >= 1) AND (length(a) <= 200) AND (a = btrim(a)))"));
    expect(chainProblems(fp(), restored)).toEqual([]);
  });

  it("a genuinely different constraint is refused", () => {
    const restored = fp((s) => s.replace("length(a) <= 200", "length(a) <= 100"));
    expect(chainProblems(fp(), restored).some((p: string) => p.startsWith("catalog:"))).toBe(true);
  });

  it.each([
    ["a missing extension", "extensions:btree_gist=1.7@public\n"],
    ["a missing trigger on auth.users", "outside:trg|auth.users|on_auth_user_created|handle_new_user\n"],
    ["a missing migration", "migrations:0002\n"],
    ["a different row count", "data:clients=0\n"],
  ])("%s is refused", (_label, line) => {
    const restored = parseFingerprint(base.replace(line.trim(), "").replace(/\n\n/g, "\n"));
    expect(chainProblems(fp(), restored).length).toBeGreaterThan(0);
  });

  it("drift from the sealed verification restore is reported", () => {
    const restored = fp((s) => s + "\ngrants:rel|extra|{anon=r/postgres}|postgres");
    expect(drift(fp(), restored).length).toBeGreaterThan(0);
    expect(drift(fp(), fp())).toEqual([]);
  });

  it("an unrecognised fingerprint line is an error, never skipped", () => {
    expect(() => parseFingerprint("mystery:1")).toThrow(/unrecognised/);
  });
});
