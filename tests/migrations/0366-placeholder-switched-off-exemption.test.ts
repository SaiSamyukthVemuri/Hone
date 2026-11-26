import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The placeholder is NEVER "switched off". The DB case proves the behaviour; this pins the POLARITY of the exemption in the source, because the
// census only sees that the token is present (an inverted `coalesce(...)` would exempt every REAL unit and refuse the placeholder, and still contain it).
const SQL = readFileSync("supabase/migrations/0366_machine_switches.sql", "utf8");

describe("0366 switched-off refusal: the exemption is for the placeholder only", () => {
  const start = SQL.indexOf("-- THE PLACEHOLDER IS NEVER \"SWITCHED OFF\"");
  const end = SQL.indexOf("raise exception 'That machine is switched off for this studio.'", start);
  const guard = SQL.slice(start, end);

  it("the refusal condition begins with the NEGATED placeholder lookup on the unit being bound", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(guard).toMatch(
      /if v_new_identity\s+and not coalesce\(\(select pm\.is_unspecified from public\.studio_machines pm where pm\.id = p_studio_machine_id\), false\)/,
    );
  });
  it("the lookup defaults to FALSE (no unit, or an unknown one, is a real binding and stays refused) and is not negated twice", () => {
    expect(guard).toContain("), false)");
    expect(guard).not.toMatch(/not\s+not\s+coalesce/);
    expect((guard.match(/pm\.is_unspecified/g) ?? []).length).toBe(1);
  });
});
