import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeDirectoryReturnTo } from "@/lib/nav/directory-return";

describe("sanitizeDirectoryReturnTo — only the internal /clients directory", () => {
  it("accepts the directory with and without its URL state", () => {
    expect(sanitizeDirectoryReturnTo("/clients")).toBe("/clients");
    expect(sanitizeDirectoryReturnTo("/clients?q=ann%20lee&sort=name&page=2")).toBe(
      "/clients?q=ann%20lee&sort=name&page=2",
    );
  });
  it("rejects external, protocol-relative, cross-route, fragment and oversized values", () => {
    for (const bad of [
      "https://evil.com",
      "//evil.com",
      "/clients/abc",
      "/clients#x",
      "/clients?x=1#f",
      "/clients?next=https://evil.com",
      "/clients?a=\\evil",
      "/calendar",
      "/clientsx",
      " /clients",
      `/clients?q=${"a".repeat(600)}`,
      "",
    ]) {
      expect(sanitizeDirectoryReturnTo(bad)).toBeNull();
    }
    expect(sanitizeDirectoryReturnTo(undefined)).toBeNull();
    expect(sanitizeDirectoryReturnTo(["/clients?q=a", "/x"])).toBe("/clients?q=a");
  });
});

describe("profile book=1 deep link wiring (source contract)", () => {
  const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
  const book = readFileSync("app/(app)/clients/[id]/BookAppointment.tsx", "utf8");
  it("opens the existing booking flow for this client, with no anchor", () => {
    expect(page).toMatch(/autoOpenBooking = sp\.book === "1"/);
    expect(page).toMatch(/initiallyOpen=\{autoOpenBooking\}/);
    expect(book).toMatch(/useState\(initiallyOpen\)/);
    expect(page).not.toMatch(/book=1#/);
  });
  it("Back uses the validated directory return path, falling back to /clients", () => {
    expect(page).toMatch(/href=\{directoryReturnTo \?\? "\/clients"\}/);
  });
  it("keeps book=1 and its return path through a tab redirect", () => {
    expect(page).toMatch(/q\.set\("book", "1"\)/);
  });
});
