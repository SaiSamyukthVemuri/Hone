import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source pins for the machine-native readings export (treatment_setup_readings.csv). They read the action's source because the rules they guard are about
// HOW the rows are read: a numeric read through the JSON number path loses digits before any padding code can run.
const source = readFileSync(path.join(process.cwd(), "app/(app)/settings/data/actions.ts"), "utf8");
const readingsRead = source.slice(source.indexOf('fetchExportRows("treatment_setup_readings"'), source.indexOf('fetchExportRows("service_practitioners"'));

describe("treatment_setup_readings export source pins", () => {
  it("reads value_numeric as text, so a recorded value reaches the writer as the digits the database holds", () => {
    expect(readingsRead.length).toBeGreaterThan(100);
    expect(readingsRead).toContain("value_numeric::text");
    // The bare column (a JSON number: 9007199254740993 becomes 9007199254740992) must not be selected next to it.
    expect(readingsRead.replace(/value_numeric::text/g, "")).not.toMatch(/\bvalue_numeric\b/);
  });

  it("pads through padDecimalText and never converts the value to a JavaScript number", () => {
    expect(source).toContain("padDecimalText(r.value_numeric");
    expect(source).not.toMatch(/Number\(\s*r\.value_numeric/);
    expect(source).not.toMatch(/parseFloat\(\s*r\.value_numeric/);
  });

  it("blanks studio_machine_id for the unspecified-machine placeholder, reading it studio-scoped and failing closed", () => {
    expect(source).toMatch(/from\("studio_machines"\)\.select\("id"\)\.eq\("studio_id", studio\.id\)\.eq\("is_unspecified", true\)/);
    expect(source).toMatch(/unspecifiedMachineIds\.has\(r\.studio_machine_id as string\) \? null : r\.studio_machine_id/);
    expect(source).toMatch(/unspecifiedMachines\.error\s*\?/);
  });
});
