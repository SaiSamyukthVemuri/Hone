import { describe, expect, it } from "vitest";
import { computeOverdueDisinfectantAlerts } from "@/lib/notifications/disinfectant-alerts";

// Unit proof for the pure overdue-disinfactant alert computation. It is the ONLY
// place that turns records + studio-local "today" into Notification Centre alerts,
// and it delegates the overdue decision to disinfectantDueStatus (single source of
// truth). Deterministic: no clock, no DB.

const rec = (over: Partial<{ id: string; disinfectant_name: string | null; discard_due_date: string | null; date_discarded: string | null }> = {}) => ({
  id: over.id ?? "rec-1",
  disinfectant_name: over.disinfectant_name ?? "Barbicide jar",
  discard_due_date: over.discard_due_date ?? null,
  date_discarded: over.date_discarded ?? null,
});

const TODAY = "2026-07-13";

describe("computeOverdueDisinfectantAlerts: eligibility", () => {
  it("emits nothing for a future (scheduled) due date", () => {
    expect(
      computeOverdueDisinfectantAlerts([rec({ discard_due_date: "2026-08-01" })], TODAY),
    ).toHaveLength(0);
  });
  it("emits nothing for due-today (only overdue alerts)", () => {
    expect(
      computeOverdueDisinfectantAlerts([rec({ discard_due_date: TODAY })], TODAY),
    ).toHaveLength(0);
  });
  it("emits nothing for a missing due date", () => {
    expect(
      computeOverdueDisinfectantAlerts([rec({ discard_due_date: null })], TODAY),
    ).toHaveLength(0);
  });
  it("emits nothing for an already-replaced (discarded) record, even if past due", () => {
    expect(
      computeOverdueDisinfectantAlerts(
        [rec({ discard_due_date: "2026-06-01", date_discarded: "2026-06-02" })],
        TODAY,
      ),
    ).toHaveLength(0);
  });
  it("emits one alert for a record one day overdue", () => {
    const alerts = computeOverdueDisinfectantAlerts(
      [rec({ discard_due_date: "2026-07-12" })],
      TODAY,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].daysOverdue).toBe(1);
    expect(alerts[0].daysOverdueText).toBe("1 day overdue");
  });
  it("emits one alert for a record many days overdue with correct text", () => {
    const alerts = computeOverdueDisinfectantAlerts(
      [rec({ discard_due_date: "2026-07-01" })],
      TODAY,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].daysOverdue).toBe(12);
    expect(alerts[0].daysOverdueText).toBe("12 days overdue");
  });
});

describe("computeOverdueDisinfectantAlerts: timezone boundary", () => {
  it("a due date equal to a LATER local today is overdue; equal to today is not", () => {
    const record = rec({ discard_due_date: "2026-07-13" });
    // Studio still on 2026-07-13 → due today → not overdue.
    expect(computeOverdueDisinfectantAlerts([record], "2026-07-13")).toHaveLength(0);
    // Studio has rolled to 2026-07-14 → now overdue by 1 day.
    const rolled = computeOverdueDisinfectantAlerts([record], "2026-07-14");
    expect(rolled).toHaveLength(1);
    expect(rolled[0].daysOverdue).toBe(1);
  });
});

describe("computeOverdueDisinfectantAlerts: identity / severity / action / privacy", () => {
  it("uses a stable dedup identity derived from the record id", () => {
    const a = computeOverdueDisinfectantAlerts([rec({ id: "abc", discard_due_date: "2026-07-01" })], TODAY);
    const b = computeOverdueDisinfectantAlerts([rec({ id: "abc", discard_due_date: "2026-07-01" })], TODAY);
    expect(a[0].id).toBe("disinfectant-overdue:abc");
    expect(a[0].id).toBe(b[0].id); // stable across recomputes → no duplicate
  });
  it("is a warning-severity operational alert linking to the disinfectants records section", () => {
    const [alert] = computeOverdueDisinfectantAlerts([rec({ discard_due_date: "2026-07-01" })], TODAY);
    expect(alert.severity).toBe("warning");
    expect(alert.href).toBe("/records?section=disinfectants");
    expect(alert.actionLabel).toBe("Review disinfectant records");
    expect(alert.title).toBe("Replace disinfectant now");
    expect(alert.body).toBe("A disinfectant record is overdue for replacement.");
  });
  it("carries only non-sensitive operational context, no client/PHI/db-id in title or body", () => {
    const [alert] = computeOverdueDisinfectantAlerts(
      [rec({ id: "rec-secret-uuid", disinfectant_name: "Cavicide", discard_due_date: "2026-07-01" })],
      TODAY,
    );
    // The record id is the dedup key only; it must never appear in displayed copy.
    for (const text of [alert.title, alert.body, alert.contextLabel, alert.daysOverdueText]) {
      expect(text).not.toContain("rec-secret-uuid");
    }
    expect(alert.contextLabel).toBe("Cavicide");
  });
  it("falls back to a generic label when the name is blank", () => {
    const [alert] = computeOverdueDisinfectantAlerts(
      [rec({ disinfectant_name: "   ", discard_due_date: "2026-07-01" })],
      TODAY,
    );
    expect(alert.contextLabel).toBe("Disinfectant");
  });
});

describe("computeOverdueDisinfectantAlerts: multiple + ordering", () => {
  it("emits one alert per overdue record, most-overdue first, deterministic tiebreak", () => {
    const alerts = computeOverdueDisinfectantAlerts(
      [
        rec({ id: "b", discard_due_date: "2026-07-12" }), // 1 day
        rec({ id: "a", discard_due_date: "2026-07-01" }), // 12 days
        rec({ id: "c", discard_due_date: "2026-08-01" }), // future → excluded
        rec({ id: "d", discard_due_date: "2026-06-01", date_discarded: "2026-06-05" }), // replaced → excluded
      ],
      TODAY,
    );
    expect(alerts.map((a) => a.recordId)).toEqual(["a", "b"]);
  });
});
