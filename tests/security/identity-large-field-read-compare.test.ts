import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Privacy R1 (#1328): a long field has no URL condition, so the action must read its current value BEFORE the write and
// refuse on a difference. Source order pin: the read-compare precedes the conditional update.
const src = readFileSync(join(process.cwd(), "app/(app)/clients/[id]/actions.ts"), "utf8");
const fn = src.slice(src.indexOf("export async function updateClientAction"));

describe("updateClientAction reads long fields before it writes", () => {
  it("splits the conditions, reads the unconditioned columns, refuses on a conflict, then writes", () => {
    const split = fn.indexOf("splitConditions(plan.conditions)");
    const read = fn.indexOf('.select(unconditioned.map((c) => c.key).join(","))');
    const refuse = fn.indexOf("if (moved.length > 0) return");
    const write = fn.indexOf('update.select("id")');
    expect(split).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(split);
    expect(refuse).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(refuse);
  });
  it("applies only the URL-safe conditions to the write", () => {
    expect(fn).toContain("for (const { key, value } of inUrl)");
    expect(fn).not.toContain("of plan.conditions) {\n    update =");
  });
});
