// Three values the client profile keeps DISTINCT (Sam / Insurance). Pure and client-safe.
//
//   Last visit              the LATER of the newest non-void PAST session and the newest COMPLETED
//                           PAST appointment. It says when the client was last here, charted or not.
//   Last charted treatment  today's pickLastTreatment (lib/sessions/clinical-summary.ts): what was
//                           actually done. NOT computed here, so the two can never be one function.
//   Next appointment        the nearest FUTURE confirmed appointment.
//
// Neither replaces the other: a newer uncharted visit moves Last visit and leaves Last charted
// treatment alone; a future appointment is never a visit. "Past" is judged against `nowMs` (an instant),
// so no browser clock or timezone decides it; callers format the result in the studio timezone.

export type VisitSession = { id: string; started_at: string; record_status: string | null };
export type VisitAppointment = { id: string; starts_at: string; status: string };

export type LastVisit =
  | { kind: "session"; id: string; at: string }
  | { kind: "appointment"; id: string; at: string };

export type NextAppointment = { id: string; at: string };

function ms(iso: string): number {
  return Date.parse(iso);
}

export function pickLastVisit(args: {
  sessions: ReadonlyArray<VisitSession>;
  appointments: ReadonlyArray<VisitAppointment>;
  nowMs: number;
}): LastVisit | null {
  let best: { rank: number; at: number; visit: LastVisit } | null = null;
  const consider = (visit: LastVisit, at: number, rank: number) => {
    // Later wins; on an exact tie the SESSION wins (rank 1): it is the same visit, and it opens the chart.
    if (!best || at > best.at || (at === best.at && rank > best.rank)) best = { rank, at, visit };
  };
  for (const s of args.sessions) {
    const t = ms(s.started_at);
    if (s.record_status === "void" || !Number.isFinite(t) || t > args.nowMs) continue;
    consider({ kind: "session", id: s.id, at: s.started_at }, t, 1);
  }
  for (const a of args.appointments) {
    const t = ms(a.starts_at);
    if (a.status !== "completed" || !Number.isFinite(t) || t > args.nowMs) continue;
    consider({ kind: "appointment", id: a.id, at: a.starts_at }, t, 0);
  }
  return best ? (best as { visit: LastVisit }).visit : null;
}

export function pickNextAppointment(args: {
  appointments: ReadonlyArray<VisitAppointment>;
  nowMs: number;
}): NextAppointment | null {
  let best: { t: number; a: VisitAppointment } | null = null;
  for (const a of args.appointments) {
    const t = ms(a.starts_at);
    if (a.status !== "confirmed" || !Number.isFinite(t) || t <= args.nowMs) continue;
    if (!best || t < best.t) best = { t, a };
  }
  return best ? { id: best.a.id, at: best.a.starts_at } : null;
}
