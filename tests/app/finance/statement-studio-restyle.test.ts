import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { buildStatement, type StatementCardRow } from "@/lib/finance/statement";
import { STATEMENT_MONTH_NOTICE, STATEMENT_NO_TOTAL, STATEMENT_UNNAMED_PRACTITIONER } from "@/lib/finance/statement-copy";

vi.mock("server-only", () => ({}));

// HON-64 Slice A review findings, pinned by rendering the real view with synthetic data.
const row = (over: Partial<StatementCardRow>): StatementCardRow => ({
  appointmentId: "a1",
  chargeReason: "session_payment",
  status: "succeeded",
  amountCents: 12345,
  currency: "cad",
  refundStatus: null,
  refundAmountCents: null,
  providerRefundStatus: null,
  stripeRefundId: null,
  cumulativeFullRefundVerified: false,
  stripeLivemode: true,
  ...over,
});
const fmt = (c: number) => `$${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")} CAD`;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => createElement("a", { href: String(href), ...rest }, children as never),
  useLinkStatus: () => ({ pending: false }),
}));
import { bucketMethodBreakdown, studioVisitStatus, visitCollectedCents } from "@/lib/finance/statement-methods";
import { formatStatementMoney } from "@/lib/finance/statement-money";
import { latestFirst, parsePageParam, slicePage, STUDIO_VISITS_PAGE_SIZE } from "@/lib/finance/statement-paging";

// The Studio tab, restyled to the approved reference. PRESENTATION ONLY: every figure, sentence and rule is unchanged; these pin what the new layout adds
// (the sage summary card, the method bar, the breakdown behind a disclosure, the paged latest-first visit table) and that none of it can disagree with the
// totals. Synthetic records only.
const ids = Array.from({ length: 11 }, (_, i) => `a${i + 1}`);
const day = (i: number) => `2026-11-${String(i + 1).padStart(2, "0")}T15:00:00Z`;
const build = (over: { extraCard?: StatementCardRow[]; settlements?: { appointmentId: string; method: string; amountCents: number; currency: string }[]; onlyIds?: string[] } = {}) => {
  const use = over.onlyIds ?? ids;
  return buildStatement({
    studioCurrency: "cad",
    appointments: use.map((id, i) => ({ id, practitionerId: "pract-one", startsAt: day(ids.indexOf(id) + 0 * i) })),
    cardRows: [...use.map((id) => row({ appointmentId: id, amountCents: 100000 })), ...(over.extraCard ?? [])],
    settlementRows: over.settlements ?? [],
    legacyFeeRows: [],
  });
};
async function renderWith(statement: ReturnType<typeof buildStatement>, page = 1, over: Record<string, unknown> = {}) {
  const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
  const visitInfo: Record<string, { clientName: string; clientId: string | null; serviceName: string | null; minutes: number | null }> = {};
  for (const v of statement.visits) visitInfo[v.appointmentId] = { clientName: `Client ${v.appointmentId}`, clientId: `c-${v.appointmentId}`, serviceName: "Service", minutes: 60 };
  return renderToStaticMarkup(
    createElement(StatementView as never, {
      view: { access: "granted", ok: true, month: "2026-11", label: "November 2026", timezone: "America/Toronto", startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", statement, visitInfo, practitionerNames: { "pract-one": "Pat Synthetic" }, settlementQuotes: {} },
      currency: "cad",
      format: (c: number) => formatStatementMoney(c, "cad"),
      maxMonth: "2026-11",
      page,
      studioName: "Studio One",
      ...over,
    }),
  );
}

describe("thousands separators: formatMoney with the digits grouped and nothing else changed", () => {
  it("groups whole dollars, keeps cents, sign and the currency label; below $1,000 the text is formatMoney's own", async () => {
    const { formatMoney } = await import("@/lib/billing/payment-jurisdiction");
    expect(formatStatementMoney(484500, "cad")).toBe("$4,845.00 CAD");
    expect(formatStatementMoney(123456789, "cad")).toBe("$1,234,567.89 CAD");
    expect(formatStatementMoney(-100050, "cad")).toBe("-$1,000.50 CAD");
    expect(formatStatementMoney(99999, "cad")).toBe("$999.99 CAD");
    expect(formatStatementMoney(5, null)).toBe("$0.05 (currency unknown)");
    for (const c of [0, 5, 99, 100, 99999]) expect(formatStatementMoney(c, "cad")).toBe(formatMoney(c, "cad"));
    for (const c of [100000, 484500, 123456789]) expect(formatStatementMoney(c, "cad").replace(/,/g, "")).toBe(formatMoney(c, "cad"));
  });
});

describe("paging: a pure slice of the list it is given", () => {
  it("parsePageParam: positive whole numbers only, otherwise page 1", () => {
    expect(parsePageParam("3")).toBe(3);
    for (const bad of [undefined, "", "0", "-1", "1.5", "abc", "99999999", " 2", "2 "]) expect(parsePageParam(bad as never), String(bad)).toBe(1);
    expect(parsePageParam(["4", "5"])).toBe(4);
  });
  it("slicePage clamps into range, reports from/to/total, and an empty list is one empty page", () => {
    const list = Array.from({ length: 11 }, (_, i) => i);
    const p1 = slicePage(list, 1);
    expect([p1.items.length, p1.pages, p1.from, p1.to, p1.total]).toEqual([STUDIO_VISITS_PAGE_SIZE, 2, 1, 8, 11]);
    const p9 = slicePage(list, 9);
    expect([p9.page, p9.items, p9.from, p9.to]).toEqual([2, [8, 9, 10], 9, 11]);
    expect(slicePage([], 3)).toMatchObject({ page: 1, pages: 1, from: 0, to: 0, total: 0, items: [] });
  });
});

describe("the visit table: latest first, paged, and the totals never depend on either", () => {
  it("lists the latest visit first and pages over THAT order (page 1 holds the 8 latest, page 2 the 3 earliest)", async () => {
    const st = build();
    const p1 = await renderWith(st, 1);
    const p2 = await renderWith(st, 2);
    const shown = (h: string) => [...h.matchAll(/Client (a\d+)/g)].map((m) => m[1]);
    expect(shown(p1)).toEqual(["a11", "a10", "a9", "a8", "a7", "a6", "a5", "a4"]);
    expect(shown(p2)).toEqual(["a3", "a2", "a1"]);
    expect(p1).toContain("1–8 of 11");
    expect(p2).toContain("9–11 of 11");
  });
  it("the summary, counts and every breakdown figure are identical on every page and for any input order", async () => {
    const st = build();
    const summary = (h: string) => h.slice(h.indexOf('aria-label="Summary"'), h.indexOf("</section>", h.indexOf('aria-label="Summary"')));
    const full = (h: string) => h.slice(h.indexOf("Full payment breakdown"), h.indexOf("</details>", h.indexOf("Full payment breakdown")));
    const [p1, p2] = [await renderWith(st, 1), await renderWith(st, 2)];
    expect(summary(p1)).toBe(summary(p2));
    expect(full(p1)).toBe(full(p2));
    const shuffled = { ...st, visits: [...st.visits].reverse() };
    expect(summary(await renderWith(shuffled as never, 1))).toBe(summary(p1));
    expect(summary(p1)).toContain("11 visits with recorded money");
    expect(summary(p1)).toContain("$11,000.00");
  });
  it("a page past the end shows the last page; the pager links carry the month and disable at the ends", async () => {
    const st = build();
    const past = await renderWith(st, 50);
    expect(past).toContain("9–11 of 11");
    expect(past).toMatch(/href="\/financials\/statement\?month=2026-11"[^>]*>Previous</);
    expect(past).toMatch(/aria-disabled="true">Next</);
    const first = await renderWith(st, 1);
    expect(first).toMatch(/href="\/financials\/statement\?month=2026-11&amp;page=2"[^>]*>Next</);
    expect(first).toMatch(/aria-disabled="true">Previous</);
  });
  it("one page of visits shows no pager", async () => {
    expect(await renderWith(build({ onlyIds: ["a1", "a2"] }), 1)).not.toContain('aria-label="Visit pages"');
  });
});

describe("the method bar appears only when the segments reconcile to the collected total", () => {
  it("one method: one full-width segment; the list and the total agree", async () => {
    const out = await renderWith(build({ onlyIds: ["a1"] }));
    expect(out).toContain("Collected by method");
    expect(out).toMatch(/width:100%/);
    expect(out).toContain("$1,000.00");
  });
  it("two methods: the segments sum to the total, to the cent, and the list shows both", async () => {
    const st = build({ onlyIds: ["a1"], settlements: [{ appointmentId: "a1", method: "paid_cash", amountCents: 25000, currency: "cad" }] });
    const m = bucketMethodBreakdown(st.all)!;
    expect(m.reduce((n, x) => n + x.cents, 0)).toBe(st.all.collectedCents);
    const out = await renderWith(st);
    // the card shows the short method words, the amounts without a currency suffix (CAD appears once, beside the total), the bar above the list
    const card = out.slice(out.indexOf('aria-label="Summary"'), out.indexOf("</section>", out.indexOf('aria-label="Summary"')));
    expect(card).toMatch(/<span>Card<\/span><span[^>]*>\$1,000\.00<\/span>/);
    expect(card).toMatch(/<span>Cash<\/span><span[^>]*>\$250\.00<\/span>/);
    expect(card.indexOf("h-[7px]")).toBeLessThan(card.indexOf("<span>Card</span>"));
    expect(card.match(/CAD/g)?.length).toBe(1);
    // the full verified wording stays in the breakdown
    expect(out).toContain("Card (Hone-verified): session payments");
    expect(out).toContain("Cash (recorded by the owner)");
  });
  it("a fully refunded charge is not collected money: it is not in the bar, the list or the total", async () => {
    const st = build({ onlyIds: ["a1"], extraCard: [row({ appointmentId: "a1", amountCents: 70000, cumulativeFullRefundVerified: true, refundStatus: "succeeded", providerRefundStatus: "succeeded", stripeRefundId: "re_x" })] });
    expect(st.all.collectedCents).toBe(100000);
    const m = bucketMethodBreakdown(st.all)!;
    expect(m.map((x) => x.cents)).toEqual([100000]);
  });
  it("nothing collected: no bar, and the card says so in words; a total the groups cannot explain draws no bar either", async () => {
    const none = buildStatement({ studioCurrency: "cad", appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [] });
    const out = await renderWith(none);
    expect(out).toContain("No recorded money for visits this month.");
    expect(out).not.toMatch(/h-\[7px\]/);
    const st = build({ onlyIds: ["a1"] });
    expect(bucketMethodBreakdown({ ...st.all, collectedCents: st.all.collectedCents + 1 })).toBeNull();
  });
});

describe("what a visit row says", () => {
  it("studioVisitStatus: Payment recorded when money was collected with no price known; otherwise the adjustment or note in the screen's own words", () => {
    expect(studioVisitStatus([{ kind: "collected_cash", cents: 100 }])).toEqual({ label: "Payment recorded", tone: "paid" }); // no price known: never claimed as paid in full
    expect(studioVisitStatus([{ kind: "refunded_card_session", cents: 100 }]).label).toBe("Refunded in full");
    expect(studioVisitStatus([{ kind: "waived", cents: 100 }]).label).toBe("Waived");
    expect(studioVisitStatus([{ kind: "still_owes_note", cents: null }]).label).toBe("Marked still owing");
    expect(studioVisitStatus([{ kind: "unresolved", cents: null }])).toEqual({ label: "Unresolved", tone: "neutral" });
    expect(studioVisitStatus([{ kind: "collected_card_session", cents: 100 }, { kind: "refunded_card_fee", cents: 50 }]).label).toBe("Paid");
    // with no price or balance known, money recorded beside a still-owing or waived note is NOT "Paid" (it cannot mean paid in full)
    expect(studioVisitStatus([{ kind: "collected_cash", cents: 5000 }, { kind: "still_owes_note", cents: null }])).toEqual({ label: "Payment recorded", tone: "paid" });
    expect(studioVisitStatus([{ kind: "collected_cash", cents: 5000 }, { kind: "waived", cents: 1000 }]).label).toBe("Payment recorded");
  });
  it("visitCollectedCents sums collected-method lines only and is null with none", () => {
    expect(visitCollectedCents([{ kind: "collected_card_session", cents: 12345 }, { kind: "collected_cash", cents: 5000 }, { kind: "unresolved", cents: null }])).toBe(17345);
    expect(visitCollectedCents([{ kind: "refunded_card_session", cents: 6000 }, { kind: "waived", cents: 2000 }])).toBeNull();
  });
  it("the row carries date and time, client, service, a status pill with the verified method label, a right-aligned amount and an expander with the lines and Insurer details", async () => {
    const out = await renderWith(build({ onlyIds: ["a2"] }));
    expect(out).toContain('dateTime="2026-11-02"');
    expect(out).toContain(">Nov 2<");
    expect(out).toContain("Client a2");
    expect(out).toMatch(/>Paid<\/span><span[^>]*>Card</);
    expect(out).toMatch(/text-right[^"]*"[^>]*>\$1,000\.00</);
    const visits = out.slice(out.indexOf('aria-labelledby="stmt-visits"'));
    expect(visits.slice(0, visits.indexOf("</summary>"))).not.toContain("CAD"); // CAD once, in the card; not on the row (the breakdown keeps full amounts)
    expect(out).toMatch(/>10:00 AM</); // 12-hour time, as the reference draws it (15:00Z is 10:00 in Toronto)
    expect(out).toMatch(/<a [^>]*href="\/financials\/statements\/c-a2\?month=2026-11[^"]*"[^>]*>Client a2<\/a>/); // the client links to their own statement for the month
    expect(out).toContain("Insurer details");
    expect(out.match(/<details/g)?.length).toBe(2); // the full breakdown + the one visit
  });
});

describe("nothing was removed: every breakdown label, note and the verified sentence are still on the page, inside the labelled disclosure", () => {
  it("lists every collected, adjustment and not-totalled label, the notes, the practitioner block and the totals", async () => {
    const out = await renderWith(build({ onlyIds: ["a1"] }));
    expect(out).toMatch(/<details[^>]*><summary[^>]*>Full payment breakdown<\/summary>/);
    for (const label of ["Refunded in full: session payments", "Waived (owner-attested as forgiven)", "In another currency (not summed)", "Marked still owing (a note, not an amount)", "By practitioner", "Pat Synthetic", "Reconciliation:"]) {
      expect(out, label).toContain(label);
    }
    expect(out.match(/Collected in total: \$1,000\.00 CAD/g)?.length).toBe(2); // all practitioners + the practitioner's block
  });
});

describe("the chrome", () => {
  it("the month arrows keep their words for screen readers, the picker auto-submits its own GET form, and 'Show month' stays for no-JS", async () => {
    const out = await renderWith(build({ onlyIds: ["a1"] }), 1, { maxMonth: "2026-12" });
    expect(out).toMatch(/<span class="sr-only">Previous month<\/span>/);
    expect(out).toMatch(/<span class="sr-only">Next month<\/span>/);
    expect(out).toContain("Show month");
    expect(out).toMatch(/<form[^>]*action="\/financials\/statement"[^>]*method="get"/);
    const src = readFileSync("app/(app)/financials/statements/month-picker-input.tsx", "utf8");
    expect(src).toMatch(/requestSubmit\(\)/);
  });
  it("the contained width breakout is on the page wrapper only and only from 1140px, so a phone has no sideways scroll from it", () => {
    const src = readFileSync("app/(app)/financials/statement/page.tsx", "utf8");
    expect(src).toMatch(/className="min-\[1140px\]:-mx-\[45px\]"/);
    expect(src).not.toMatch(/(^|[\s"])-mx-\[45px\]/m);
  });
});

describe("a part-payment with a still-owing note does not read as Paid, and the note shows beside the method", () => {
  it("renders 'Payment recorded' with the money AND the still-owing wording in the row", async () => {
    const st = build({ onlyIds: ["a1"], settlements: [{ appointmentId: "a1", method: "still_owes", amountCents: 0, currency: "cad" }] });
    const out = await renderWith(st);
    expect(out).toMatch(/>Payment recorded<\/span>/);
    expect(out).not.toMatch(/>Paid<\/span>/);
    expect(out).toMatch(/Marked still owing \(a note, not an amount\)<\/span>/);
    expect(out).toMatch(/>Card<\/span>/);
  });
});

describe("latest first is deterministic", () => {
  it("equal times break on the id; a start time that does not parse sorts last, never NaN into the order", () => {
    const rows = [
      { appointmentId: "b", startsAt: "2026-11-02T15:00:00Z" },
      { appointmentId: "a", startsAt: "2026-11-02T15:00:00Z" },
      { appointmentId: "z", startsAt: "not a time" },
      { appointmentId: "c", startsAt: "2026-11-09T15:00:00Z" },
      { appointmentId: "y", startsAt: "" },
    ];
    const order = (r: typeof rows) => [...r].sort(latestFirst).map((x) => x.appointmentId);
    expect(order(rows)).toEqual(["c", "a", "b", "y", "z"]);
    expect(order([...rows].reverse())).toEqual(order(rows));
  });
  it("a parseable start time ALWAYS precedes an unparseable one, even where id order would put the unparseable one first", () => {
    const pair = [{ appointmentId: "a", startsAt: "not a time" }, { appointmentId: "b", startsAt: "2026-11-02T15:00:00Z" }];
    expect([...pair].sort(latestFirst).map((x) => x.appointmentId)).toEqual(["b", "a"]);
    expect([...pair].reverse().sort(latestFirst).map((x) => x.appointmentId)).toEqual(["b", "a"]);
  });
});
