import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  findBlockingPriceConflicts,
  priceConflictNotice,
} from "@/lib/billing/client-pricing-conflicts";
import { resolveAuthoritativeSessionPaymentAmount } from "@/lib/billing/session-payment-amount";

const T = "2026-11-16";
const row = (service_name: string, effective_from: string, price_cents: number) => ({ service_name, effective_from, price_cents });

describe("same-date price conflict notice (display only)", () => {
  it("reports a same-service, same-date pair with different prices", () => {
    const c = findBlockingPriceConflicts([row("Laser", T, 0), row("Laser", T, 12000)], T);
    expect(c).toEqual([{ serviceName: "Laser", effectiveFrom: T }]);
    const msg = priceConflictNotice(c[0]);
    expect(msg).toContain("Laser");
    expect(msg).toContain(T);
    expect(msg).toContain("blocked");
    expect(msg).toContain("Delete");
  });

  it("does not report a different date, the same price, another service, an older tie that a newer row supersedes, or a future tie", () => {
    expect(findBlockingPriceConflicts([row("Laser", T, 0), row("Laser", "2026-11-01", 12000)], T)).toEqual([]);
    expect(findBlockingPriceConflicts([row("Laser", T, 5000), row("Laser", T, 5000)], T)).toEqual([]);
    expect(findBlockingPriceConflicts([row("Laser", T, 0), row("Facial", T, 9000)], T)).toEqual([]);
    expect(findBlockingPriceConflicts([row("Laser", "2026-10-01", 0), row("Laser", "2026-10-01", 9000), row("Laser", T, 7000)], T)).toEqual([]);
    expect(findBlockingPriceConflicts([row("Laser", "2026-12-01", 0), row("Laser", "2026-12-01", 9000)], T)).toEqual([]);
  });

  it("DEPENDENCY GUARD: for every case below, the helper reports a conflict exactly when the resolver this tree ships refuses the price as ambiguous", () => {
    // This is what makes the merge-after-#1483 dependency mechanical. #1483 makes an explicit $0 client price a real price; before
    // it, the resolver ignores $0 rows. If this tree's resolver and this helper disagree on ANY case, the notice would tell an owner
    // something the payment path does not do (or stay silent about a block that exists), so this test fails and #1499 cannot be
    // merged until the resolver (#1483) is in its base. Do not weaken it by removing the $0 cases.
    const cases: [string, ReturnType<typeof row>[]][] = [
      ["$0 + positive, same date", [row("Laser", T, 0), row("Laser", T, 12000)]],
      ["two $0, same date", [row("Laser", T, 0), row("Laser", T, 0)]],
      ["$0 today, positive older", [row("Laser", T, 0), row("Laser", "2026-11-01", 12000)]],
      ["positive today, $0 older", [row("Laser", T, 12000), row("Laser", "2026-11-01", 0)]],
      ["two different positives, same date, name case/space differs", [row("Laser", T, 4000), row("laser ", T, 12000)]],
      ["two equal positives, same date", [row("Laser", T, 5000), row("Laser", T, 5000)]],
      ["superseded older tie", [row("Laser", "2026-10-01", 0), row("Laser", "2026-10-01", 9000), row("Laser", T, 7000)]],
      ["future tie", [row("Laser", "2026-12-01", 0), row("Laser", "2026-12-01", 9000), row("Laser", T, 7000)]],
      ["other service tie", [row("Facial", T, 0), row("Facial", T, 9000), row("Laser", T, 7000)]],
    ];
    for (const [label, rows] of cases) {
      const r = resolveAuthoritativeSessionPaymentAmount({
        service: { name: "Laser", price_cents: 15000 },
        appointmentDurationMinutes: 30,
        customPricing: rows.map((x) => ({ ...x, notes: null })),
        today: T,
      });
      const reported = findBlockingPriceConflicts(rows, T).some((c) => c.serviceName.trim().toLowerCase() === "laser");
      expect({ label, reported }).toEqual({ label, reported: r.kind === "ambiguous_custom_pricing" });
    }
  });

  it("counts an explicit $0 as a price (the #1483 rule): a $0 and a positive row on one date are a conflict, two $0 rows are not", () => {
    expect(findBlockingPriceConflicts([row("Laser", T, 0), row("Laser", T, 9000)], T)).toHaveLength(1);
    expect(findBlockingPriceConflicts([row("Laser", T, 0), row("Laser", T, 0)], T)).toEqual([]);
  });

  it("logs nothing, and its output carries no price amount", () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const c = findBlockingPriceConflicts([row("Laser", T, 12345), row("Laser", T, 6789)], T);
    const text = JSON.stringify(c) + priceConflictNotice(c[0]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const amount of ["12345", "6789", "123.45", "67.89"]) expect(text).not.toContain(amount);
    spies.forEach((s) => s.mockRestore());
    const src = readFileSync("lib/billing/client-pricing-conflicts.ts", "utf8");
    expect(src).not.toMatch(/console\.|logger|throw new Error/);
  });

  it("is wired on the client page next to the existing delete path, and changes no action or schema", () => {
    const page = readFileSync("app/(app)/clients/[id]/page.tsx", "utf8");
    expect(page).toContain("findBlockingPriceConflicts(pricing, today)");
    expect(page).toContain("deleteClientPricingAction");
    const actions = readFileSync("app/(app)/clients/[id]/actions.ts", "utf8");
    expect(actions).not.toContain("client-pricing-conflicts");
  });
});
