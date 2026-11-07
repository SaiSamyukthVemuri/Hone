import { describe, expect, it } from "vitest";
import { emailIlikePattern, exactEmailRows, hasExactEmailMatch, singleExactEmailRow } from "@/lib/invitations/email-match";

describe("emailIlikePattern", () => {
  it("escapes backslash, percent, underscore AND asterisk (PostgREST's alias for %)", () => {
    expect(emailIlikePattern("a_b%c*d\\e@x.com")).toBe("a\\_b\\%c\\*d\\\\e@x.com");
  });
  it("leaves an ordinary address unchanged", () => {
    expect(emailIlikePattern("bob.jones@example.com")).toBe("bob.jones@example.com");
  });
});

describe("exact compare of fetched candidates", () => {
  const rows = [{ email: "Bob.Jones@Example.com" }, { email: "bob_jones@example.com" }, { email: null }];
  it("matches case-insensitively and exactly, ignoring surrounding whitespace on the typed value", () => {
    expect(exactEmailRows(rows, "  bob.jones@example.COM ")).toEqual([{ email: "Bob.Jones@Example.com" }]);
  });
  it("a wildcard-looking typed value matches nothing", () => {
    expect(hasExactEmailMatch(rows, "bob_jones@exampl%.com")).toBe(false);
    expect(hasExactEmailMatch(rows, "b*@example.com")).toBe(false);
    expect(singleExactEmailRow(rows, "*@example.com")).toBeNull();
  });
  it("single: exactly one exact row, else null (two exact rows fail closed)", () => {
    expect(singleExactEmailRow(rows, "bob_jones@example.com")).toEqual({ email: "bob_jones@example.com" });
    expect(singleExactEmailRow([{ email: "a@x.com" }, { email: "A@x.com" }], "a@x.com")).toBeNull();
    expect(singleExactEmailRow(null, "a@x.com")).toBeNull();
  });
});
