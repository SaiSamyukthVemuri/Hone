import { describe, expect, it } from "vitest";
import { CANDIDATE_LIMIT, MAX_CANDIDATE_IDS, MAX_SESSION_PAGES, SESSION_PAGE, shouldShowReviewLink } from "@/lib/appointments/review-link";
import { classifyForCheck, type OpenAppointment, type PractitionerLite } from "@/lib/appointments/check-practitioner";

// Sam 2 Nov: the review link is hidden for a solo owner with nothing to review, shown once another practitioner is ACTIVE, and shown in a
// solo studio that still has rows the review page would list. Pending invitations and receptionists are not practitioner rows.
// Insurance V-1 / Privacy L1: the solo check is a count plus bounded candidate reads, never a page-through of every appointment.
type Prac = { id: string; role: string; active: boolean; display_name: string; email: string | null };
type Sess = { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null };
type Flat = Sess & { appointment_id: string } & Record<string, unknown>;
type Appt = { id: string; status?: string; starts_at: string; practitioner_id: string | null; created_by_practitioner_id: string | null; sessions: Sess[] };

// A small in-memory PostgREST: it applies the filters the helper sends (top-level and embedded `sessions.*`), so the test exercises the
// query's meaning and not just its shape.
function db(opts: { pracs: Prac[] | Error; appts?: Appt[] | Error }) {
  const log: { table: string; select: string; head: boolean }[] = [];
  const inSizes: number[] = []; // the FINAL read's id filter (the one that carries starts_at)
  const confirmSizes: number[] = []; // the status-confirmation reads on session hits
  const fromAppointments = (select: string, o?: { count?: string; head?: boolean }) => {
    const top: ((a: Appt) => boolean)[] = [];
    const emb: ((s: Sess) => boolean)[] = [];
    let limit = Infinity;
    let statusIs: string | null = null; // applied only when the query asks for it, so a dropped status filter shows
    const inner = select.includes("sessions!inner");
    log.push({ table: "appointments", select, head: o?.head === true });
    const col = (c: string, f: (v: unknown) => boolean) => {
      if (c.startsWith("sessions.")) emb.push((s) => f((s as never)[c.slice(9)]));
      else top.push((a) => f((a as never)[c]));
    };
    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (c === "studio_id" ? chain : c === "status" ? ((statusIs = v as string), chain) : (col(c, (x) => (x ?? null) === v), chain)),
      neq: (c: string, v: unknown) => (col(c, (x) => x !== v), chain),
      is: (c: string, v: unknown) => (col(c, (x) => (x ?? null) === v), chain),
      not: (c: string, op: string, v: unknown) => (op === "is" ? col(c, (x) => (x ?? null) !== v) : null, chain),
      in: (c: string, v: string[]) => ((select.includes("starts_at") ? inSizes : confirmSizes).push(v.length), col(c, (x) => v.includes(x as string)), chain),
      limit: (n: number) => ((limit = n), chain),
      then: (resolve: (v: unknown) => void) => {
        if (opts.appts instanceof Error) return resolve({ data: null, error: { code: "XX" }, count: null });
        let rows = (opts.appts ?? []).filter((a) => statusIs === null || (a.status ?? "confirmed") === statusIs).filter((a) => top.every((f) => f(a)));
        if (inner) rows = rows.filter((a) => a.sessions.some((s) => emb.every((f) => f(s))));
        if (o?.head) return resolve({ data: null, error: null, count: rows.length });
        resolve({ data: rows.slice(0, limit).map((a) => (inner ? { id: a.id } : a)), error: null });
      },
    };
    return chain;
  };
  // sessions, flattened from the fixtures, answering the sessions-driven A2 scan (keyset on appointment_id, like the real index order)
  const fromSessions = () => {
    const f: ((r: Flat) => boolean)[] = [];
    let limit = Infinity;
    let asc = true;
    const chain: Record<string, unknown> = {
      eq: (c: string, v: unknown) => (c === "studio_id" ? chain : (f.push((r) => (r[c] ?? null) === v), chain)),
      neq: (c: string, v: unknown) => (f.push((r) => r[c] !== v), chain),
      is: (c: string, v: unknown) => (f.push((r) => (r[c] ?? null) === v), chain),
      not: (c: string, op: string, v: unknown) => (op === "is" ? f.push((r) => (r[c] ?? null) !== v) : null, chain),
      gt: (c: string, v: string) => (f.push((r) => (r[c] as string) > v), chain),
      order: (_c: string, o?: { ascending?: boolean }) => ((asc = o?.ascending !== false), chain),
      limit: (n: number) => ((limit = n), chain),
      then: (resolve: (v: unknown) => void) => {
        if (opts.appts instanceof Error) return resolve({ data: null, error: { code: "XX" } });
        const all: Flat[] = (opts.appts ?? []).flatMap((a) => a.sessions.map((x) => ({ appointment_id: a.id, ...x })));
        const rows = all.filter((r) => f.every((g) => g(r))).sort((a, b) => (a.appointment_id < b.appointment_id ? -1 : a.appointment_id > b.appointment_id ? 1 : 0) * (asc ? 1 : -1));
        resolve({ data: rows.slice(0, limit).map((r) => ({ appointment_id: r.appointment_id })), error: null });
      },
    };
    return chain;
  };
  return {
    log,
    inSizes,
    confirmSizes,
    client: {
      from: (table: string) => {
        if (table === "practitioners") {
          log.push({ table, select: "", head: false });
          const r = opts.pracs instanceof Error ? { data: null, error: { code: "XX" } } : { data: opts.pracs, error: null };
          return { select: () => ({ eq: () => Promise.resolve(r) }) };
        }
        if (table === "sessions") {
          log.push({ table, select: "", head: false });
          return { select: () => fromSessions() };
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
    expect(t.log.every((x) => x.table === "practitioners" || x.table === "appointments" || x.table === "sessions")).toBe(true);
  });
  it("(f) a deactivated second practitioner does not count: hidden", async () => {
    const t = db({ pracs: [owner, { ...second, active: false }] });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
  });
  it("V-1 / L1: a busy solo studio costs one count and two bounded candidate reads, never a page-through of its appointments", async () => {
    const many = Array.from({ length: 3000 }, (_, i) => appt({ id: `a${i}`, sessions: [sess("o")] }));
    const t = db({ pracs: [owner], appts: many });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
    // one count, one sessions scan that finds nobody else's chart (so no confirmation read), and the sole practitioner's own-chart read
    expect(t.log.filter((x) => x.table === "appointments")).toHaveLength(2);
    expect(t.log.filter((x) => x.table === "sessions")).toHaveLength(1);
    expect(t.log.filter((x) => x.head)).toHaveLength(1);
  });
  it("V-2b: the candidate limit bounds the final id filter, so its URL stays far under the gateway line limit", async () => {
    // worst case: both reads return LIMIT - 1 distinct rows. A uuid is 36 characters; PostgREST joins them with commas (%2C when encoded).
    const worst = `id=in.(${Array.from({ length: MAX_CANDIDATE_IDS }, () => "00000000-0000-4000-8000-000000000000").join(",")})`;
    expect(MAX_CANDIDATE_IDS).toBe(2 * (CANDIDATE_LIMIT - 1));
    expect(encodeURIComponent(worst).length).toBeLessThan(4096); // half of a typical 8 KB gateway line limit
    expect(CANDIDATE_LIMIT).toBeLessThanOrEqual(50);
    // and the code really sends no more ids than that: 49 + 49 distinct candidates (one short of a full page each)
    const gone = Array.from({ length: CANDIDATE_LIMIT - 1 }, (_, i) => appt({ id: `x${i}`, practitioner_id: "gone", created_by_practitioner_id: "other", sessions: [sess("o")] }));
    const other = Array.from({ length: CANDIDATE_LIMIT - 1 }, (_, i) => appt({ id: `y${i}`, sessions: [sess("gone")] }));
    const t = db({ pracs: [owner], appts: [...gone, ...other] });
    await shouldShowReviewLink("s", t.client);
    expect(t.inSizes).toHaveLength(1);
    expect(t.inSizes[0]).toBeLessThanOrEqual(MAX_CANDIDATE_IDS);
  });
  it("a read that fills the (smaller) candidate page shows the link rather than guess", async () => {
    const flood = Array.from({ length: CANDIDATE_LIMIT }, (_, i) => appt({ id: `f${i}`, practitioner_id: "gone", created_by_practitioner_id: "other", sessions: [sess("o")] }));
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: flood }).client)).toBe(true);
  });
  it("fails toward showing: an unreadable studio, an unreadable appointment list, or a full candidate page never hides the link", async () => {
    expect(await shouldShowReviewLink("s", db({ pracs: new Error("x") }).client)).toBe(true);
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: new Error("x") }).client)).toBe(true);
    const flood = Array.from({ length: 150 }, (_, i) => appt({ id: `g${i}`, practitioner_id: "gone", created_by_practitioner_id: "other", sessions: [sess("o")] }));
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: flood }).client)).toBe(true);
  });
});

// ---- V-1b option B: the sessions-driven A2 must pick the same candidates as the appointments-driven shape it replaced ----
// The previous implementation, kept verbatim as the reference (HEAD before the V-1b change). Same fake, same final classifier.
/* eslint-disable @typescript-eslint/no-explicit-any */
const SELECT_FULL = "id, starts_at, practitioner_id, created_by_practitioner_id, sessions(performed_by_practitioner_id, started_at, deleted_at)";
async function legacyShouldShowReviewLink(studioId: string, client: never): Promise<boolean> {
  const supabase = client as any;
  const pracRes = await supabase.from("practitioners").select("id, role, active, display_name, email").eq("studio_id", studioId);
  if (pracRes.error) return true;
  const practitioners: PractitionerLite[] = (pracRes.data ?? []).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    role: p.role as string,
    active: p.active === true,
    displayName: (p.display_name as string) ?? "",
    email: (p.email as string | null) ?? null,
  }));
  const active = practitioners.filter((p) => p.active);
  if (active.length > 1) return true;
  const soleId = active[0]?.id ?? null;

  // Solo owner: show the link only while the review page would still list something.
  const none = await supabase
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "confirmed")
    .is("practitioner_id", null);
  if (none.error || (none.count ?? 0) > 0) return true;

  const candidates = () =>
    supabase
      .from("appointments")
      .select("id, sessions!inner(performed_by_practitioner_id)")
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .not("practitioner_id", "is", null)
      .is("sessions.deleted_at", null)
      .not("sessions.performed_by_practitioner_id", "is", null)
      .limit(CANDIDATE_LIMIT);
  // Charted by anyone but the sole active practitioner, or charted by them on an appointment that belongs to someone else.
  const reads = soleId
    ? [candidates().neq("sessions.performed_by_practitioner_id", soleId), candidates().neq("practitioner_id", soleId).eq("sessions.performed_by_practitioner_id", soleId)]
    : [candidates()];
  const results = await Promise.all(reads);
  const ids = new Set<string>();
  for (const r of results) {
    if (r.error) return true;
    const rows = (r.data ?? []) as unknown as { id: string }[];
    if (rows.length >= CANDIDATE_LIMIT) return true; // could not read every candidate: do not hide
    for (const row of rows) ids.add(row.id);
  }
  if (ids.size === 0) return false;

  const res = await supabase.from("appointments").select(SELECT_FULL).eq("studio_id", studioId).eq("status", "confirmed").in("id", [...ids]);
  if (res.error) return true;
  const rows = (res.data ?? []) as unknown as {
    id: string;
    starts_at: string;
    practitioner_id: string | null;
    created_by_practitioner_id: string | null;
    sessions: { performed_by_practitioner_id: string | null; started_at: string | null; deleted_at: string | null }[] | null;
  }[];
  const open: OpenAppointment[] = rows.map((r) => {
    const live = (r.sessions ?? []).filter((x) => x.deleted_at === null || x.deleted_at === undefined);
    const starts = live.map((x) => x.started_at).filter((x): x is string => !!x).sort();
    return {
      id: r.id,
      startsAt: r.starts_at,
      practitionerId: r.practitioner_id,
      createdByPractitionerId: r.created_by_practitioner_id,
      performedBy: live.map((x) => x.performed_by_practitioner_id).filter((x): x is string => !!x),
      linkedSessionCount: live.length,
      treatmentStartedAt: starts[0] ?? null,
    };
  });
  return classifyForCheck(open, practitioners, new Date()).length > 0;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function mixedStudio(seed: number, n: number): Appt[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  return Array.from({ length: n }, (_, i) => {
    const sessions: Sess[] = Array.from({ length: Math.floor(r() * 3) }, () =>
      sess(pick(["o", "o", "o", "gone", "p3", null]), r() < 0.15 ? "2030-12-02T00:00:00Z" : null),
    );
    const practitioner = pick(["o", "o", "o", "o", "gone", null]);
    return appt({
      id: `m${String(i).padStart(4, "0")}`,
      status: pick(["confirmed", "confirmed", "confirmed", "cancelled", "pending"]),
      practitioner_id: practitioner,
      created_by_practitioner_id: pick(["o", "o", "other", "gone", null]),
      sessions,
    });
  });
}

describe("V-1b B: sessions-driven A2 is equivalent to the appointments-driven shape", () => {
  it("agrees on 400 seeded mixed studios, sole practitioner and none, across sizes", async () => {
    let shown = 0;
    let hidden = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const n = [0, 1, 3, 8, 20, 60][seed % 6]!;
      // thin out the mix so both outcomes occur: most seeds keep only "clean" rows, some keep the full mix
      const full = mixedStudio(seed, n);
      const clean = full.map((a) => ({ ...a, status: "confirmed", practitioner_id: "o", created_by_practitioner_id: "o", sessions: a.sessions.filter((x) => x.performed_by_practitioner_id === "o" || x.deleted_at) }));
      const appts = seed % 3 === 0 ? full : clean;
      for (const pracs of [[owner], [{ ...owner, active: false }]]) {
        const want = await legacyShouldShowReviewLink("s", db({ pracs, appts }).client);
        const got = await shouldShowReviewLink("s", db({ pracs, appts }).client);
        expect(got, `seed ${seed} n ${n} active ${pracs[0]!.active}`).toBe(want);
        want ? shown++ : hidden++;
      }
    }
    expect(shown).toBeGreaterThan(40);
    expect(hidden).toBeGreaterThan(40);
  });

  it("a single candidate hidden among many non-candidate sessions is still found (cancelled and practitioner-less appointments do not count, but do not hide a real one)", async () => {
    const noise = Array.from({ length: 250 }, (_, i) => appt({ id: `n${String(i).padStart(4, "0")}`, status: "cancelled", sessions: [sess("gone")] }));
    const real = appt({ id: "z9999", sessions: [sess("gone")] });
    const only = db({ pracs: [owner], appts: [...noise, real] });
    expect(await shouldShowReviewLink("s", only.client)).toBe(true);
    expect(await legacyShouldShowReviewLink("s", db({ pracs: [owner], appts: [...noise, real] }).client)).toBe(true);
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: noise }).client)).toBe(false);
  });

  it("only ever asks for sessions another performer charted: a clean solo studio reads no confirmation and no appointment list", async () => {
    const clean = Array.from({ length: 3000 }, (_, i) => appt({ id: `c${i}`, sessions: [sess("o")] }));
    const t = db({ pracs: [owner], appts: clean });
    expect(await shouldShowReviewLink("s", t.client)).toBe(false);
    expect(t.confirmSizes).toEqual([]);
  });

  it("a scan longer than its page cap fails toward SHOWING, never toward hiding", async () => {
    const noise = Array.from({ length: SESSION_PAGE * MAX_SESSION_PAGES + 5 }, (_, i) => appt({ id: `q${String(i).padStart(5, "0")}`, status: "cancelled", sessions: [sess("gone")] }));
    expect(await shouldShowReviewLink("s", db({ pracs: [owner], appts: noise }).client)).toBe(true);
  });

  it("the confirmation filter stays small: never more than the candidate limit of ids per read", async () => {
    const hits = Array.from({ length: SESSION_PAGE }, (_, i) => appt({ id: `h${String(i).padStart(3, "0")}`, status: "cancelled", sessions: [sess("gone")] }));
    const t = db({ pracs: [owner], appts: hits });
    await shouldShowReviewLink("s", t.client);
    expect(t.confirmSizes.length).toBeGreaterThan(0);
    expect(Math.max(...t.confirmSizes)).toBeLessThanOrEqual(CANDIDATE_LIMIT);
  });
});
