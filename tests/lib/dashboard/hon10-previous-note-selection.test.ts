import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// HON-10 (DASH-NOTE-02): the "previous relevant note" must be a PREVIOUS note.
// ===========================================================================
//
// Two selections feed it, and each showed the wrong thing in a way the existing
// suites could not see, because every fixture put the prior history strictly
// before an unbounded read:
//
//   1. The dashboard Today roster ("Before today" Remember line). The read had
//      no boundary at all: no appointment, no time. A visit's OWN session (the
//      one created when it was started), or any session after it, was a
//      candidate, so the line could quote this visit's note back as the one
//      from last time. The sibling prep loader on the same page already keys
//      every request by appointment and excludes it.
//
//   2. The same read is `LIMIT 400` over the WHOLE roster, newest first. A full
//      window cuts the oldest history of exactly the clients with the longest
//      records, and a client with nothing inside it was rendered as having no
//      history. A truncated read proves nothing about what it cut off.
//
//   3. The chart page's "From last visit" read ignored its error (`{ data }`
//      only), so a failed read rendered as no note, and ordered by started_at
//      alone, which is not a total order.
//
// Synthetic data only.

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getBeforeTodayPreviews } from "@/lib/dashboard/before-today-previews";

afterEach(() => vi.clearAllMocks());

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "aaaaaaaa-0000-0000-0000-00000000000a";
const OTHER = "bbbbbbbb-0000-0000-0000-00000000000b";
const APPT = "cccccccc-0000-0000-0000-00000000000c";
const APPT_2 = "dddddddd-0000-0000-0000-00000000000d";
// The visit being prepared for starts at 15:00Z.
const STARTS_AT = "2026-10-20T15:00:00.000Z";
const YESTERDAY = "2026-10-19T15:00:00.000Z";

type Row = Record<string, unknown>;

function session(id: string, clientId: string, startedAt: string, over: Row = {}): Row {
  return {
    id,
    client_id: clientId,
    started_at: startedAt,
    record_status: "draft",
    next_session_note: null,
    aftercare_and_risks_explained_at: null,
    modality: "electrolysis",
    appointment_id: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...over,
  };
}

function block(id: string, sessionId: string, cautionNote: string | null): Row {
  return {
    id,
    session_id: sessionId,
    sort_order: 0,
    block_name: "Chin",
    primary_area: "Chin",
    side: null,
    custom_area_detail: null,
    mode: "thermo",
    apilus_modality: null,
    energy_level: 14,
    minutes_performed: 30,
    probe_label: "Probe",
    probe_lot_number: null,
    machine_frequency: null,
    tolerance_rating: 3,
    reaction_type: null,
    reaction_notes: null,
    caution_for_next_session: cautionNote != null,
    caution_note: cautionNote,
    electrolysis_entries: [],
  };
}

// A PostgREST stand-in that honours `.limit(n)` on the sessions read, because
// truncation is the whole subject of one case.
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let cap = Number.POSITIVE_INFINITY;
      const builder: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "order", "lt", "neq"]) {
        builder[verb] = () => builder;
      }
      builder.limit = (n: number) => {
        cap = n;
        return builder;
      };
      (builder as { then: unknown }).then = (
        resolve: (v: { data: Row[]; error: null }) => unknown,
      ) => resolve({ data: (tables[table] ?? []).slice(0, cap), error: null });
      return builder;
    },
  };
}

function use(tables: Record<string, Row[]>) {
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase({
      session_block_areas: [],
      clients: [
        { id: CLIENT, date_of_birth: "1990-04-02", phone: "555-0100", address: "1 Example St" },
        { id: OTHER, date_of_birth: "1991-05-03", phone: "555-0101", address: "2 Example St" },
      ],
      ...tables,
    }) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
}

const VISIT = { clientId: CLIENT, appointmentId: APPT, startsAt: STARTS_AT };

// The third argument is the roster's visits. On the unrepaired loader it is
// ignored, which is the defect: the cases below fail by assertion, not by type.
const previewFor = (visits: ReadonlyArray<typeof VISIT>) =>
  (getBeforeTodayPreviews as unknown as (
    s: string,
    ids: string[],
    v: ReadonlyArray<typeof VISIT>,
  ) => ReturnType<typeof getBeforeTodayPreviews>)(
    STUDIO,
    [...new Set(visits.map((v) => v.clientId))],
    visits,
  );

describe("1 — the dashboard preview is the note BEFORE this visit", () => {
  it("this visit's own session (linked by appointment, started a little early) is not the previous note", async () => {
    use({
      sessions: [
        session("own", CLIENT, "2026-10-20T14:58:00.000Z", {
          appointment_id: APPT,
          next_session_note: "THIS VISIT plan",
        }),
        session("prior", CLIENT, YESTERDAY, { next_session_note: "PRIOR plan" }),
      ],
      session_blocks: [block("b-own", "own", "THIS VISIT caution"), block("b-prior", "prior", "PRIOR caution")],
    });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(JSON.stringify(p)).not.toMatch(/THIS VISIT/);
    expect(p?.nextVisitNote).toBe("PRIOR plan");
    expect(p?.cautionNote).toMatch(/PRIOR caution/);
  });

  it("a session that starts after the visit's start is not a previous note", async () => {
    use({
      sessions: [
        session("later", CLIENT, "2026-10-20T17:00:00.000Z", { next_session_note: "LATER plan" }),
        session("prior", CLIENT, YESTERDAY, { next_session_note: "PRIOR plan" }),
      ],
      session_blocks: [block("b-prior", "prior", "PRIOR caution")],
    });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(JSON.stringify(p)).not.toMatch(/LATER/);
    expect(p?.nextVisitNote).toBe("PRIOR plan");
  });

  it("control: an unlinked session earlier the same day IS previous, and so is the prior day's when nothing else exists", async () => {
    use({
      sessions: [
        session("earlier-today", CLIENT, "2026-10-20T09:00:00.000Z", { next_session_note: "EARLIER TODAY plan" }),
        session("prior", CLIENT, YESTERDAY, { next_session_note: "PRIOR plan" }),
      ],
      session_blocks: [block("b-et", "earlier-today", null), block("b-prior", "prior", null)],
    });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(p?.nextVisitNote).toBe("EARLIER TODAY plan");
  });

  it("two bookings the same day: the boundary is the EARLIEST, and both own sessions are excluded", async () => {
    use({
      sessions: [
        session("own-2", CLIENT, "2026-10-20T18:00:00.000Z", {
          appointment_id: APPT_2,
          next_session_note: "SECOND VISIT plan",
        }),
        session("own-1", CLIENT, "2026-10-20T15:01:00.000Z", {
          appointment_id: APPT,
          next_session_note: "FIRST VISIT plan",
        }),
        session("prior", CLIENT, YESTERDAY, { next_session_note: "PRIOR plan" }),
      ],
      session_blocks: [block("b-prior", "prior", null)],
    });
    const p = (
      await previewFor([VISIT, { clientId: CLIENT, appointmentId: APPT_2, startsAt: "2026-10-20T18:00:00.000Z" }])
    ).get(CLIENT);
    expect(JSON.stringify(p)).not.toMatch(/VISIT plan/);
    expect(p?.nextVisitNote).toBe("PRIOR plan");
  });

  it("another client's visit never bounds this client's history", async () => {
    use({
      sessions: [session("prior", CLIENT, YESTERDAY, { next_session_note: "PRIOR plan" })],
      session_blocks: [block("b-prior", "prior", null)],
    });
    const p = (
      await previewFor([{ clientId: OTHER, appointmentId: APPT, startsAt: "2026-10-01T00:00:00.000Z" }, VISIT])
    ).get(CLIENT);
    expect(p?.nextVisitNote).toBe("PRIOR plan");
  });
});

describe("2 — a full 400-row window is not proof that a client has no history", () => {
  const filler = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) =>
      session(`f-${i}`, OTHER, new Date(Date.parse("2026-10-18T00:00:00.000Z") - i * 3_600_000).toISOString()),
    );
  const oldNote = session("old", CLIENT, "2025-01-01T10:00:00.000Z", { next_session_note: "OLD plan" });

  it("a client whose only history was cut off by the cap is unavailable, not 'no history'", async () => {
    // 400 newer rows fill the cap; CLIENT's one real session is row 401.
    use({ sessions: [...filler(400), oldNote], session_blocks: [block("b-old", "old", "OLD caution")] });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(p?.unavailable).toBe(true);
    expect(p?.hasHistory).toBe(false);
  });

  it("control: one row under the cap, the same client genuinely has no history in the window", async () => {
    use({ sessions: filler(399), session_blocks: [] });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(p?.unavailable).toBe(false);
    expect(p?.hasHistory).toBe(false);
  });

  it("control: a full window still serves a client whose newest note is inside it", async () => {
    use({
      sessions: [session("recent", CLIENT, YESTERDAY, { next_session_note: "RECENT plan" }), ...filler(399)],
      session_blocks: [block("b-recent", "recent", "RECENT caution")],
    });
    const p = (await previewFor([VISIT])).get(CLIENT);
    expect(p?.unavailable).toBe(false);
    expect(p?.nextVisitNote).toBe("RECENT plan");
  });
});

describe("3a — the loader behind the chart page 'From last visit'", () => {
  type Call = [string, ...unknown[]];
  function stub(result: { data: unknown; error: { code?: string } | null } | "throw") {
    const calls: Call[] = [];
    const b: Record<string, unknown> = {};
    for (const m of ["from", "select", "eq", "is", "neq", "not", "lt", "order", "limit"]) {
      b[m] = (...a: unknown[]) => {
        calls.push([m, ...a]);
        return b;
      };
    }
    b.maybeSingle = async () => {
      if (result === "throw") throw new Error("socket closed");
      return result;
    };
    vi.mocked(createClient).mockResolvedValue(b as unknown as Awaited<ReturnType<typeof createClient>>);
    return calls;
  }
  const input = { studioId: STUDIO, clientId: CLIENT, before: STARTS_AT };

  it("a failed read is unavailable, not 'no note', and logs the code only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stub({ data: null, error: { code: "57014" } });
    const { loadPreviousVisitNote } = await import("@/lib/sessions/previous-visit-note");
    expect(await loadPreviousVisitNote(input)).toEqual({ note: null, unavailable: true });
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("57014");
    expect(line).not.toContain(CLIENT);
    log.mockRestore();
  });

  it("a rejected read is unavailable too", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    stub("throw");
    const { loadPreviousVisitNote } = await import("@/lib/sessions/previous-visit-note");
    expect((await loadPreviousVisitNote(input)).unavailable).toBe(true);
    log.mockRestore();
  });

  it("no earlier note is an answer, not a failure; the note is trimmed", async () => {
    const { loadPreviousVisitNote } = await import("@/lib/sessions/previous-visit-note");
    stub({ data: null, error: null });
    expect(await loadPreviousVisitNote(input)).toEqual({ note: null, unavailable: false });
    stub({ data: { id: "s", started_at: YESTERDAY, next_session_note: "  PRIOR plan \n" }, error: null });
    expect(await loadPreviousVisitNote(input)).toEqual({ note: "PRIOR plan", unavailable: false });
  });

  it("is scoped to this studio and client, live and non-void, strictly earlier, ordered started_at then id", async () => {
    const { loadPreviousVisitNote } = await import("@/lib/sessions/previous-visit-note");
    const calls = stub({ data: null, error: null });
    await loadPreviousVisitNote(input);
    expect(calls).toContainEqual(["eq", "studio_id", STUDIO]);
    expect(calls).toContainEqual(["eq", "client_id", CLIENT]);
    expect(calls).toContainEqual(["is", "deleted_at", null]);
    expect(calls).toContainEqual(["neq", "record_status", "void"]);
    expect(calls).toContainEqual(["lt", "started_at", STARTS_AT]);
    const orders = calls.filter((c) => c[0] === "order");
    expect(orders).toEqual([
      ["order", "started_at", { ascending: false }],
      ["order", "id", { ascending: false }],
    ]);
  });
});

describe("3 — the chart page 'From last visit' read", () => {
  const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
  const LOADER_PATH = "lib/sessions/previous-visit-note.ts";
  const loaderSource = () => {
    try {
      return read(LOADER_PATH);
    } catch {
      return "";
    }
  };

  it("never discards the read's error: the page no longer takes `data` alone, and the loader reports unavailable", () => {
    expect(PAGE).not.toMatch(/const \{ data: previousWithNote \}/);
    expect(loaderSource()).toMatch(/unavailable/);
  });

  it("orders by started_at THEN id, the shared recency rule, so a tie has one answer", () => {
    const src = `${PAGE}\n${loaderSource()}`;
    expect(src).toMatch(
      /\.order\("started_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
    );
  });
});
