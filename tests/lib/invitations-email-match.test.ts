import { describe, expect, it } from "vitest";
import { EMAIL_CANDIDATE_LIMIT, emailCandidateState, emailIlikePattern, exactEmailRows, hasExactEmailMatch, singleExactEmailRow } from "@/lib/invitations/email-match";

describe("emailIlikePattern", () => {
  it("escapes backslash, percent and underscore; each asterisk becomes the single-character wildcard _ (PostgREST never sees a *)", () => {
    expect(emailIlikePattern("a_b%c*d\\e@x.com")).toBe("a\\_b\\%c_d\\\\e@x.com");
    expect(emailIlikePattern("*@x.com")).toBe("_@x.com");
  });
  it("pins the exact string: a real underscore stays escaped, the asterisk becomes a bare _", () => {
    expect(emailIlikePattern("a_b*c@x.com")).toBe("a\\_b_c@x.com");
  });
  it("contains no asterisk at all", () => {
    expect(emailIlikePattern("a*b**c@x.com")).not.toContain("*");
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

describe("full candidate page is inconclusive (fail closed)", () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `bob${i}jones@x.com` }));
  it("emailCandidateState: match / none / inconclusive", () => {
    expect(emailCandidateState([{ email: "a@x.com" }], "a@x.com")).toBe("match");
    expect(emailCandidateState(page(3), "a@x.com")).toBe("none");
    expect(emailCandidateState(page(EMAIL_CANDIDATE_LIMIT), "a@x.com")).toBe("inconclusive");
    expect(emailCandidateState([...page(EMAIL_CANDIDATE_LIMIT - 1), { email: "a@x.com" }], "a@x.com")).toBe("match");
  });
  it("singleExactEmailRow refuses a full page even when it holds the one exact row", () => {
    expect(singleExactEmailRow([...page(EMAIL_CANDIDATE_LIMIT - 1), { email: "a@x.com" }], "a@x.com")).toBeNull();
    expect(singleExactEmailRow([...page(EMAIL_CANDIDATE_LIMIT - 2), { email: "a@x.com" }], "a@x.com")).not.toBeNull();
  });
});
