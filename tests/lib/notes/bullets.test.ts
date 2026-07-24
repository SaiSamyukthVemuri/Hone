import { describe, expect, it } from "vitest";
import { BULLET, insertBullet, bulletEnter, bulletBackspace } from "@/lib/notes/bullets";

const MAX = 20000;

describe("personal-notes bullets — plain text keyboard contract", () => {
  it("2) Add bullet inserts '• ' at the start of the current line; caret moves with it", () => {
    expect(insertBullet("", 0, MAX)).toEqual({ value: BULLET, cursor: 2 });
    expect(insertBullet("hello", 3, MAX)).toEqual({ value: "• hello", cursor: 5 });
    expect(insertBullet("• first\nsecond", 12, MAX)).toEqual({ value: "• first\n• second", cursor: 14 });
  });
  it("never double-bullets and never exceeds max", () => {
    expect(insertBullet("• x", 3, MAX)).toBeNull();
    expect(insertBullet("aaaa", 0, 4)).toBeNull();
  });
  it("3) Enter continues a non-empty bullet with a new '• '", () => {
    expect(bulletEnter("• milk", 6, MAX)).toEqual({ value: "• milk\n• ", cursor: 9 });
  });
  it("4) Enter on an EMPTY bullet exits (removes the marker → plain empty line)", () => {
    expect(bulletEnter("• ", 2, MAX)).toEqual({ value: "", cursor: 0 });
    expect(bulletEnter("• a\n• ", 6, MAX)).toEqual({ value: "• a\n", cursor: 4 });
  });
  it("Enter on a NON-bullet line is a no-op (browser inserts a normal newline)", () => {
    expect(bulletEnter("plain", 5, MAX)).toBeNull();
  });
  it("10) Enter that would exceed max is left to the browser", () => {
    expect(bulletEnter("• x", 3, 3)).toBeNull();
  });
  it("5) Backspace at the beginning of an EMPTY bullet removes the marker; else no-op", () => {
    expect(bulletBackspace("• ", 2)).toEqual({ value: "", cursor: 0 });
    expect(bulletBackspace("• a\n• ", 6)).toEqual({ value: "• a\n", cursor: 4 });
    expect(bulletBackspace("• x", 3)).toBeNull();
    expect(bulletBackspace("• ", 1)).toBeNull();
  });
});
