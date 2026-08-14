import { describe, expect, it } from "vitest";
import {
  daysBetween,
  disinfectantDueStatus,
  disinfectantStatusLabel,
  isDisinfectantAlert,
} from "@/lib/record-keeping/disinfectant-status";

// PR #280 (Chloe record-keeping feedback): read-time due/overdue status for a
// disinfectant batch's discard/replace-by date. Pure + deterministic ("today"
// is passed in as a studio-tz YYYY-MM-DD), so it is naturally idempotent, a
// computed display, never a stored or sent reminder.

const TODAY = "2026-06-29";

describe("disinfectantDueStatus", () => {
  it("an actually-discarded batch is 'replaced' (no alert, even with a due date)", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: "2026-06-20", discard_due_date: "2026-06-15" },
        TODAY,
      ),
    ).toBe("replaced");
  });

  it("a batch with no discard_due_date is 'none' (legacy rows read safely)", () => {
    expect(
      disinfectantDueStatus({ date_discarded: null, discard_due_date: null }, TODAY),
    ).toBe("none");
  });

  it("a past due date (not yet discarded) is 'overdue'", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: null, discard_due_date: "2026-06-28" },
        TODAY,
      ),
    ).toBe("overdue");
  });

  it("a due date of today is 'due_today'", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: null, discard_due_date: TODAY },
        TODAY,
      ),
    ).toBe("due_today");
  });

  it("a due date within the next 7 days is 'due_soon'", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: null, discard_due_date: "2026-07-05" },
        TODAY,
      ),
    ).toBe("due_soon");
  });

  it("a due date beyond the due-soon window is 'scheduled' (no alert)", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: null, discard_due_date: "2026-07-20" },
        TODAY,
      ),
    ).toBe("scheduled");
  });

  it("malformed dates collapse to 'none' (never throws)", () => {
    expect(
      disinfectantDueStatus(
        { date_discarded: null, discard_due_date: "not-a-date" },
        TODAY,
      ),
    ).toBe("none");
  });
});

describe("isDisinfectantAlert / labels", () => {
  it("only overdue/due_today/due_soon are alerts", () => {
    expect(isDisinfectantAlert("overdue")).toBe(true);
    expect(isDisinfectantAlert("due_today")).toBe(true);
    expect(isDisinfectantAlert("due_soon")).toBe(true);
    expect(isDisinfectantAlert("scheduled")).toBe(false);
    expect(isDisinfectantAlert("replaced")).toBe(false);
    expect(isDisinfectantAlert("none")).toBe(false);
  });
  it("alert labels are human + factual", () => {
    expect(disinfectantStatusLabel("overdue")).toMatch(/overdue/i);
    // Exact pin: the loose /overdue/i above survives any punctuation change, so
    // it could not catch the label drifting. The browser spec asserts this
    // exact text, so the producer and that assertion must agree.
    expect(disinfectantStatusLabel("overdue")).toBe("Overdue: replace now");
    expect(disinfectantStatusLabel("due_today")).toBe("Due today");
    expect(disinfectantStatusLabel("due_soon")).toBe("Due soon");
    expect(disinfectantStatusLabel("scheduled")).toBe("");
  });
});

describe("daysBetween", () => {
  it("counts whole days, sign-aware", () => {
    expect(daysBetween("2026-06-29", "2026-07-06")).toBe(7);
    expect(daysBetween("2026-06-29", "2026-06-29")).toBe(0);
    expect(daysBetween("2026-06-29", "2026-06-28")).toBe(-1);
  });
});
