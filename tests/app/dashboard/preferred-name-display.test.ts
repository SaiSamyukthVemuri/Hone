import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-58 names slice (current schema): the dashboard's appointment list shows
// the preferred name through the shared display helper and reads it fail-soft,
// so it works before 0258. Source contract; the helper itself is covered by
// tests/lib/clients/identity.test.ts and the fail-soft read by the upcoming-list test.
const DASH = readFileSync("app/(app)/dashboard/page.tsx", "utf8");

describe("dashboard appointment names", () => {
  it("reads the preferred name through the fail-soft helper, in the one appointments select", () => {
    expect(DASH.match(/\.from\("appointments"\)/g) ?? []).toHaveLength(1);
    expect(DASH).toMatch(/readWithPreferredName\(\(includePreferred\) =>\s*supabase\s*\.from\("appointments"\)/);
  });
  it("never renders the raw stored name for an appointment's client", () => {
    expect(DASH).not.toMatch(/appt\.client\?\.name/);
    expect(DASH.match(/clientDisplayName\(appt\.client\)/g) ?? []).toHaveLength(3);
  });
});
