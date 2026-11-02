import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0274 receptionist desk projection: source contract. Behaviour is proved in
// tests/db/receptionist-desk-projection.db.test.ts (CI only). No repo-max pin (CLAUDE.md section 2).
const FILE = "supabase/migrations/0274_receptionist_desk_projection.sql";
const sql = readFileSync(FILE, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "").replace(/comment on [^;]*;/gi, "");
const fn = (name: string) => {
  const m = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  expect(m, name).not.toBeNull();
  return m![0];
};
const DIR = fn("receptionist_client_directory");
const CAL = fn("receptionist_calendar_v2");
const TZ = fn("receptionist_studio_timezone");
const returns = (body: string) =>
  body.match(/returns table \(([\s\S]*?)\)\s*language/)![1].split(",").map((c) => c.trim().split(/\s+/)[0]).filter(Boolean);

describe("0274: shape", () => {
  it("owns one filename, opens its own transaction with lock_timeout inside, and writes no data", () => {
    expect(countVersion("0274")).toBe(1);
    expect(fileForVersion("0274")).toBe("0274_receptionist_desk_projection.sql");
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate|alter\s+table|create\s+table|create\s+policy)\b/i);
  });
  it("fails closed, before anything else, if 0258, 0266 or 0216 is missing", () => {
    const pre = code.slice(0, code.indexOf("create function"));
    expect(pre).toContain("column_name = 'preferred_name'");
    expect(pre).toContain("to_regprocedure('public.receptionist_client_contacts_v2(uuid, text, integer)') is null");
    expect(pre).toContain("to_regprocedure('public.receptionist_actor_id(uuid)') is null");
    expect(pre.match(/raise exception/g)?.length).toBe(3);
  });
});

describe("0274: both functions", () => {
  for (const [name, body] of [["receptionist_client_directory", DIR], ["receptionist_calendar_v2", CAL]] as const) {
    it(`${name}: definer, pinned search_path, stable, actor checked before any client read`, () => {
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path = pg_catalog, pg_temp\n/);
      expect(body).toMatch(/\bstable\b/);
      const actor = body.indexOf("receptionist_actor_id(p_studio_id) is null");
      expect(actor).toBeGreaterThan(-1);
      expect(actor).toBeLessThan(body.indexOf("public.clients"));
      expect(body).toContain("using errcode = '42501'");
      expect(body).toMatch(/auth\.uid\(\) is null/);
    });
    it(`${name}: reads no clinical, legal, session or image source`, () => {
      expect(body).not.toMatch(/\bsessions\b|client_legal_identities|legal_|client_intake_answers|treatment_images|client_images|select \*|\baddress\b|date_of_birth|\bnotes?\b|price|payment|clinical/i);
    });
  }
  it("revokes by name from all four roles and grants authenticated only", () => {
    for (const sig of [
      "receptionist_client_directory(uuid, text, text[], text, integer, integer)",
      "receptionist_calendar_v2(uuid, timestamptz, timestamptz)",
      "receptionist_studio_timezone(uuid)",
    ]) {
      for (const role of ["public", "anon", "service_role"]) expect(code).toContain(`revoke execute on function public.${sig} from ${role};`);
      expect(code).toContain(`revoke all on function public.${sig}\n  from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function public.${sig} to authenticated;`);
      expect(code).not.toMatch(new RegExp(`grant execute on function public\\.${sig.replace(/[()]/g, "\\$&")} to (anon|service_role|public)`));
    }
  });
});

describe("0274: directory", () => {
  it("returns exactly the allow-listed columns", () => {
    expect(returns(DIR)).toEqual([
      "client_id", "display_name", "name_on_file", "phone", "email",
      "next_appointment_at", "last_visit_on", "intake_state", "consent_signed", "total_count",
    ]);
  });
  it("R2: query >= 2 chars, a query for every page after the first, offset + limit capped at 200, closed sort and filter sets", () => {
    expect(DIR).toContain("char_length(v_query) < 2");
    expect(DIR).toMatch(/elsif v_offset > 0 then\s+raise exception 'query_required'/);
    expect(DIR).toContain("v_offset + v_limit > 200");
    expect(DIR).toContain("v_sort not in ('name', 'next')");
    expect(DIR).toContain("f not in ('intake_review', 'no_upcoming')");
    expect(DIR).toMatch(/least\(greatest\(coalesce\(p_limit, 25\), 1\), 50\)/);
  });
  it("search matches only the display identity, email and phone, escaping LIKE metacharacters; archived clients excluded; studio bound", () => {
    expect(DIR).toContain("replace(replace(replace(v_query, '\\', '\\\\'), '%', '\\%'), '_', '\\_')");
    expect(DIR).toMatch(/b\.dname\s+ilike v_pattern\s+or b\.cemail ilike v_pattern\s+or b\.cphone ilike v_pattern/);
    expect(DIR).not.toMatch(/c\.name\s+ilike/);
    expect(DIR).toContain("c.archived_at is null");
    expect(DIR).toContain("c.studio_id = p_studio_id");
  });
  it("R7: intake is a closed enum from the newest non-deleted form's STATUS; consent is a boolean for treatment_consent only", () => {
    expect(DIR).toMatch(/when 'submitted' then 'awaiting_review'[\s\S]*when 'reviewed'\s+then 'reviewed'[\s\S]*else 'not_submitted'/);
    expect(DIR).toContain("f.deleted_at is null");
    expect(DIR).toContain("t.form_type = 'treatment_consent'");
    expect(DIR).not.toMatch(/signature_name|template_body|template_title|signed_at\s+as|submitted_at/);
  });
  it("D1-D3: consent needs a LIVE ACTIVE template and the newest signature on its CURRENT version; the term length has two distinct refusals", () => {
    expect(DIR).toContain("t.is_live and t.status = 'active'");
    expect(DIR).toContain("sg.template_version = t.version");
    expect(DIR).toContain("order by sg.signed_at desc, sg.id desc");
    expect(DIR).toContain("raise exception 'query_too_long'");
    expect(DIR).toContain("raise exception 'query_too_short'");
    expect(DIR).toContain("pg_catalog.pg_timezone_names");
  });
  it("L7 (Insurance): the function never reads the sessions table (comments and string literals removed)", () => {
    const code = `${DIR}\n${CAL}`.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\bsessions\b|\bsession_blocks\b|\btreatment_sessions\b/);
  });
  it("last visit is the completed-appointments source only, as a date; next is confirmed and in the future", () => {
    expect(DIR).toContain("a.status = 'completed'");
    expect(DIR).toContain("a.starts_at <= pg_catalog.now()");
    expect(DIR).toContain("(f.lastv at time zone v_tz)::date");
    expect(DIR).not.toContain("at time zone 'UTC'");
    expect(DIR).toContain("a.status = 'confirmed'");
    expect(DIR).toContain("a.starts_at > pg_catalog.now()");
  });
});

describe("0274: studio clock (Privacy C1, Sam decision 4)", () => {
  it("receptionist_studio_timezone: definer, pinned search_path, actor checked first, one validated string, no other studios column", () => {
    expect(TZ).toMatch(/security definer/);
    expect(TZ).toMatch(/set search_path = pg_catalog, pg_temp\n/);
    expect(TZ).toMatch(/returns text/);
    expect(TZ.indexOf("receptionist_actor_id(p_studio_id) is null")).toBeLessThan(TZ.indexOf("public.studios"));
    expect(TZ).toContain("pg_catalog.pg_timezone_names");
    expect(TZ).toContain("'UTC'");
    expect(TZ).toContain("where s.id = p_studio_id");
    expect(TZ).not.toMatch(/\bs\.(?!timezone\b|id\b)[a-z_]+/);
  });
  it("calendar_v2 reads studios only for the timezone, for p_studio_id, with a UTC fallback; duration comes from the appointment", () => {
    expect(CAL).toContain("where s.id = p_studio_id");
    expect(CAL).toContain("a.duration_minutes");
    expect(CAL).not.toMatch(/\bs\.(?!timezone\b|id\b)[a-z_]+/);
  });
});

describe("0274: schedule v2 and the v1 closure (R1, R8)", () => {
  it("carries display_name and name_on_file and no stored-name column", () => {
    expect(returns(CAL)).toEqual([
      "appointment_id", "starts_at", "ends_at", "status", "practitioner_id", "practitioner_display_name",
      "practitioner_color", "service_id", "service_name", "client_id", "display_name", "name_on_file",
      "duration_minutes", "studio_timezone",
    ]);
    expect(CAL).toContain("coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name)");
    expect(CAL).not.toMatch(/,\s*c\.name\s*(,|\n\s*from)/);
  });
  it("closes v1 for every role, by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from ${role};`);
    }
    expect(code).not.toMatch(/grant execute on function public\.receptionist_calendar\(uuid/);
    expect(code).not.toMatch(/create or replace function public\.receptionist_calendar\(/);
  });
});
