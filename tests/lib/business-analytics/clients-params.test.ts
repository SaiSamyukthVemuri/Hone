import { describe, expect, it } from "vitest";

import { clientsQuery, parseClientsParams } from "@/lib/business-analytics/clients-params";

describe("clients params", () => {
  it("defaults to spend, all, page 1", () => {
    expect(parseClientsParams({}, { strict: true })).toEqual({ ok: true, params: { sort: "spend", chip: "all", page: 1 }, notices: [] });
  });
  it("accepts every known sort and chip and a page", () => {
    for (const sort of ["spend", "lifetime", "visits", "interval", "last_visit", "name"]) for (const chip of ["all", "no_next_booking", "beyond_usual"]) expect(parseClientsParams({ sort, chip, page: "3" }, { strict: true })).toMatchObject({ ok: true, params: { sort, chip, page: 3 } });
  });
  it("strict refuses an unknown sort, chip, a bad or huge page and any repeated key", () => {
    for (const raw of [{ sort: "name;drop" }, { chip: "everyone" }, { page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "10001" }, { page: "abc" }, { sort: ["name", "spend"] }, { page: ["1", "2"] }, { sort: "" }]) expect(parseClientsParams(raw, { strict: true })).toEqual({ ok: false, error: "bad_request" });
  });
  it("lenient falls back to the default and says so", () => {
    const r = parseClientsParams({ sort: "x", chip: "y", page: "0" }, { strict: false });
    expect(r).toMatchObject({ ok: true, params: { sort: "spend", chip: "all", page: 1 } });
    expect(r.ok && r.notices).toHaveLength(3);
  });
  it("ignores keys it does not own, including a search term, and never echoes them", () => {
    expect(parseClientsParams({ q: "someone", period: "x" }, { strict: true })).toMatchObject({ ok: true, params: { sort: "spend", chip: "all", page: 1 } });
  });
  it("builds a query with defaults left out and no other key invented", () => {
    const p = { sort: "name" as const, chip: "beyond_usual" as const, page: 2 };
    expect(clientsQuery("?period=month_to_date", p)).toBe("?period=month_to_date&sort=name&chip=beyond_usual&page=2");
    expect(clientsQuery("?period=month_to_date&page=5", p, { sort: "spend", chip: "all", page: 1 })).toBe("?period=month_to_date");
    expect(clientsQuery("", { sort: "spend", chip: "all", page: 1 })).toBe("");
  });
});
