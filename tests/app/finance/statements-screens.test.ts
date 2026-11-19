// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The statements screens: the Clients tab, Find a client (mounted, with real keyboard events) and a client's statement. Synthetic records only.
// The pure model is proved in the lib tests; this file proves what the screens SHOW and DO with it, and that they are read-only.
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/financials/statements", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => {
    const { createElement } = require("react") as typeof import("react");
    return createElement("a", { href, ...rest }, children as never);
  },
  useLinkStatus: () => ({ pending: false }),
}));

const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ClientFinder } = await import("@/app/(app)/financials/statements/client-finder");
const { ClientsView } = await import("@/app/(app)/financials/statements/clients-view");
const { ClientStatementView } = await import("@/app/(app)/financials/statements/client-statement-view");
const { buildStatementDocument } = await import("@/lib/finance/statement-document");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

const clients = [
  { id: "c-ada-1", name: "Ada Lovelace", preferredName: null, archived: false },
  { id: "c-ada-2", name: "Ada Lovelace", preferredName: null, archived: false },
  { id: "c-grace", name: "Grace Hopper", preferredName: null, archived: false },
  { id: "c-old", name: "Old Client", preferredName: null, archived: true },
];
const mounted: Array<{ unmount: () => void; el: HTMLElement }> = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.el.remove();
  }
  nav.push.mockClear();
});

function mountFinder(over: Partial<Parameters<typeof ClientFinder>[0]> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(
      createElement(ClientFinder, {
        month: "2026-11",
        monthLabel: "November 2026",
        clients,
        monthVisits: { "c-ada-1": 3, "c-grace": 1 },
        lastVisits: { "c-ada-1": "2026-11-03", "c-ada-2": null },
        ...over,
      }),
    );
  });
  mounted.push({ unmount: () => root.unmount(), el });
  return el;
}
function type(el: HTMLElement, text: string) {
  const input = el.querySelector("input") as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
function press(input: HTMLInputElement, key: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
const optionTexts = (el: HTMLElement) => [...el.querySelectorAll("[role=option]")].map((o) => o.textContent ?? "");

describe("Find a client (mounted)", () => {
  it("is a labelled combobox that matches partial names, in any order", () => {
    const el = mountFinder();
    const input = el.querySelector("input")!;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(el.querySelector("label")?.textContent).toBe("Find a client");
    type(el, "hop gra");
    expect(optionTexts(el)).toHaveLength(1);
    expect(optionTexts(el)[0]).toMatch(/Grace Hopper/);
  });
  it("lists a client with no visit in the month, and says it opens the full history", () => {
    const el = mountFinder();
    type(el, "old");
    expect(optionTexts(el)[0]).toMatch(/Old Client \(archived\)/);
    expect(optionTexts(el)[0]).toMatch(/No visits in November 2026 · opens full history/);
  });
  it("tells two clients with one name apart by last visit, never by an id or contact detail", () => {
    const el = mountFinder();
    type(el, "ada");
    const t = optionTexts(el);
    expect(t).toHaveLength(2);
    expect(t.some((x) => x.includes("Last visit Nov 3, 2026"))).toBe(true);
    expect(t.some((x) => x.includes("No visits"))).toBe(true);
    expect(el.innerHTML).not.toMatch(/c-ada|@|\+\d/);
  });
  it("keyboard: arrows highlight, Enter opens THAT client by id (the month view when it has visits)", () => {
    const el = mountFinder();
    const input = type(el, "grace");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    press(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
    expect(el.querySelector("[role=option]")?.getAttribute("aria-selected")).toBe("true");
    press(input, "Enter");
    expect(nav.push).toHaveBeenCalledWith("/financials/statements/c-grace?month=2026-11");
  });
  it("Enter without a highlighted option opens nothing; a client with no visits opens the full history; same-name clients open their OWN id", () => {
    const el = mountFinder();
    const input = type(el, "ada");
    press(input, "Enter");
    expect(nav.push).not.toHaveBeenCalled();
    press(input, "ArrowDown");
    press(input, "ArrowDown"); // the second Ada: the one with no visit in the month
    press(input, "Enter");
    expect(nav.push).toHaveBeenCalledTimes(1);
    expect(nav.push.mock.calls[0][0]).toBe("/financials/statements/c-ada-2?month=2026-11&view=history");
  });
  it("Escape closes the list; no match shows the empty state with a way to the Clients list", () => {
    const el = mountFinder();
    const input = type(el, "grace");
    press(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    type(el, "zzz");
    expect(el.textContent).toMatch(/No client matches that name/);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/financials/statements?month=2026-11");
  });
  it("does not search email or phone: only the shown name is matched", () => {
    const el = mountFinder();
    type(el, "@");
    expect(optionTexts(el)).toEqual([]);
  });
});

const rows = (over = {}) => ({ clientId: "c-ada-1", name: "Ada Lovelace", visitCount: 2, paidCents: 5000, awaitingCount: 1, ...over });
const reconciliation = { clientsSpendCents: 5000, offDocumentCollectedCents: 0, studioCollectedCents: 5000, offDocumentWithMoney: 0, reconciled: true };
const dirOk = (over: { rows?: ReturnType<typeof rows>[]; reconciliation?: typeof reconciliation } = {}) => {
  const r = over.rows ?? [rows()];
  return { ok: true as const, value: { rows: r, totals: { clientCount: r.length, visitCount: r.reduce((n, x) => n + x.visitCount, 0), paidCents: r.reduce((n, x) => n + x.paidCents, 0), awaitingCount: r.reduce((n, x) => n + x.awaitingCount, 0) }, reconciliation: over.reconciliation ?? reconciliation } };
};
const viewProps = (over = {}) => ({
  month: "2026-11" as const,
  monthLabel: "November 2026",
  maxMonth: "2026-11" as const,
  timezone: "America/Toronto",
  notice: null,
  page: 1,
  format: fmt,
  directory: dirOk(),
  finder: { state: "ok" as const, clients, lastVisits: null },
  ...over,
});
const html = (el: unknown) => renderToStaticMarkup(el as never);

describe("the Clients tab", () => {
  it("shows name, visit count, total paid and payment status per client, links each name to that client's month, and carries the month in every link", () => {
    const out = html(createElement(ClientsView, viewProps()));
    expect(out).toMatch(/Ada Lovelace/);
    expect(out).toMatch(/\$50\.00/);
    expect(out).toMatch(/1 visit awaiting payment confirmation/);
    expect(out).toContain('href="/financials/statements/c-ada-1?month=2026-11"');
    expect(out).toContain('href="/financials/statement?month=2026-11"'); // the Studio tab keeps the month
    expect(out).toMatch(/Visits in this month, by appointment date/);
    expect(out).not.toMatch(/Invoice/); // no control promises what this change does not deliver
  });
  it("is empty with an explanation and the finder still available", () => {
    const out = html(createElement(ClientsView, viewProps({ directory: dirOk({ rows: [] }) })));
    expect(out).toMatch(/No client visits in November 2026/);
    expect(out).toMatch(/Find a client/);
  });
  it("pages without changing the counts or totals, and the paging links keep the month", () => {
    const many = Array.from({ length: 60 }, (_, i) => rows({ clientId: `c${i}`, name: `Client ${String(i).padStart(2, "0")}`, visitCount: 1, paidCents: 100, awaitingCount: 0 }));
    const p1 = html(createElement(ClientsView, viewProps({ directory: dirOk({ rows: many, reconciliation: { ...reconciliation, clientsSpendCents: 6000, studioCollectedCents: 6000 } }), page: 1 })));
    const p3 = html(createElement(ClientsView, viewProps({ directory: dirOk({ rows: many, reconciliation: { ...reconciliation, clientsSpendCents: 6000, studioCollectedCents: 6000 } }), page: 3 })));
    for (const out of [p1, p3]) expect(out).toMatch(/60 clients · 60 visits · \$60\.00 paid/);
    expect(p1).toMatch(/Client 00/);
    expect(p1).not.toMatch(/Client 59/);
    expect(p3).toMatch(/Client 59/);
    expect(p1).toContain('href="/financials/statements?month=2026-11&amp;page=2"');
    expect(p3).toMatch(/Page 3 of 3/);
  });
  it("states the off-document money notice whenever the count is above zero, and not otherwise", () => {
    const withMoney = html(createElement(ClientsView, viewProps({ directory: dirOk({ reconciliation: { ...reconciliation, offDocumentWithMoney: 2, offDocumentCollectedCents: 1000, studioCollectedCents: 6000 } }) })));
    expect(withMoney).toMatch(/2 upcoming bookings have payments recorded/);
    expect(html(createElement(ClientsView, viewProps()))).not.toMatch(/upcoming booking/);
  });
  it("a real mismatch is said plainly; a failed read shows nothing but the reason, never a partial list", () => {
    const bad = html(createElement(ClientsView, viewProps({ directory: dirOk({ reconciliation: { ...reconciliation, reconciled: false } }) })));
    expect(bad).toMatch(/do not match the studio statement/);
    const failed = html(createElement(ClientsView, viewProps({ directory: { ok: false, reason: "too_many_appointments" } })));
    expect(failed).toMatch(/shows nothing rather than part of the record/);
    expect(failed).not.toMatch(/<table/);
  });
  it("a studio too large for the finder says so instead of searching part of it", () => {
    expect(html(createElement(ClientsView, viewProps({ finder: { state: "too_many" } })))).toMatch(/more clients than Find a client can search/);
  });
});

const visit = (over = {}) => ({
  appointmentId: "a1",
  clientId: "c-ada-1",
  startsAt: "2026-11-03T15:00:00Z",
  localDate: "2026-11-03",
  localTime: "10:00",
  serviceName: "Service A",
  scheduledMinutes: 60,
  practitionerId: "p1",
  practitionerName: "Practitioner One",
  eligibility: "treatment" as const,
  feeCandidates: [{ source: "settlement_quote" as const, cents: 6000 }],
  lines: [{ kind: "collected_card_session", cents: 6000 }],
  ...over,
});
const docFor = (visits: unknown[], scope: { kind: "full_history" } | { kind: "month"; month: string } = { kind: "month", month: "2026-11" }, extra: Record<string, unknown> = {}) => {
  const r = buildStatementDocument({
    studioId: "s1",
    identity: { studioName: "Studio One", legalEntityName: null, address: null, contactEmail: null },
    client: { id: "c-ada-1", name: "Ada Lovelace" },
    scope,
    currency: "cad",
    preparedOn: "2026-11-19",
    visits: visits as never,
    ...extra,
  } as never);
  if (!r.ok) throw new Error(r.error);
  return r.document;
};
const stmtProps = (document: ReturnType<typeof docFor>, over = {}) => ({ document, month: "2026-11" as const, monthLabel: "November 2026", maxMonth: "2026-11" as const, view: "month" as const, notice: null, offDocumentWithMoney: 0, format: fmt, ...over });

describe("a client's statement", () => {
  it("shows date, local time, service, duration, practitioner, payment status, methods and amounts for each visit", () => {
    const out = html(createElement(ClientStatementView, stmtProps(docFor([visit()]))));
    for (const t of ["Nov 3, 2026, 10:00", "Service A", "60 min", "Practitioner One", "Paid", "$60.00"]) expect(out).toContain(t);
    expect(out).toMatch(/\$60\.00 paid/);
  });
  it("keeps a visit's split payments together in one row", () => {
    const split = visit({ lines: [{ kind: "collected_card_session", cents: 4000 }, { kind: "collected_cash", cents: 2000 }] });
    const out = html(createElement(ClientStatementView, stmtProps(docFor([split]))));
    expect(out.match(/<tr /g)?.length).toBe(2); // header + ONE visit row
    expect(out).toMatch(/\$40\.00/);
    expect(out).toMatch(/\$20\.00/);
  });
  it("the approved missing-payment wording: $ paid · 1 visit awaiting; the dated line with its fee; and NO balance", () => {
    const unpaid = visit({ appointmentId: "a2", localDate: "2026-11-19", feeCandidates: [{ source: "settlement_quote", cents: 6000 }], lines: [] });
    const out = html(createElement(ClientStatementView, stmtProps(docFor([visit(), unpaid]))));
    expect(out).toMatch(/\$60\.00 paid · 1 visit awaiting payment confirmation/);
    expect(out).toMatch(/Nov 19, 2026 · \$60\.00 fee · No payment recorded/);
    expect(out).toMatch(/Balance due is not shown yet/);
    expect(out).toMatch(/waived, or noted as still owed/);
    expect(out).not.toMatch(/Balance due \$/);
  });
  it("shows a visit with no fee record as 'Fee not recorded', never a number", () => {
    const out = html(createElement(ClientStatementView, stmtProps(docFor([visit({ feeCandidates: [], lines: [] })]))));
    expect(out).toMatch(/Fee not recorded/);
  });
  it("Full history is one click away from the month and back, both carrying the month; Back to Clients restores the month", () => {
    const out = html(createElement(ClientStatementView, stmtProps(docFor([visit()]))));
    expect(out).toContain('href="/financials/statements/c-ada-1?month=2026-11&amp;view=history"');
    expect(out).toContain('href="/financials/statements/c-ada-1?month=2026-11"');
    expect(out).toContain('href="/financials/statements?month=2026-11"');
    expect(out).toMatch(/Back to Clients \(November 2026\)/);
  });
  it("lists Not completed bookings in the full history only, with no amount and outside every total", () => {
    const nc = visit({ appointmentId: "a3", eligibility: "not_completed", feeCandidates: [], lines: [] });
    const history = html(createElement(ClientStatementView, stmtProps(docFor([visit(), nc], { kind: "full_history" }), { view: "history" })));
    expect(history).toMatch(/Not completed/);
    expect(history).toMatch(/never marked completed/);
    const month = html(createElement(ClientStatementView, stmtProps(docFor([visit(), nc]))));
    expect(month).not.toMatch(/never marked completed/);
  });
  it("states the off-document notice whenever the count is above zero", () => {
    expect(html(createElement(ClientStatementView, stmtProps(docFor([visit()]), { offDocumentWithMoney: 1 })))).toMatch(/1 upcoming booking has a payment recorded/);
    expect(html(createElement(ClientStatementView, stmtProps(docFor([visit()]))))).not.toMatch(/upcoming booking/);
  });
  it("shows no client contact detail and no internal id as text", () => {
    const out = html(createElement(ClientStatementView, stmtProps(docFor([visit()]))));
    const visibleText = out.replace(/<[^>]*>/g, " ");
    expect(visibleText).not.toMatch(/c-ada-1|a1\b|@|\+\d{6,}/);
  });
});

describe("read-only, owner-gated, no new write surface", () => {
  const files = [
    "app/(app)/financials/statements/page.tsx",
    "app/(app)/financials/statements/[clientId]/page.tsx",
    "app/(app)/financials/statements/clients-view.tsx",
    "app/(app)/financials/statements/client-statement-view.tsx",
    "app/(app)/financials/statements/client-finder.tsx",
    "app/(app)/financials/statements/statements-chrome.tsx",
    "lib/finance/statement-screen.ts",
    "lib/finance/statement-finder-keys.ts",
  ];
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("none of the new files writes, calls Stripe, mails, texts, uses a service-role client, or declares a server action", () => {
    for (const f of files) {
      const code = strip(read(f));
      for (const bad of [/"use server"/, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/, /from ["']stripe|new Stripe/, /resend|nodemailer|sendgrid|twilio/i, /service[-_]?role|createServiceClient|createAdminClient/i, /\bfetch\(/]) {
        expect(code, f).not.toMatch(bad);
      }
    }
  });
  it("both pages refuse a non-owner BEFORE any read", () => {
    for (const f of ["app/(app)/financials/statements/page.tsx", "app/(app)/financials/statements/[clientId]/page.tsx"]) {
      const code = strip(read(f));
      const gate = code.indexOf('practitioner.role !== "owner"');
      expect(gate, f).toBeGreaterThan(-1);
      for (const reader of ["getStudioPaymentJurisdiction(", "loadStatementDirectory(", "loadFinderClients(", "loadLastVisitDates(", "loadClientStatementRead("]) {
        const at = code.indexOf(reader);
        if (at > -1) expect(gate, `${f} ${reader}`).toBeLessThan(at);
      }
    }
  });
  it("the pages are never cached, and the client id comes from the URL only to be verified by the read module", () => {
    for (const f of ["app/(app)/financials/statements/page.tsx", "app/(app)/financials/statements/[clientId]/page.tsx"]) expect(read(f)).toMatch(/export const dynamic = "force-dynamic"/);
    expect(read("app/(app)/financials/statements/[clientId]/page.tsx")).toMatch(/loadClientStatementRead\(practitioner, studio, currency, clientId/);
  });
});
