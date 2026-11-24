import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0380: a receptionist sees the preferred name, else the regular client name, else the words 'Name on file' only when both are
// blank. SOURCE contract for the migration and its down file. Behaviour is the authority and is proved by
// tests/db/receptionist-name-rule.db.test.ts on a real database; this file pins what a database run cannot see in a diff:
// which text changed against the 0374 bodies, that the legal identity is never named, and the grants and the after-check.

const UP = readFileSync("supabase/migrations/0380_receptionist_name_rule.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0380_receptionist_name_rule.down.sql", "utf8");
const S0374 = readFileSync("supabase/migrations/0374_receptionist_name_rule.sql", "utf8");

const OLD_MD5: Record<string, string> = {
  receptionist_client_directory: "602bca224cc6ce50cab70c5692ea0902",
  receptionist_calendar_v2: "911df019f695523168b39fd6e43afbc7",
  receptionist_client_contacts_v2: "b157fca004345dddd4ad15586d92dc1d",
};
const SIG: Record<string, string> = {
  receptionist_client_directory: "uuid, text, text[], text, integer, integer",
  receptionist_calendar_v2: "uuid, timestamptz, timestamptz",
  receptionist_client_contacts_v2: "uuid, text, integer",
};
const NAMES = Object.keys(OLD_MD5);

function fnText(src: string, name: string): string {
  const a = src.indexOf(`create or replace function public.${name}(`);
  expect(a, `${name} defined`).toBeGreaterThan(-1);
  const b = src.indexOf("$$;", src.indexOf("as $$", a)) + 3;
  return src.slice(a, b);
}
const body = (f: string) => f.slice(f.indexOf("as $$") + 5, f.lastIndexOf("$$;"));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, "");
const NEW: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, fnText(UP, n)]));
const OLD: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, fnText(S0374, n)]));
const SHOWN = "coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), nullif(pg_catalog.btrim(c.name), ''))";

describe("0380 is shaped like a sealed migration", () => {
  it("is the current maximum migration", () => {
    expect(isRepoMax("0380")).toBe(true);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(UP).toMatch(/^begin;$/m);
    expect(UP).toMatch(/^commit;$/m);
    expect(UP.indexOf("begin;")).toBeLessThan(UP.indexOf("set local lock_timeout"));
    expect(UP.indexOf("set local lock_timeout")).toBeLessThan(UP.indexOf("create or replace function"));
    expect(DOWN).toMatch(/^begin;$/m);
    expect(DOWN).toMatch(/^commit;$/m);
  });
  it("refuses to run unless each body is exactly the 0374 one (md5 of the source), and the recorded md5s are the 0374 bodies", () => {
    const pre = UP.slice(UP.indexOf("-- 0) Preamble"), UP.indexOf("create or replace function"));
    for (const n of NAMES) {
      expect(pre, n).toContain(`'${OLD_MD5[n]}'`);
      expect(md5(body(OLD[n])), `${n}: 0374's body hashes to the recorded md5`).toBe(OLD_MD5[n]);
    }
    expect(pre).toMatch(/refuses to run/);
  });
});

describe("the displayed name rule, in each of the three bodies", () => {
  it("displays preferred, else regular, else the words; name_on_file is true only when both are blank", () => {
    for (const n of NAMES) {
      const code = stripSqlComments(body(NEW[n]));
      expect(code, n).toContain(SHOWN);
      expect(code, n).toContain("'Name on file'");
      expect(code, n).toMatch(/is null\b/);
    }
  });
  it("search and order use the displayed name, never the fixed words, and never the regular name directly", () => {
    for (const n of ["receptionist_client_directory", "receptionist_client_contacts_v2"]) {
      const code = stripSqlComments(body(NEW[n]));
      expect(code, n).toMatch(/\b[a-z]\.shown\s+ilike\s+v_pattern/);
      expect(/shown[^;]*Name on file[^;]*ilike|ilike[^;]*Name on file/i.test(code), `${n}: the fixed words are matchable`).toBe(false);
      expect(/\bc\.name\b/.test(code.split(SHOWN.slice(0, -1) + ", 'Name on file')").join("").split(SHOWN).join("")), `${n}: c.name outside the displayed-name expression`).toBe(false);
    }
  });
  it("only the display, search and order expressions differ from the 0374 bodies; guards and caps are byte for byte the old text", () => {
    for (const n of NAMES) {
      const a = body(OLD[n]).split("\n");
      const b = body(NEW[n]).split("\n");
      const keep = (l: string) => /auth\.uid|receptionist_actor_id|42501|22023|invalid_|least\(|greatest\(|escape|security definer|search_path/i.test(l);
      for (const l of a.filter(keep)) expect(b, `${n}: ${l.trim()}`).toContain(l);
    }
  });
});

describe("the intake and consent facts of the directory are 0374's, byte for byte", () => {
  it("the facts CTE (appointments, newest intake status, current treatment consent) and the shaped CTE up to the filtered CTE are unchanged", () => {
    const cut = (s: string) => s.slice(s.indexOf("    facts as ("), s.indexOf("    filtered as ("));
    const o = cut(body(OLD.receptionist_client_directory));
    const n = cut(body(NEW.receptionist_client_directory));
    expect(o.length).toBeGreaterThan(1500);
    expect(n).toBe(o);
  });
  it("the directory body hash recorded for review is this file's body", () => {
    expect(createHash("sha256").update(body(NEW.receptionist_client_directory)).digest("hex")).toBe("d1258e9d819de7c9152bd339b9f7ce808e1ff0ea2cbac2f1664291c7a083e42b");
    expect(createHash("sha256").update(body(OLD.receptionist_client_directory)).digest("hex")).toBe("21d94010d93741ad0c0722c892177de66b08907348621e5ccc27ce9d11aef848");
  });
});

describe("the legal identity is never referenced", () => {
  it("no body names the legal identity table, a legal column or the legal-name switch (comments excluded)", () => {
    for (const n of NAMES) {
      const code = stripSqlComments(body(NEW[n]));
      expect(/legal_|client_legal|studio_legal_name_access/i.test(code), n).toBe(false);
    }
  });
  it("no body joins any table that holds a legal identity", () => {
    for (const n of NAMES) {
      const code = stripSqlComments(body(NEW[n]));
      for (const m of code.matchAll(/\b(?:from|join)\s+(public\.[a-z_]+)/gi)) {
        expect(m[1], `${n}: ${m[0]}`).not.toMatch(/legal/i);
      }
    }
  });
  it("the after-check refuses a body that mentions the legal identity", () => {
    const chk = UP.slice(UP.indexOf("-- 1) After-check"));
    expect(chk).toMatch(/legal_identit/);
    expect(chk).toMatch(/legal_name/);
  });
});

describe("grants and the after-check", () => {
  it("re-states the grants by name for every function: authenticated only, PUBLIC, anon and service_role revoked by name", () => {
    for (const n of NAMES) {
      for (const role of ["public", "anon", "service_role"]) {
        expect(UP, `${n} revoke ${role}`).toContain(`revoke execute on function public.${n}(${SIG[n]}) from ${role};`);
      }
      expect(UP, `${n} grant`).toContain(`grant execute on function public.${n}(${SIG[n]}) to authenticated;`);
      expect(UP, `${n} grant to others`).not.toMatch(new RegExp(`grant[^;]*public\\.${n}[^;]*to\\s+(anon|service_role|public)`, "i"));
    }
  });
  it("the after-check verifies the grants and the md5 of each new body, and the recorded md5 equals the body in this file", () => {
    const chk = UP.slice(UP.indexOf("-- 1) After-check"));
    for (const must of ["has_function_privilege('authenticated'", "has_function_privilege('anon'", "has_function_privilege('service_role'", "new_md5"]) expect(chk, must).toContain(must);
    for (const n of NAMES) {
      const m = UP.match(new RegExp(`\\('${n}', 'public\\.${n}\\([^)]*\\)', '([0-9a-f]{32})'\\)`));
      expect(m, n).not.toBeNull();
      expect(m![1], n).toBe(md5(body(NEW[n])));
    }
  });
});

describe("the down file", () => {
  it("is labelled an emergency measure, restores the exact 0374 bodies and asserts their md5s", () => {
    expect(DOWN).toMatch(/EMERGENCY ONLY/);
    for (const n of NAMES) {
      expect(body(fnText(DOWN, n)), n).toBe(body(OLD[n]));
      expect(DOWN, n).toContain(`'${OLD_MD5[n]}'`);
    }
  });
});
