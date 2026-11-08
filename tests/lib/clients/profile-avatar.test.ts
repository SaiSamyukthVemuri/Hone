import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientAvatarInitials } from "@/lib/clients/profile-avatar";

describe("initials avatar", () => {
  it("first and last word, uppercased, decorations skipped", () => {
    expect(clientAvatarInitials("Ada Lovelace")).toBe("AL");
    expect(clientAvatarInitials("ada")).toBe("A");
    expect(clientAvatarInitials("Mary Jane Watson")).toBe("MW");
    expect(clientAvatarInitials("Sam (synthetic)")).toBe("S");
  });
  it("an empty or missing name is a neutral placeholder, never undefined", () => {
    expect(clientAvatarInitials("")).toBe("?");
    expect(clientAvatarInitials(null)).toBe("?");
    expect(clientAvatarInitials(undefined)).toBe("?");
  });
});

// Sam: the profile layout is INDEPENDENT of held 0275 (the ID photo). Every file PB writes is scanned,
// so a later addition cannot quietly bring a photo or 0275 dependency into the shell.
const FORBIDDEN =
  /\b0275\b|identification[_ -]?(photo|image)|id[_-]photo|portrait|ClientPortrait|PortraitControl|signedClientPortraitUrl|clientPortraitEnabled|portrait_image_id/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no PB file depends on a photo feature or on 0275", () => {
  const files = [
    ...readdirSync("lib/clients").filter((f) => f.startsWith("profile-") && f !== "profile-avatar.ts").map((f) => join("lib/clients", f)),
    ...walk("app/(app)/clients/[id]/_profile"),
  ];
  it("scans something", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
  it.each(files)("%s has no portrait / ID-photo / 0275 reference in code", (f) => {
    expect(stripComments(readFileSync(f, "utf8"))).not.toMatch(FORBIDDEN);
  });
});
