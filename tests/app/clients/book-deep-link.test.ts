import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
const book = readFileSync("app/(app)/clients/[id]/BookAppointment.tsx", "utf8");

describe("?book=1 opens the existing booking flow (directory contract)", () => {
  it("the profile passes the param to BookAppointment for its own client", () => {
    expect(page).toMatch(/book\?: string/);
    expect(page).toMatch(/autoOpenBooking = sp\.book === "1"/);
    expect(page).toMatch(/initiallyOpen=\{autoOpenBooking\}/);
  });
  it("starts expanded, loads slots once, focuses the first control without scrolling", () => {
    expect(book).toMatch(/useState\(initiallyOpen\)/);
    expect(book).toMatch(/deepLinkHandled/);
    expect(book).toMatch(/loadForService\(serviceId, date\)/);
    expect(book).toMatch(/firstControlRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
    expect(book).toMatch(/ref=\{firstControlRef\}/);
  });
  it("removes only `book` from the URL with router.replace and scroll:false, no anchor", () => {
    expect(book).toMatch(/next\.delete\("book"\)/);
    expect(book).toMatch(/router\.replace\([^)]*\{ scroll: false \}\)/);
    expect(book).not.toMatch(/router\.(push|replace)\([^)]*#/);
  });
});
