import { describe, expect, it } from "vitest";
import {
  BALANCE_CLEARS_HINT,
  BALANCE_NOT_ESTABLISHED,
  STATEMENT_READ_UNAVAILABLE,
  balanceText,
  clientStatementHref,
  clientsListHref,
  lastVisitDetail,
  moneyLineTexts,
  parseClientView,
  parseClientsParams,
  sameNameClientIds,
  tabHref,
  finderOptionLine,
} from "@/lib/finance/statement-screen";

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("links keep the selected month", () => {
  it("both tabs and the client statement carry the month, so going to a client and back restores it", () => {
    expect(tabHref("studio", "2026-11")).toBe("/financials/statement?month=2026-11");
    expect(tabHref("clients", "2026-11")).toBe("/financials/statements?month=2026-11");
    expect(clientStatementHref("c-1", "2026-11")).toBe("/financials/statements/c-1?month=2026-11");
    expect(clientStatementHref("c-1", "2026-11", "history")).toBe("/financials/statements/c-1?month=2026-11&view=history");
    expect(clientsListHref("2026-11")).toBe("/financials/statements?month=2026-11");
    expect(clientsListHref("2026-11", 3)).toBe("/financials/statements?month=2026-11&page=3");
  });
  it("a client id is encoded, so it can never change the path", () => {
    expect(clientStatementHref("a/b?x=1", "2026-11")).toBe("/financials/statements/a%2Fb%3Fx%3D1?month=2026-11");
  });
});

describe("parameters", () => {
  it("an unknown month falls back with a notice flag; the page is a positive whole number, else 1", () => {
    expect(parseClientsParams({ month: "2026-11", page: "2" }, "2026-11")).toMatchObject({ month: "2026-11", fellBack: false, page: 2 });
    expect(parseClientsParams({ month: "garbage" }, "2026-11")).toMatchObject({ month: "2026-11", fellBack: true, page: 1 });
    for (const bad of ["0", "-1", "1.5", "abc", "", "99999999"]) expect(parseClientsParams({ page: bad }, "2026-11").page).toBe(1);
    expect(parseClientsParams({ page: ["3", "4"] }, "2026-11").page).toBe(3);
  });
  it("only an exact 'history' selects the full history", () => {
    expect(parseClientView("history")).toBe("history");
    for (const v of [undefined, "", "month", "HISTORY", "all"]) expect(parseClientView(v)).toBe("month");
  });
});

describe("same-name clients are told apart by a non-identifying detail", () => {
  it("lists exactly the ids that share a shown name (case and accents folded), preferred name included", () => {
    const c = (id: string, name: string, preferredName: string | null = null) => ({ id, name, preferredName, archived: false });
    expect(sameNameClientIds([c("1", "Jose Garcia"), c("2", "josé garcía"), c("3", "Ada Lovelace"), c("4", "Alexandra", "Ada Lovelace")]).sort()).toEqual(["1", "2", "3", "4"]);
    expect(sameNameClientIds([c("1", "Jose"), c("2", "Joan")])).toEqual([]);
  });
  it("the detail is the last visit date or 'No visits', never an email, phone or id", () => {
    expect(lastVisitDetail("2026-11-03")).toBe("Last visit Nov 3, 2026");
    expect(lastVisitDetail(null)).toBe("No visits");
    expect(lastVisitDetail(undefined)).toBe("No visits");
  });
});

describe("what the screen says about money", () => {
  it("an established balance is shown; otherwise it is plainly not shown, with how it clears", () => {
    expect(balanceText({ kind: "established", cents: 4000 }, fmt)).toEqual({ text: "Balance due $40.00", hint: null });
    const b = balanceText({ kind: "not_established", because: "unknown_visits" }, fmt);
    expect(b.text).toBe(BALANCE_NOT_ESTABLISHED);
    expect(b.hint).toBe(BALANCE_CLEARS_HINT);
    expect(BALANCE_CLEARS_HINT).toMatch(/waived/);
    expect(BALANCE_CLEARS_HINT).toMatch(/still owed/);
  });
  it("payment lines keep split payments together, skip excluded rows, and never show a number for a row with no amount", () => {
    const lines = [
      { kind: "collected_card_session", cents: 4000 },
      { kind: "collected_cash", cents: 2000 },
      { kind: "excluded", cents: null },
      { kind: "unresolved", cents: null },
    ] as never;
    const t = moneyLineTexts({ lines }, fmt);
    expect(t).toHaveLength(3);
    expect(t[0]).toMatch(/\$40\.00/);
    expect(t[1]).toMatch(/\$20\.00/);
    expect(t[2]).not.toMatch(/\$/);
  });
  it("no refusal names an internal code, table or id", () => {
    for (const text of Object.values(STATEMENT_READ_UNAVAILABLE)) {
      expect(text).not.toMatch(/_|supabase|postgres|RLS|uuid|status code|\b[45]\d\d\b/i);
    }
  });
});

describe("the Find a client option line", () => {
  const base = { monthLabel: "November 2026", sameNameAsAnother: true, lastVisitsLoaded: true } as const;
  it("a same-name client with NO visit this month and none ever says so once, never \"No visits\" twice", () => {
    const line = finderOptionLine({ ...base, monthVisitCount: 0, lastVisit: null });
    expect(line).toBe("No visits in November 2026 · opens full history · Same name as another client");
    expect(line.match(/No visits/g)?.length).toBe(1);
  });
  it("a same-name client with no visit this month but an earlier one is told apart by the last visit date", () => {
    expect(finderOptionLine({ ...base, monthVisitCount: 0, lastVisit: "2026-09-04" })).toBe("No visits in November 2026 · opens full history · Last visit Sep 4, 2026");
  });
  it("a same-name client with visits shows the count and the last visit date", () => {
    expect(finderOptionLine({ ...base, monthVisitCount: 2, lastVisit: "2026-11-03" })).toBe("2 visits in November 2026 · Last visit Nov 3, 2026");
  });
  it("when the last-visit lookup was not made, only the plain same-name wording follows", () => {
    expect(finderOptionLine({ ...base, monthVisitCount: 1, lastVisit: undefined, lastVisitsLoaded: false })).toBe("1 visit in November 2026 · Same name as another client");
  });
  it("a unique name has no same-name detail; an unavailable count is stated, never a number", () => {
    expect(finderOptionLine({ ...base, sameNameAsAnother: false, monthVisitCount: 0, lastVisit: null })).toBe("No visits in November 2026 · opens full history");
    expect(finderOptionLine({ ...base, sameNameAsAnother: false, monthVisitCount: null, lastVisit: null })).toBe("Visit count for November 2026 unavailable");
  });
});
