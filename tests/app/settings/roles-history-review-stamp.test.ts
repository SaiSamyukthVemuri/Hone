import { describe, expect, it } from "vitest";
import { parseHistory } from "@/lib/settings/roles/core-parse";

// Codex P2 4585180160 (#1501): a reviewed save adds `_review` ({version, hash}) to the audit row's `after` map, and History rendered it as a
// permission change ("_review: unset to unset"). It is metadata and must never appear as a change.

const row = (after: unknown, before: unknown = {}) => ({ id: 1, at: "t", kind: "role_permissions_saved", role: "practitioner", before, after });
const parse = (r: ReturnType<typeof row>) => {
  const out = parseHistory({ ok: true, rows: [r] }, 50);
  if (!out.ok) throw new Error("expected ok");
  return out.rows[0];
};
const K = "View clinical records";

describe("the reviewed-save stamp is not a permission change", () => {
  it("a reviewed save row shows only the real permission change", () => {
    const r = parse(row(
      { "clin.view_records": { stored: "off", effective: "off" }, _review: { version: 3, hash: "abc" } },
      { "clin.view_records": { stored: "studio", effective: "studio" } },
    ));
    expect(Object.keys(r.after)).toEqual([K]);
    expect(Object.keys(r.before)).toEqual([K]);
    expect(JSON.stringify(r)).not.toMatch(/_review/);
  });
  it("control: without the stamp the same row is unchanged (the real change still shows)", () => {
    const r = parse(row({ "clin.view_records": { stored: "off", effective: "off" } }, { "clin.view_records": { stored: "studio", effective: "studio" } }));
    expect(r.after).toEqual({ [K]: "Off" });
  });
  it("a row with only the stamp has no changes at all", () => {
    const r = parse(row({ _review: { version: 1, hash: "x" } }));
    expect(r.before).toEqual({});
    expect(r.after).toEqual({});
  });
});
