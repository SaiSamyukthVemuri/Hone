import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Sam's decision (Vercel Security Review finding 01M6SPYTZ01MAGB74CGWVV953E): neither removal nor a member's own Disconnect revokes the
// grant at Google, because a revoke acts on the person's grant to Hone's project and so ends the same Google account's sync in every
// studio. This guard keeps that from being silently undone: nothing under app/ or lib/ may import or call revokeToken. The export in
// lib/google-calendar/oauth.ts stays (its own tests exercise it), but it has no caller.
const ROOT = join(__dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}
const DEFINER = join("lib", "google-calendar", "oauth.ts");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("nothing in app/ or lib/ revokes a Google grant", () => {
  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].filter((f) => !f.endsWith(DEFINER));
  it("scans a real set of files (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("no caller or import of revokeToken", () => {
    const hits = files.filter((f) => /\brevokeToken\b/.test(strip(readFileSync(f, "utf8")))).map((f) => f.slice(ROOT.length + 1));
    expect(hits, "revokeToken is called or imported here; Sam's decision removed every revoke at Google").toEqual([]);
  });
  it("negative control: the matcher does see a call", () => {
    expect(/\brevokeToken\b/.test(strip('await revokeToken(secret);'))).toBe(true);
    expect(/\brevokeToken\b/.test(strip('// revokeToken is gone\n/* revokeToken */'))).toBe(false);
  });
});
