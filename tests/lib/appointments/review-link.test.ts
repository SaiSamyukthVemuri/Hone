import { describe, expect, it } from "vitest";
import { shouldShowReviewLink } from "@/lib/appointments/review-link";

// Sam 2 Nov: the review link is hidden for a solo owner with nothing to review, shown once another practitioner is ACTIVE, and shown in a
// solo studio that still has rows the review page would list. Pending invitations and receptionists are not practitioner rows.
// Insurance V-1 / Privacy L1: the solo check is a count plus bounded candidate reads, never a page-through of every appointment.
type Prac = { id: string; role: string; active: boolean; display_name: string; email: string | null };
type Sess = { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null };
type Appt = { id: string; status?: string; starts_at: string; practitioner_id: string | null; created_by_practitioner_id: string | null; sessions: Sess[] };

// A small in-memory PostgREST: it applies the filters the helper sends (top-level and embedded `sessions.*`), so the test exercises the
// query's meaning and not just its shape.
function db(opts: { pracs: Prac[] | Error; appts?: Appt[] | Error }) {
  const log: { table: string; select: string; head: boolean }[] = [];
  const fromAppointments = (select: string, o?: { count?: string; head?: boolean }) => {
    const top: ((a: Appt) => boolean)[] = [];
    const emb: ((s: Sess) => boolean)[] = [];
    let limit = Infinity;
    const inner = select.includes("sessions!inner");
    log.push({ table: "appointments", select, head: o?.head === true });
    const col = (c: string, f: (v: unknown) => boolean) => {
      if (c.startsWith("sessions.")) emb.push((s) => f((s as never)[c.slice(9)]));
      else top.push((a) => f((a as never)[c]));
    };
    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (c === "studio_id" || c === "status" ? chain : (col(c, (x) => (x ?? null) === v), chain)),
      neq: (c: string, v: unknown) => (col(c, (x) => x !== v), chain),
      is: (c: string, v: unknown) => (col(c, (x) => (x ?? null) === v), chain),
      not: (c: string, op: string, v: unknown) => (op === "is" ? col(c, (x) => (x ?? null) !== v) : null, chain),
      in: (c: string, v: string[]) => (col(c, (x) => v.includes(x as string)), chain),
      limit: (n: number) => ((limit = n), chain),
      then: (resolve: (v: unknown) => void) => {
        if (opts.appts instanceof Error) return resolve({ data: null, error: { code: "XX" }, count: null });
        let rows = (opts.appts ?? []).filter((a) => (a.status ?? "confirmed") === "confirmed").filter((a) => top.every((f) => f(a)));
        if (inner) rows = rows.filter((a) => a.sessions.some((s) => emb.every((f) => f(s))));
        if (o?.head) return resolve({ data: null, error: null, count: rows.length });
        resolve({ data: rows.slice(0, limit).map((a) => (inner ? { id: a.id } : a)), error: null });
      },
    };
    return chain;
  };
  return {
    log,
    client: {
      from: (table: string) => {
        if (table === "practitioners") {
          log.push({ table, select: "", head: false });
          const r = opts.pracs instanceof Error ? { data: null, error: { code: "XX" } } : { data: opts.pracs, error: null };
          return { select: () => ({ eq: () => Promise.resolve(r) }) };
        }
        return { select: (s: string, o?: { count?: string; head?: boolean }) => fromAppointments(s, o) };
      },
    } as never,
  };
}

const owner: Prac = { id: "o", role: "owner", active: true, display_name: "Owner", email: "o@x.test" };
const second: Prac = { id: "p2", role: "practitioner", active: true, display_name: "Second", email: "p@x.test" };
const appt = (o: Partial<Appt> & { id: string }): Appt => ({ starts_at: "2031-01-01T10:00:00Z", practitioner_id: "o", created_by_practitioner_id: "o", sessions: [], ...o });
const sess = (by: string | null, deleted: string | null = null): Sess => ({ performed_by_practitioner_id: by, started_at: "2030-12-01T10:00:00Z", deleted_at: deleted });

describe("shouldShowReviewLink", () => {
  it("(a) solo owner, nothing to review: hidden", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1" }), appt({ id: "a2", sessions: [sess("o")] })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("(b) solo owner with an unresolved row (no practitioner recorded): shown", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", practitioner_id: null, created_by_practitioner_id: null })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
  });
  it("(b) solo owner whose booked row was charted by someone else (a former practitioner): shown", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", sessions: [sess("gone")] })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
  });
  it("(b) solo owner charting an appointment that belongs to a former practitioner who also booked it: shown", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", practitioner_id: "gone", created_by_practitioner_id: "gone", sessions: [sess("o")] })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
  });
  it("a candidate the page would NOT list (someone else booked it) does not show the link", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", practitioner_id: "gone", created_by_practitioner_id: "other", sessions: [sess("o")] })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("a soft-deleted chart does not count as something to review", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", sessions: [sess("gone", "2030-12-02T00:00:00Z")] })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("a cancelled appointment without a practitioner is not listed", async () => {
    const t = db({ pracs: [owner], appts: [appt({ id: "a1", status: "cancelled", practitioner_id: null, created_by_practitioner_id: null })] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("(c) owner plus one ACTIVE practitioner: shown, with no appointment read", async () => {
    const t = db({ pracs: [owner, second] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(true);
    expect(t.log.map((x) => x.table)).toEqual(["practitioners"]);
  });
  it("(d)(e) pending invitations and receptionists are not practitioner rows, so a solo owner is still hidden", async () => {
    const t = db({ pracs: [owner] }); // the helper reads neither pending_invitations nor studio_receptionists
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
    expect(t.log.every((x) => x.table === "practitioners" || x.table === "appointments")).toBe(true);
  });
  it("(f) a deactivated second practitioner does not count: hidden", async () => {
    const t = db({ pracs: [owner, { ...second, active: false }] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("V-1 / L1: a busy solo studio costs one count and two bounded candidate reads, never a page-through of its appointments", async () => {
    const many = Array.from({ length: 3000 }, (_, i) => appt({ id: `a${i}`, sessions: [sess("o")] }));
    const t = db({ pracs: [owner], appts: many });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
    expect(t.log.filter((x) => x.table === "appointments")).toHaveLength(3);
    expect(t.log.filter((x) => x.head)).toHaveLength(1);
  });
  it("fails toward showing: an unreadable studio, an unreadable appointment list, or a full candidate page never hides the link", async () => {
    expect(await shouldShowReviewLink("s", db({ pracs: new Error("x") }).client)).toBe(true);
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: new Error("x") }).client)).toBe(true);
    const flood = Array.from({ length: 150 }, (_, i) => appt({ id: `g${i}`, practitioner_id: "gone", created_by_practitioner_id: "other", sessions: [sess("o")] }));
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: flood }).client)).toBe(true);
  });
});
