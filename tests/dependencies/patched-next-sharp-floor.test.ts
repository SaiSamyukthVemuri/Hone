import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Security floor for the two image/runtime dependencies with open
// advisories. package.json pins exact versions today, but a lockfile
// regeneration, a manual downgrade, or a transitive copy that escapes
// the `"sharp": "$sharp"` override would silently reinstall a
// vulnerable build. These tests read what npm actually RESOLVES
// (package-lock.json), including any nested copy, and fail CI below
// the patched floor.
//
// - GHSA-p3m5-59mp-jv5r (next, Server Actions DoS): patched 15.5.28 on
//   the 15.x line, 16.4.1 on the 16.x line.
// - GHSA-wq5f-xc86-pv6w (sharp, librsvg): patched 0.35.5.
// - GHSA-rgj7-g3m4-5g8c (sharp, libheif): patched 0.35.4.
//
// librsvg and libheif ship inside sharp's prebuilt libvips
// (@img/sharp-libvips-*), so the fix is only installed when those
// binaries are at least the libvips version sharp 0.35.5 declares.

const ROOT = path.resolve(__dirname, "../..");
type LockEntry = { version?: string; optionalDependencies?: Record<string, string> };
const LOCK: { packages: Record<string, LockEntry> } = JSON.parse(
  readFileSync(path.join(ROOT, "package-lock.json"), "utf8"),
);

const NEXT_FLOOR_BY_MAJOR: Record<number, string> = { 15: "15.5.28", 16: "16.4.1" };
const SHARP_FLOOR = "0.35.5";
const LIBVIPS_FLOOR = "1.3.4";

function parse(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string, floor: string): boolean {
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  // A prerelease of the floor itself (15.5.28-canary.1) is older than
  // the release that carries the fix.
  return !version.includes("-");
}

// Every resolved copy of a package, root or nested
// (node_modules/next/node_modules/sharp, ...).
function resolvedCopies(
  name: string,
  packages: Record<string, LockEntry> = LOCK.packages,
): Array<[string, string]> {
  const suffix = `node_modules/${name}`;
  return Object.entries(packages)
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .map(([key, entry]) => [key, entry.version ?? ""]);
}

function libvipsCopies(): Array<[string, string]> {
  return Object.entries(LOCK.packages)
    .filter(([key]) => /(^|\/)node_modules\/@img\/sharp-libvips-[^/]+$/.test(key))
    .map(([key, entry]) => [key, entry.version ?? ""]);
}

describe("patched floor helpers", () => {
  it("compares release versions numerically, not lexically", () => {
    expect(atLeast("15.5.28", "15.5.28")).toBe(true);
    expect(atLeast("15.5.100", "15.5.28")).toBe(true);
    expect(atLeast("15.5.27", "15.5.28")).toBe(false);
    expect(atLeast("15.10.0", "15.5.28")).toBe(true);
    expect(atLeast("0.35.4", "0.35.5")).toBe(false);
    expect(atLeast("0.36.0", "0.35.5")).toBe(true);
    expect(atLeast("15.5.28-canary.3", "15.5.28")).toBe(false);
  });

  it("finds nested copies, not only the root one", () => {
    const packages: Record<string, LockEntry> = {
      "node_modules/sharp": { version: "0.35.5" },
      "node_modules/next/node_modules/sharp": { version: "0.34.1" },
      "node_modules/sharp-cli": { version: "9.9.9" },
      "node_modules/@img/sharp-linux-x64": { version: "0.35.5" },
    };
    expect(resolvedCopies("sharp", packages)).toEqual([
      ["node_modules/sharp", "0.35.5"],
      ["node_modules/next/node_modules/sharp", "0.34.1"],
    ]);
  });
});

describe("resolved next is at or above the GHSA-p3m5-59mp-jv5r patch", () => {
  const copies = resolvedCopies("next");

  it("the lockfile resolves next", () => {
    expect(copies.map(([key]) => key)).toContain("node_modules/next");
  });

  it.each(copies)("%s (%s) is patched", (_key, version) => {
    const [major] = parse(version);
    const floor = NEXT_FLOOR_BY_MAJOR[major];
    if (floor === undefined) {
      // Majors before 15 are inside the advisory's range with no
      // backport; a later major must be added here deliberately.
      expect(major, `no reviewed floor for next ${version}`).toBeGreaterThan(16);
      return;
    }
    expect(atLeast(version, floor), `next ${version} < ${floor}`).toBe(true);
  });
});

describe("resolved sharp is at or above the librsvg/libheif patches", () => {
  const copies = resolvedCopies("sharp");

  it("the lockfile resolves sharp at the root", () => {
    expect(copies.map(([key]) => key)).toContain("node_modules/sharp");
  });

  it.each(copies)("%s (%s) is >= " + SHARP_FLOOR, (_key, version) => {
    expect(atLeast(version, SHARP_FLOOR), `sharp ${version} < ${SHARP_FLOOR}`).toBe(true);
  });

  it("every sharp copy requires a libvips build at or above the floor", () => {
    for (const [key] of copies) {
      const optional = LOCK.packages[key].optionalDependencies ?? {};
      const libvips = Object.entries(optional).filter(([dep]) =>
        dep.startsWith("@img/sharp-libvips-"),
      );
      expect(libvips.length, `${key} declares no libvips binaries`).toBeGreaterThan(0);
      for (const [dep, range] of libvips) {
        expect(atLeast(range.replace(/^[\^~>=\s]+/, ""), LIBVIPS_FLOOR), `${key} -> ${dep}@${range}`).toBe(true);
      }
    }
  });

  it("every resolved libvips binary (librsvg + libheif carrier) is at or above the floor", () => {
    const binaries = libvipsCopies();
    expect(binaries.length).toBeGreaterThan(0);
    for (const [key, version] of binaries) {
      expect(atLeast(version, LIBVIPS_FLOOR), `${key} ${version} < ${LIBVIPS_FLOOR}`).toBe(true);
    }
  });
});
