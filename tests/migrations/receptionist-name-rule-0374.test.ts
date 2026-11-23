import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0374: the database no longer returns a client's stored name to a receptionist. SOURCE contract for the migration and its
// down file. Behaviour is the authority and is proved by tests/db/receptionist-name-rule.db.test.ts on a real database;
// this file pins the things a database run cannot see in a diff: which text changed, the guards in the file, the grants.

const UP = readFileSync("supabase/migrations/0374_receptionist_name_rule.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0374_receptionist_name_rule.down.sql", "utf8");
const S0274 = readFileSync("supabase/migrations/0274_receptionist_desk_projection.sql", "utf8");
const S0266 = readFileSync("supabase/migrations/0266_legal_name_receptionist_access.sql", "utf8");

const HOSTED_MD5: Record<string, string> = {
  receptionist_client_directory: "d2cb9ea68f5696213cc8bf98b4cd58a4",
  receptionist_calendar_v2: "e826a57397d3609874b6687cf659fc0d",
  receptionist_client_contacts_v2: "116bad9455089d32ec7ee14310ed5a7b",
};
const SIG: Record<string, string> = {
  receptionist_client_directory: "uuid, text, text[], text, integer, integer",
  receptionist_calendar_v2: "uuid, timestamptz, timestamptz",
  receptionist_client_contacts_v2: "uuid, text, integer",
};
const NAMES = Object.keys(HOSTED_MD5);

function fnText(src: string, name: string, kw: "create" | "create or replace"): string {
  const a = src.indexOf(`${kw} function public.${name}(`);
  expect(a, `${name} defined`).toBeGreaterThan(-1);
  const b = src.indexOf("$$;", src.indexOf("as $$", a)) + 3;
  return src.slice(a, b);
}
const body = (f: string) => f.slice(f.indexOf("as $$") + 5, f.lastIndexOf("$$;"));
const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, "");
const OLD: Record<string, string> = {
  receptionist_client_directory: fnText(S0274, "receptionist_client_directory", "create"),
  receptionist_calendar_v2: fnText(S0274, "receptionist_calendar_v2", "create"),
  receptionist_client_contacts_v2: fnText(S0266, "receptionist_client_contacts_v2", "create"),
};
const NEW: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n, fnText(UP, n, "create or replace")]));

describe("0374 is the current maximum and is shaped like a sealed migration", () => {
  it("is the repository maximum", () => {
    expect(isRepoMax("0374")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const begin = UP.search(/^begin;/m);
    const lock = UP.search(/^set local lock_timeout = '5s';/m);
    const commit = UP.search(/^commit;\s*$/m);
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
    expect(UP.indexOf("create or replace function")).toBeGreaterThan(lock);
    expect(DOWN.search(/^begin;/m)).toBeGreaterThan(-1);
    expect(DOWN.search(/^set local lock_timeout = '5s';/m)).toBeGreaterThan(DOWN.search(/^begin;/m));
    expect(DOWN.search(/^commit;\s*$/m)).toBeGreaterThan(DOWN.search(/^set local lock_timeout/m));
  });

  it("refuses to run unless each of the three bodies is exactly the hosted one (md5 of the source), and says so in the file", () => {
    const pre = UP.slice(UP.indexOf("$guard$"), UP.indexOf("create or replace function"));
    for (const [n, md5] of Object.entries(HOSTED_MD5)) expect(pre, n).toContain(`('${n}', '${md5}')`);
    expect(pre).toMatch(/md5\(p\.prosrc\) = r\.expected_md5/);
    expect(pre).toMatch(/p\.prosecdef/);
    expect(pre).toMatch(/search_path=pg_catalog, pg_temp/);
    // And the repository bodies it replaces really are those bodies (the migration was reviewed against them).
    for (const n of NAMES) expect(createMd5(body(OLD[n])), n).toBe(HOSTED_MD5[n]);
  });
});

function createMd5(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

describe("what changed in the three bodies, and nothing else", () => {
  it("each new body differs from the one it replaces only in the display, search and order expressions", () => {
    const changed = (a: string, b: string) => {
      const x = a.split("\n"), y = b.split("\n");
      const out: string[] = [];
      let i = 0, j = 0;
      while (i < x.length || j < y.length) {
        if (x[i] === y[j]) { i++; j++; continue; }
        // advance the shorter side to the next common line
        const nextY = y.indexOf(x[i], j);
        const nextX = x.indexOf(y[j], i);
        if (nextY !== -1 && (nextX === -1 || nextY - j <= nextX - i)) { while (j < nextY) out.push("+" + y[j++]); }
        else if (nextX !== -1) { while (i < nextX) out.push("-" + x[i++]); }
        else { if (i < x.length) out.push("-" + x[i++]); if (j < y.length) out.push("+" + y[j++]); }
      }
      return out.map((l) => l[0] + l.slice(1).trim().replace(/\s+/g, " "));
    };
    const strip = (f: string) => f.replace(/^create (or replace )?function/, "create function");
    expect(changed(strip(OLD.receptionist_client_directory), strip(NEW.receptionist_client_directory))).toEqual([
      "-coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name) as dname,",
      "+coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file') as dname,",
      "+nullif(pg_catalog.btrim(c.preferred_name), '') as pname,",
      "-or b.dname ilike v_pattern",
      "+or b.pname ilike v_pattern",
      "+fl.on_file,",
    ]);
    expect(changed(strip(OLD.receptionist_calendar_v2), strip(NEW.receptionist_calendar_v2))).toEqual([
      "-coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name),",
      "+coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file'),",
    ]);
    expect(changed(strip(OLD.receptionist_client_contacts_v2), strip(NEW.receptionist_client_contacts_v2))).toEqual([
      "-coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name) as display_name,",
      "+coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file') as display_name,",
      "+nullif(pg_catalog.btrim(c.preferred_name), '') as pname,",
      "-or d.display_name ilike v_pattern",
      "+or d.pname ilike v_pattern",
      "-order by d.display_name, d.id",
      "+order by d.name_on_file, d.display_name, d.id",
    ]);
  });

  it("the guards, the intake and consent facts and the escaping are byte for byte the old text", () => {
    const slice = (t: string, a: string, b: string) => t.slice(t.indexOf(a), t.indexOf(b));
    for (const n of NAMES) {
      const o = body(OLD[n]), w = body(NEW[n]);
      expect(w.slice(0, w.indexOf("return query")), `${n} guards`).toBe(o.slice(0, o.indexOf("return query")));
    }
    const o = body(OLD.receptionist_client_directory), w = body(NEW.receptionist_client_directory);
    expect(slice(w, "    facts as (", "    shaped as ("), "intake status and consent facts").toBe(slice(o, "    facts as (", "    shaped as ("));
    expect(slice(w, "    shaped as (", "    filtered as ("), "shaped").toBe(slice(o, "    shaped as (", "    filtered as ("));
    expect(slice(w, "    filtered as (", "    select fl.id"), "filters").toBe(slice(o, "    filtered as (", "    select fl.id"));
    // The three escape replacements for backslash, percent and underscore are unchanged in all three.
    for (const n of ["receptionist_client_directory", "receptionist_client_contacts_v2"]) {
      expect(body(NEW[n])).toContain("replace(replace(replace(");
    }
  });
});

describe("the stored name is referenced by none of the three bodies (resolved from the FROM clause, not by spelling)", () => {
  it("no alias of public.clients is ever followed by .name or .*, and clients is never named bare", () => {
    for (const n of NAMES) {
      const code = stripSqlComments(body(NEW[n]));
      const aliases = [...code.matchAll(/\b(?:from|join)\s+public\.clients\b(?:\s+as)?\s+([a-z_][a-z0-9_]*)\b/gi)]
        .map((m) => m[1])
        .filter((a) => !/^(on|where|left|right|inner|join|using|group|order|limit|union|cross)$/i.test(a));
      expect(aliases.length, `${n}: the clients alias is found, so this check is not vacuous`).toBeGreaterThan(0);
      for (const a of aliases) {
        expect(new RegExp(`\\b${a}\\.name\\b`, "i").test(code), `${n}: ${a}.name`).toBe(false);
        expect(new RegExp(`\\b${a}\\.\\*`).test(code), `${n}: ${a}.*`).toBe(false);
      }
      expect(/\bclients\.(name|\*)/i.test(code), `${n}: clients.name`).toBe(false);
      expect(/row_to_json|to_jsonb|json_build_object|\bc\b\s*(?:,|\))/i.test(code.replace(/\bc\.[a-z_]+/gi, "")), `${n}: a whole-row reference to clients`).toBe(false);
    }
  });

  it("no RAISE in the three bodies can carry a value: fixed words and an error code only", () => {
    for (const n of NAMES) {
      const code = stripSqlComments(body(NEW[n]));
      const raises = [...code.matchAll(/raise\s+exception\s+([^;]*);/gi)].map((m) => m[1]);
      expect(raises.length, n).toBeGreaterThan(0);
      for (const r of raises) {
        expect(/^'[a-z_ ]+'\s+using\s+errcode\s*=\s*'[0-9a-z]+'$/i.test(r.trim()), `${n}: ${r.trim()}`).toBe(true);
      }
    }
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

  it("the after-check verifies the grants, the absence of the stored-name column and the md5 of each new body", () => {
    const chk = UP.slice(UP.indexOf("$check$"));
    for (const must of ["has_function_privilege('authenticated'", "has_function_privilege('anon'", "has_function_privilege('service_role'", "aclexplode", "a.grantee = 0", "mc\\.name\\M", "new_md5"]) expect(chk, must).toContain(must);
    for (const n of NAMES) expect(chk, n).toContain(`('${n}', 'public.${n}(${SIG[n]})', '`);
  });

  it("the after-check's recorded md5 equals the md5 of the body in this file", () => {
    for (const n of NAMES) {
      const m = UP.match(new RegExp(`\\('${n}', 'public\\.${n}\\([^)]*\\)', '([0-9a-f]{32})'\\)`));
      expect(m, n).not.toBeNull();
      expect(m![1], n).toBe(createMd5(body(NEW[n])));
    }
  });
});

describe("the down file", () => {
  it("is labelled an emergency measure, restores the exact previous bodies and asserts the hosted md5s afterwards", () => {
    expect(DOWN).toMatch(/EMERGENCY ONLY/);
    expect(DOWN).toMatch(/RE-OPENS the leak/);
    for (const n of NAMES) {
      expect(body(fnText(DOWN, n, "create or replace")), n).toBe(body(OLD[n]));
      expect(DOWN, n).toContain(`('${n}', '${HOSTED_MD5[n]}')`);
    }
  });
});
