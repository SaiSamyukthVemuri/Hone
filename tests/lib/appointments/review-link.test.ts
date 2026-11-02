import { describe, expect, it } from "vitest";
import { shouldShowReviewLink } from "@/lib/appointments/review-link";

// Sam 2 Nov: the review link is hidden for a solo owner with nothing to review, shown once another practitioner is ACTIVE, and shown in a
// solo studio that still has rows the review page would list. Pending invitations and receptionists are not practitioner rows.
type Prac = { id: string; role: string; active: boolean; display_name: string; email: string | null };
type Appt = { id: string; starts_at: string; practitioner_id: string | null; created_by_practitioner_id: string | null; sessions: { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null }[] };

function db(opts: { pracs: Prac[] | Error; appts?: Appt[] | Error | ((page: number) => Appt[]) }) {
  const reads: string[] = [];
  const thenable = (table: string, result: () => { data: unknown; error: unknown }) => {
    const chain: Record<string, unknown> = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
        return () => chain;
      },
    });
    reads.push(table);
    return chain;
  };
  let page = 0;
  return {
    reads,
    client: {
      from: (table: string) =>
        table === "practitioners"
          ? thenable(table, () => (opts.pracs instanceof Error ? { data: null, error: { code: "XX" } } : { data: opts.pracs, error: null }))
          : thenable(table, () => {
              const a = opts.appts ?? [];
              if (a instanceof Error) return { data: null, error: { code: "XX" } };
              return { data: typeof a === "function" ? a(page++) : a, error: null };
            }),
    } as never,
  };
}

const owner: Prac = { id: "o", role: "owner", active: true, display_name: "Owner", email: "o@x.test" };
const second: Prac = { id: "p2", role: "practitioner", active: true, display_name: "Second", email: "p@x.test" };
const appt = (o: Partial<Appt> & { id: string }): Appt => ({ starts_at: "2031-01-01T10:00:00Z", practitioner_id: "o", created_by_practitioner_id: "o", sessions: [], ...o });

describe("shouldShowReviewLink", () => {
  it("(a) solo owner, nothing to review: hidden", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1" })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("(b) solo owner with an unresolved row (no practitioner recorded): shown", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", practitioner_id: null, created_by_practitioner_id: null })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
  });
  it("(b) solo owner whose booked row was charted by someone else (a former practitioner): shown", async () => {
    const t = db({
      pracs: [owner],
      appts: [appt({ id: "a1", sessions: [{ performed_by_practitioner_id: "gone", started_at: "2030-12-01T10:00:00Z", deleted_at: null }] })],
    });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
  });
  it("a soft-deleted chart does not count as something to review", async () => {
    const t = db({
      pracs: [owner],
      appts: [appt({ id: "a1", sessions: [{ performed_by_practitioner_id: "gone", started_at: null, deleted_at: "2030-12-02T00:00:00Z" }] })],
    });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("(c) owner plus one ACTIVE practitioner: shown, with no appointment read", async () => {
    const t = db({ pracs: [owner, second] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
    expect(t.reads).toEqual(["practitioners"]);
  });
  it("(d)(e) pending invitations and receptionists are not practitioner rows, so a solo owner is still hidden", async () => {
    const t = db({ pracs: [owner] }); // the helper reads neither pending_invitations nor studio_receptionists
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
    expect(t.reads.every((x) => x === "practitioners" || x === "appointments")).toBe(true);
  });
  it("(f) a deactivated second practitioner does not count: hidden", async () => {
    const t = db({ pracs: [owner, { ...second, active: false }] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("fails toward showing: an unreadable studio, an unreadable appointment list, or an incomplete read never hides the link", async () => {
    expect(await shouldShowReviewLink("s", db({ pracs: new Error("x") }).client)).toBe(true);
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: new Error("x") }).client)).toBe(true);
    const full = (page: number) => Array.from({ length: 500 }, (_, i) => appt({ id: `a${page}-${i}` }));
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: full }).client)).toBe(true); // 4 full pages, none flagged, not complete
  });
});
