import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Source pins for the multi-studio-user robustness guards (middleware +
// /no-access page + the shared resolver). Behavior is exercised by
// practitioner-membership.test.ts; these lock the guard shape.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const MW = read("lib/supabase/middleware.ts");
const NOACCESS = read("app/(auth)/no-access/page.tsx");
const QUERIES = read("lib/supabase/queries.ts");

describe("middleware invite gate handles 0/1/2+ without maybeSingle", () => {
  it("counts active memberships instead of .maybeSingle()", () => {
    // the membership existence query in middleware no longer ends in maybeSingle
    expect(MW).toMatch(/const activeCount = memberships\?\.length \?\? 0;/);
    const idx = MW.indexOf("const { data: memberships }");
    expect(MW.slice(idx, idx + 260)).not.toMatch(/maybeSingle/);
  });
  it("exactly 1 proceeds; 0 or 2+ redirect to /no-access; 2+ carries the reason", () => {
    expect(MW).toMatch(/if \(activeCount !== 1\)/);
    expect(MW).toMatch(/set\("reason", "multiple-studios"\)/);
  });
});

describe("no-access page: explicit count + clear multi-studio copy", () => {
  it("sends exactly-one to /dashboard and derives 'multiple' from count > 1", () => {
    expect(NOACCESS).toMatch(/activeCount === 1/);
    expect(NOACCESS).toMatch(/const multiple = activeCount > 1;/);
    const idx = NOACCESS.indexOf("const { data: memberships }");
    expect(NOACCESS.slice(idx, idx + 260)).not.toMatch(/maybeSingle/);
  });
  it("shows a clear, non-error Multiple studios detected state", () => {
    expect(NOACCESS).toMatch(/Multiple studios detected/);
    expect(NOACCESS).toMatch(/Switching between studios isn't available yet/);
  });
});

describe("shared resolver: no maybeSingle, scoping unchanged", () => {
  it("resolveActivePractitionerMembership filters user_id + active and does not maybeSingle", () => {
    const idx = QUERIES.indexOf(
      "async function resolveActivePractitionerMembership",
    );
    expect(idx).toBeGreaterThan(-1);
    const body = QUERIES.slice(idx, idx + 700);
    expect(body).toMatch(/\.eq\("user_id", userId\)/);
    expect(body).toMatch(/\.eq\("active", true\)/);
    expect(body).not.toMatch(/maybeSingle/);
  });
  it("both public resolvers route through the shared resolver", () => {
    expect(QUERIES).toMatch(
      /getCurrentPractitionerWithStudio[\s\S]{0,400}resolveActivePractitionerMembership/,
    );
    expect(QUERIES).toMatch(
      /requirePractitionerWithStudio[\s\S]{0,400}resolveActivePractitionerMembership/,
    );
    // require redirects (never throws) for none + multiple
    expect(QUERIES).toMatch(/redirect\("\/no-access"\)/);
    expect(QUERIES).toMatch(/redirect\("\/no-access\?reason=multiple-studios"\)/);
  });
});
