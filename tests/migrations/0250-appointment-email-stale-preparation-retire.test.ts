import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0250_appointment_email_stale_preparation_retire.sql", "utf8");
const predecessor = readFileSync("supabase/migrations/0247_appointment_email_operation_authority.sql", "utf8");
const withoutComments = (text: string) => text.replace(/^\s*--.*$/gm, "");
const normalize = (text: string) => withoutComments(text).replace(/\s+/g, " ").trim();
const prepareOf = (text: string) => {
  const start = text.search(/create (or replace )?function public\.prepare_appointment_email_operation\(/);
  return text.slice(start, text.indexOf("$$;", text.indexOf("as $$", start)) + 3);
};
const fn = prepareOf(sql);
const prior = prepareOf(predecessor);
const code = withoutComments(sql);

describe("0250 retires a stale, expired, provably unattempted 0247 preparation", () => {
  // Not the repo maximum any more (carried below later migrations): the
  // "nothing above me" tripwire is served centrally (CLAUDE.md section 2).
  it("is exactly one allocated SQL file", () => {
    expect(countVersion("0250")).toBe(1);
    expect(fileForVersion("0250")).toBe("0250_appointment_email_stale_preparation_retire.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).toContain("set local lock_timeout = '5s'");
  });

  it("replaces ONLY prepare, keeping its exact signature, language and security path", () => {
    expect(code.match(/create or replace function/g)).toHaveLength(1);
    expect(code).not.toMatch(/create (table|index|trigger|schema|sequence)|alter table|drop /i);
    const head = (text: string) => normalize(text.slice(text.indexOf("public.prepare"), text.indexOf("as $$")));
    expect(head(fn)).toBe(head(prior));
  });

  it("differs from 0247 only by the retire block (no other behaviour moved)", () => {
    const retireBlock = /existing := found;[\s\S]*?existing := false;\s*end if;\s*if existing then/;
    expect(fn).toMatch(retireBlock);
    const stripped = normalize(fn.replace(retireBlock, "if found then"))
      .replace("create or replace function", "create function")
      .replace(" existing boolean;", "");
    expect(stripped).toBe(normalize(prior));
  });

  it("retires only an expired, unattempted, stale 'prepared' row", () => {
    const guard = normalize(fn.slice(fn.indexOf("if existing and"), fn.indexOf("existing := false;")));
    for (const term of [
      "o.state = 'prepared'",
      "o.lease_expires_at <= clock_timestamp()",
      "o.first_possible_attempt_at is null",
      "o.authorization_lease_token is null",
      "o.authority is distinct from p_expected_authority",
    ]) expect(guard).toContain(term);
    expect(guard).toContain("set state='retired' where id=o.id");
  });

  it("re-closes every role by name and grants only service_role", () => {
    const sig = "public.prepare_appointment_email_operation(uuid,uuid,text,text,jsonb)";
    expect(code).toContain(`revoke execute on function ${sig} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant execute on function ${sig} to service_role;`);
    expect(code.match(/\bgrant execute\b/g)).toHaveLength(1);
  });
});
