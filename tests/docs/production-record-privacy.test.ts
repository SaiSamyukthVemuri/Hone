import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The tracked production record (docs/production/**) is public text. It must not carry a studio (tenant) name, a Supabase project
// reference (production or staging), or a private host path or host name. Those were replaced by neutral words ("the pilot studio",
// "the production project", "the staging project", "the operator's workstation", "the repository host") and this test keeps them out.
//
// THE VALUES ARE NOT IN THIS FILE. A guard that spelled the forbidden strings would itself publish them. Instead:
//   * every word-like token in a record file is hashed (SHA-256, lower case) and compared with the hashes below;
//   * a token SHAPED like a project reference (exactly 20 lower-case letters with few vowels) is refused whether or not it is listed, so a
//     NEW project's reference is caught too;
//   * when supabase/.temp/project-ref exists (it is untracked, so only on a machine that linked a project), its content is compared as well.
// Paths and IP addresses are public shapes, so those are matched directly.
const ROOT = path.resolve(__dirname, "../..");
const RECORD_DIR = path.join(ROOT, "docs/production");

const FORBIDDEN_HASHES: Record<string, string> = {
  "ca4f1421bf786a9e205e8d6f132d31657af5aa949cc7ae90d961f9f32c12d36f": "production project ref",
  "b5f9ba2e1fb29cd447c7ae37fd0fce5bb6206993c1d14e0da105b86060ddf2a8": "staging project ref",
  "da454b02b4700b1f5dc5f9de972a531934ccb666cd00ed832fe6a36ece8b9ec3": "tenant name (first word)",
  "566c623979151811ac74534c9d709fdacbc30f9963a44379691864a25c1e886a": "tenant slug",
  "fc24980a4de16b17e922ea786574594a0ba67cc3c4b62c99c7179e92aac6a4dc": "private repository host"
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The ways a record line can leak. Pure, so the controls below can drive it with invented fixtures. */
export function privacyFindings(text: string, hashes: Record<string, string>, extraLiterals: string[] = []): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]/gi)) {
    const token = m[0].toLowerCase();
    const label = hashes[sha(token)];
    if (label) found.push(label);
    // A hyphenated token is also checked part by part, so a name inside a longer identifier is still found.
    if (token.includes("-")) for (const part of token.split("-")) if (hashes[sha(part)]) found.push(hashes[sha(part)]);
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9])[a-z]{20}(?![A-Za-z0-9])/g)) {
    const vowels = [...m[0]].filter((c) => "aeiou".includes(c)).length;
    if (vowels <= 6) found.push("a project-reference-shaped string");
  }
  for (const lit of extraLiterals) if (lit && text.includes(lit)) found.push("a value from supabase/.temp");
  if (/(?:^|[\s`'"(=])\/(?:home|srv|Users|root)\//.test(text)) found.push("a private host path");
  if (/(?<![0-9.])(?:10|127|192\.168|172\.(?:1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?(?![0-9])/.test(text)) found.push("a private IP address");
  return found;
}

function recordFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...recordFiles(p));
    else if (/\.(md|json|txt)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the tracked production record carries no tenant name, project reference or private host", () => {
  const files = recordFiles(RECORD_DIR);
  const tempRef = path.join(ROOT, "supabase/.temp/project-ref");
  const extra = existsSync(tempRef) ? [readFileSync(tempRef, "utf8").trim()] : [];

  it("scans a real record (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.endsWith("migration-state.json"))).toBe(true);
    expect(Object.keys(FORBIDDEN_HASHES).length).toBe(5);
  });

  it("no record file names a studio, a project, or a private host", () => {
    const bad: string[] = [];
    for (const f of files) {
      const kinds = [...new Set(privacyFindings(readFileSync(f, "utf8"), FORBIDDEN_HASHES, extra))];
      if (kinds.length) bad.push(`${path.relative(ROOT, f)}: ${kinds.join(", ")}`);
    }
    expect(bad, "replace it with the neutral wording (the pilot studio, the production project, the staging project, the operator's workstation)").toEqual([]);
  });

  it("no record file NAME carries a forbidden word either (the releases file was renamed)", () => {
    const bad = files.filter((f) => privacyFindings(path.relative(RECORD_DIR, f).replace(/[./_]/g, " "), FORBIDDEN_HASHES).length > 0);
    expect(bad.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("CONTROL: the detector flags invented fixtures of every kind and passes ordinary text", () => {
    const fixture = { [sha("fixturetenant")]: "tenant name (fixture)", [sha("fixture-tenant-slug")]: "tenant slug (fixture)" };
    expect(privacyFindings("The fixturetenant studio", fixture)).toEqual(["tenant name (fixture)"]);
    expect(privacyFindings("slug fixture-tenant-slug here", fixture)).toContain("tenant slug (fixture)");
    expect(privacyFindings("FixtureTenant is a name", fixture)).toEqual(["tenant name (fixture)"]); // case-insensitive
    expect(privacyFindings("ref `qwrtypsdfghjklzxcvbn` here", {})).toEqual(["a project-reference-shaped string"]);
    expect(privacyFindings("see /srv/anything/at/all", {})).toEqual(["a private host path"]);
    expect(privacyFindings("see `/home/someone/x`", {})).toEqual(["a private host path"]);
    expect(privacyFindings("host 192.168.1.20 and 10.0.0.5", {})).toEqual(["a private IP address"]);
    expect(privacyFindings("a value from the temp file: zzz-temp-value-zzz", {}, ["zzz-temp-value-zzz"])).toEqual(["a value from supabase/.temp"]);
    expect(privacyFindings("the pilot studio, the production project, the staging project, version 17.6.1.121, 0375, /api/summary", {})).toEqual([]);
    // an ordinary long English word is not mistaken for a project reference (many vowels)
    expect(privacyFindings("reconceptualisation manufacturerness", {})).toEqual([]);
  });
});
