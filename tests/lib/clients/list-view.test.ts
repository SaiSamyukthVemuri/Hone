import { describe, expect, it } from "vitest";
import {
  CLIENT_LIST_VIEWS,
  clientListViewHref,
  clientListViewSummary,
  parseClientListView,
} from "@/lib/clients/list-view";

// HON-14 (CLIENT-STATUS-01). The clients list view is one pure decision, so the
// later Paused/Completed filters change ONE module instead of a page. This pins
// TODAY's behaviour exactly (two views, anything else is the active view) and the
// shape those filters will extend. No behaviour changes with this slice.

describe("parseClientListView: today's contract", () => {
  it.each([
    [undefined, "active"],
    ["", "active"],
    ["active", "active"],
    ["archived", "archived"],
    ["ARCHIVED", "active"], // exact match only, as before
    ["paused", "active"], // not a view until the schema can store it
    ["completed", "active"],
    ["all", "active"],
    ["archived; drop", "active"],
    [["archived", "active"], "archived"], // first value wins, as before
    [["bogus", "archived"], "active"],
    [[], "active"],
  ])("%j -> %s", (raw, expected) => {
    expect(parseClientListView(raw as string | string[] | undefined)).toBe(expected);
  });
});

describe("the view list the tabs are drawn from", () => {
  it("has exactly active then archived, each with a label and its own href", () => {
    expect(CLIENT_LIST_VIEWS.map((v) => v.value)).toEqual(["active", "archived"]);
    expect(CLIENT_LIST_VIEWS.map((v) => v.label)).toEqual(["Active clients", "Archived clients"]);
    for (const v of CLIENT_LIST_VIEWS) expect(clientListViewHref(v.value)).toBe(`/clients?view=${v.value}`);
  });
  it("every listed view round-trips through the parser (no tab links to a view the page ignores)", () => {
    for (const v of CLIENT_LIST_VIEWS) expect(parseClientListView(v.value)).toBe(v.value);
  });
});

describe("clientListViewSummary: the count line under the title", () => {
  it.each([
    ["active", 0, "No clients yet."],
    ["active", 1, "1 client"],
    ["active", 12, "12 clients"],
    ["archived", 0, "No archived clients."],
    ["archived", 3, "3 archived"],
  ] as const)("%s with %i -> %s", (view, n, text) => {
    expect(clientListViewSummary(view, n)).toBe(text);
  });
});
