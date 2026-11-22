import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("0106 — sender stays gated (production inert without config)", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
  }
  it("dispatch short-circuits on missing consent and on zero enabled configs", () => {
    const D = read("lib/conversion/dispatch.ts");
    expect(D).toMatch(/if \(!params\.consentGranted\) return;/);
    expect(D).toMatch(/if \(!rows \|\| rows\.length === 0\) return;/);
    // The pure routing service still does no network itself.
    expect(read("lib/conversion/service.ts")).not.toContain("fetch(");
  });
});
