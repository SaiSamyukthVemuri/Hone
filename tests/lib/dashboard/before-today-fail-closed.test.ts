import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// CLIN-BEFORE-TODAY-F2 — a FAILED read is not an EMPTY history.
// ===========================================================================
//
// THE DEFECT THESE PROVE FIXED
// ----------------------------
// Every read behind the Dashboard Today "Before today" preview destructured
// `data` alone. A failed query therefore arrived as `null`, became `[]`, and
// was rendered as an ANSWER. The practitioner saw no difference between a
// statement timeout and a client whose record is genuinely empty.
//
// The load-bearing shape is NOT an all-or-nothing blank row, which is why it
// went unnoticed: `pickLastTreatment` accepts a session on its live entries
// alone, and those ride along on the SESSIONS read. So when the session_blocks
// read fails for a client with real charted history, `hasHistory` stays TRUE
// and every block-derived field collapses to empty — the row keeps its
// confident voice and prints, over live historical entries:
//
//   "No watch/plan note."
//   "Latest setup: Not recorded"
//   a "Treatment area not recorded" chip
//
// A failed CLIENTS read has the same shape one column over: all three record
// fields read `null`, so the row invents three "missing from record" chips
// about a row nobody read.
//
// WHAT IS PROVEN HERE
// -------------------
// Behavioural, against the REAL loader with a faked PostgREST client. Each
// case changes exactly ONE failure fact and leaves the fixture identical, so a
// suppressed claim is attributable to the injected failure and nothing else.
// Every failure case is paired with the same data read successfully, which is
// what makes the negative controls non-vacuous: the positive assertions prove
// the fixture really does produce the claim being suppressed.
//
// The RENDER contract — that the unavailable state is consulted before either
// authority, so the copy above is unreachable — is pinned structurally at the
// bottom of this file and in tests/app/dashboard/today-two-authority-truth.ts.
// This repo has no DOM harness, and `AppointmentRow` is page-internal; the
// same pairing already proves the identical CLIN-01-B contract on the client
// profile.
//
// No database. No shared local stack. No migration.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const RETURNING = "aaaaaaaa-0000-0000-0000-00000000000a";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";
import { getBeforeTodayPreviews } from "@/lib/dashboard/before-today-previews";
import {
  buildTodayWorkflow,
  type TodayWorkflowInput,
} from "@/lib/dashboard/today-workflow";

afterEach(() => vi.clearAllMocks());

type Row = Record<string, unknown>;

/** How one table's read fails. `error` is PostgREST's channel; `reject` is a
 *  dropped socket, which never sets `error` at all. */
type FailMode = "error" | "reject";

/** Every table the loader touched, so "the failure path was exercised" is a
 *  fact rather than an inference. */
type Issued = string[];

function fakeSupabase(
  tables: Record<string, Row[]>,
  failures: Record<string, FailMode>,
  issued: Issued,
) {
  return {
    from(table: string) {
      issued.push(table);
      const builder: Record<string, unknown> = {};
      for (const verb of ["select", "eq", "in", "is", "order", "limit"]) {
        builder[verb] = () => builder;
      }
      (builder as { then: unknown }).then = (
        resolve: (v: { data: Row[] | null; error: unknown }) => unknown,
        reject: (e: unknown) => unknown,
      ) => {
        const mode = failures[table];
        if (mode === "reject") {
          // The invocation itself fails. `error` is never populated, so a
          // handler that only inspects `error` does not run at all.
          return reject(new Error("fetch failed"));
        }
        if (mode === "error") {
          // The exact production shape: `data: null` with a SQLSTATE.
          return resolve({
            data: null,
            error: {
              code: "57014",
              message: "canceling statement due to statement timeout",
            },
          });
        }
        return resolve({ data: tables[table] ?? [], error: null });
      };
      return builder;
    },
  };
}

// --- Fixtures ---------------------------------------------------------------
// ONE returning client with real charted history: a live electrolysis entry, a
// charted area carrying a watch note, a recorded setup, and a plan note.

const SESSION_ID = "sess-1";

function sessions(): Row[] {
  return [
    {
      id: SESSION_ID,
      client_id: RETURNING,
      started_at: "2026-06-11T00:54:00Z",
      next_session_note: "Start lower on the upper lip.",
      aftercare_and_risks_explained_at: "2026-06-11T01:30:00Z",
      modality: "electrolysis",
      // Live entries ride on the SESSIONS read, which is why a blocks-only
      // failure leaves `hasHistory` true and the row confident.
      electrolysis_entries: [{ hairs_treated: 40, deleted_at: null }],
      laser_entries: [],
    },
  ];
}

function blocks(): Row[] {
  return [
    {
      id: "block-1",
      session_id: SESSION_ID,
      sort_order: 0,
      block_name: "Chin",
      primary_area: "Chin",
      side: null,
      custom_area_detail: null,
      mode: "thermo",
      apilus_modality: null,
      energy_level: 14,
      minutes_performed: 30,
      probe_label: "Ballet F3",
      probe_lot_number: "460941",
      machine_frequency: "27.12 MHz",
      tolerance_rating: 3,
      reaction_type: null,
      reaction_notes: null,
      caution_for_next_session: true,
      caution_note: "Went deeper than planned; check sensitivity.",
      electrolysis_entries: [],
    },
  ];
}

/** A complete client record: nothing here is legitimately missing, so any
 *  "missing from record" chip in these cases is fabricated. */
function clients(): Row[] {
  return [
    {
      id: RETURNING,
      date_of_birth: "1990-04-02",
      phone: "555-0100",
      address: "12 Example Street",
    },
  ];
}

function areas(): Row[] {
  return [
    {
      id: "area-1",
      session_block_id: "block-1",
      studio_id: STUDIO,
      area: "Chin",
      laterality: "not_applicable",
      display_order: 0,
      created_at: "2026-06-11T00:55:00Z",
    },
  ];
}

/** The whole roster read succeeding. Each case below removes exactly one. */
function allTables(): Record<string, Row[]> {
  return {
    sessions: sessions(),
    session_blocks: blocks(),
    clients: clients(),
    session_block_areas: areas(),
  };
}

async function load(
  failures: Record<string, FailMode> = {},
  tables: Record<string, Row[]> = allTables(),
) {
  const issued: Issued = [];
  vi.mocked(createClient).mockResolvedValue(
    fakeSupabase(tables, failures, issued) as unknown as Awaited<
      ReturnType<typeof createClient>
    >,
  );
  const previews = await getBeforeTodayPreviews(STUDIO, [RETURNING]);
  const preview = previews.get(RETURNING) ?? null;
  // Through the REAL row derivation, exactly as the dashboard builds it, so
  // these assertions are about what the row holds and not about an
  // intermediate the row never sees.
  const input: TodayWorkflowInput = {
    appointmentId: "appt-1",
    clientId: RETURNING,
    clientName: "A Client",
    timeLabel: "9:00 AM",
    status: "confirmed",
    serviceName: "Electrolysis 30",
    unavailable: preview?.unavailable ?? false,
    hasHistory: preview?.hasHistory ?? false,
    nextVisitNote: preview?.nextVisitNote ?? null,
    cautionNote: preview?.cautionNote ?? null,
    setupLine: preview?.setupLine ?? null,
    reminders: preview?.reminders ?? [],
    intake: "reviewed",
    charting: "none",
  };
  const [item] = buildTodayWorkflow([input]).items;
  return { preview, item, issued };
}

// ---------------------------------------------------------------------------
// A. THE POSITIVE CONTROL — every read returns, and the row keeps its claims.
// ---------------------------------------------------------------------------

describe("A — a successful read is untouched by this change", () => {
  it("renders the full positive clinical state", async () => {
    const { preview, item, issued } = await load();
    expect(preview).not.toBeNull();
    expect(preview!.unavailable).toBe(false);
    expect(item.unavailable).toBe(false);
    expect(item.hasHistory).toBe(true);
    // The three facts the failure cases below suppress. Each is present HERE,
    // from the same fixture, which is what makes their absence there evidence.
    expect(item.caution).toBe(
      "Chin: Went deeper than planned; check sensitivity.",
    );
    expect(item.remember).toBe("Start lower on the upper lip.");
    expect(item.setup).toBe("27.12 MHz · Ballet F3 · Thermolysis · EL 14");
    // A complete record produces no chips at all.
    expect(item.missingRecords).toEqual([]);
    // All four reads were issued.
    expect(new Set(issued)).toEqual(
      new Set(["sessions", "session_blocks", "clients", "session_block_areas"]),
    );
  });
});

// ---------------------------------------------------------------------------
// B. GENUINE EMPTINESS — a read that returns zero rows still licenses absence.
// ---------------------------------------------------------------------------

describe("B — a successful EMPTY read still licenses the existing absence", () => {
  it("no sessions at all is a proven no-history client, not unavailable", async () => {
    const { preview, item } = await load(
      {},
      { ...allTables(), sessions: [], session_blocks: [], session_block_areas: [] },
    );
    expect(preview!.unavailable).toBe(false);
    expect(item.unavailable).toBe(false);
    expect(item.hasHistory).toBe(false);
  });

  it("a charted session with NO watch or plan note still says so", async () => {
    const quiet = blocks().map((b) => ({
      ...b,
      caution_for_next_session: false,
      caution_note: null,
    }));
    const { preview, item } = await load(
      {},
      {
        ...allTables(),
        sessions: sessions().map((s) => ({ ...s, next_session_note: null })),
        session_blocks: quiet,
      },
    );
    // The exact state that renders "No watch/plan note." — still reachable,
    // because the reads answered.
    expect(item.unavailable).toBe(false);
    expect(item.hasHistory).toBe(true);
    expect(item.caution).toBeNull();
    expect(item.remember).toBeNull();
    // ...and the setup is still recorded, so this is a note gap, not a blackout.
    expect(preview!.setupLine).toBe("27.12 MHz · Ballet F3 · Thermolysis · EL 14");
  });

  it("a genuinely blank client record still produces its three chips", async () => {
    const { item } = await load(
      {},
      {
        ...allTables(),
        clients: [{ id: RETURNING, date_of_birth: null, phone: null, address: null }],
      },
    );
    expect(item.unavailable).toBe(false);
    expect(item.missingRecords).toEqual([
      "Date of birth missing from record",
      "Phone missing from record",
      "Address missing from record",
    ]);
  });

  it("an empty structured-areas read is normal legacy data, not a failure", async () => {
    // Blocks predating migration 0128 carry no area rows. Zero rows here is an
    // answer, and the legacy primary_area label stands.
    const { preview, item } = await load({}, { ...allTables(), session_block_areas: [] });
    expect(item.unavailable).toBe(false);
    expect(item.hasHistory).toBe(true);
    expect(preview!.cautionNote).toBe(
      "Chin: Went deeper than planned; check sensitivity.",
    );
  });
});

// ---------------------------------------------------------------------------
// C + D + E. THE FAILURES. One read fails; its siblings all return.
// ---------------------------------------------------------------------------

const CLINICAL_READS = ["sessions", "session_blocks", "session_block_areas"] as const;

// Which reads are reachable once THIS one has failed. Each downstream read is
// keyed by the ids the previous one returned, so a failure upstream removes the
// question rather than answering it.
const EXPECTED_ISSUED: Record<(typeof CLINICAL_READS)[number], string[]> = {
  sessions: ["sessions", "clients"],
  session_blocks: ["sessions", "session_blocks", "clients"],
  session_block_areas: [
    "sessions",
    "session_blocks",
    "clients",
    "session_block_areas",
  ],
};

describe("C/D/E — each clinical read fails ALONE and fails CLOSED", () => {
  for (const table of CLINICAL_READS) {
    for (const mode of ["error", "reject"] as const) {
      it(`${table} — ${mode} — makes no clinical claim`, async () => {
        const { preview, item, issued } = await load({ [table]: mode });

        // The failure path was actually exercised. Which SIBLINGS were issued
        // is derived from the pipeline, not guessed: a failed sessions read
        // leaves no session ids to ask blocks about, and no blocks leaves no
        // block ids to ask areas about. Every read that COULD run, did.
        expect(issued).toContain(table);
        expect(new Set(issued)).toEqual(new Set(EXPECTED_ISSUED[table]));

        expect(preview!.unavailable).toBe(true);
        expect(item.unavailable).toBe(true);

        // NO COERCION. None of these may license absence.
        expect(preview!.rememberLine).toBeNull();
        expect(preview!.setupLine).toBeNull();
        expect(preview!.recordsLine).toBe("");
        expect(item.remember).toBeNull();
        expect(item.caution).toBeNull();
        expect(item.setup).toBeNull();

        // The FABRICATED clinical chips are gone. The client record read fine,
        // and it is complete, so nothing survives here at all.
        expect(item.missingRecords).not.toContain("Treatment area not recorded");
        expect(item.missingRecords).not.toContain("Probe lot missing");
        expect(item.missingRecords).not.toContain("Aftercare not marked");
        expect(item.missingRecords).toEqual([]);
      });
    }
  }
});

describe("THE LOAD-BEARING REPRODUCTION — blocks fail over live history", () => {
  it("prints no watch/plan or setup ABSENCE while historical entries remain", async () => {
    // The session and its live electrolysis entry are still there and still
    // read successfully; only the block read fails.
    const { preview, item } = await load({ session_blocks: "error" });

    // Proof the history really is present in the read that succeeded: the same
    // fixture with the block read working produces the positive state.
    const ok = await load();
    expect(ok.item.hasHistory).toBe(true);
    expect(ok.item.caution).not.toBeNull();
    expect(ok.item.setup).not.toBeNull();

    // And with the block read failed, the row states nothing.
    expect(item.unavailable).toBe(true);
    // `hasHistory` is false here for the SAME reason it is false for a
    // first-visit client — which is exactly why `unavailable` has to be read
    // first, and why nothing may branch on this alone.
    expect(item.hasHistory).toBe(false);
    expect(preview!.setupLine).toBeNull();
    expect(item.caution).toBeNull();
    expect(item.remember).toBeNull();
    expect(item.setup).toBeNull();
    expect(item.missingRecords).toEqual([]);
  });
});

describe("THE CLIENTS READ — missing-record chips are never invented", () => {
  for (const mode of ["error", "reject"] as const) {
    it(`${mode} — fabricates no missing-from-record chip`, async () => {
      const { preview, item, issued } = await load({ clients: mode });
      expect(issued).toContain("clients");

      // Not a clinical blackout: the clinical reads answered, so the clinical
      // claims stand. Degrading gracefully, not going dark.
      expect(preview!.unavailable).toBe(false);
      expect(item.unavailable).toBe(false);
      expect(item.hasHistory).toBe(true);
      expect(item.caution).toBe(
        "Chin: Went deeper than planned; check sensitivity.",
      );
      expect(item.setup).toBe("27.12 MHz · Ballet F3 · Thermolysis · EL 14");

      // ...and NOT ONE chip about a client row that was never read.
      expect(item.missingRecords).toEqual([]);
      for (const chip of item.missingRecords) {
        expect(chip).not.toMatch(/missing from record/);
      }
    });
  }

  it("the fabrication is real without the fix: every field reads null", async () => {
    // The same shape a failed read produced BEFORE this change — an empty rows
    // array — still yields all three chips, because a client genuinely absent
    // from the result set is indistinguishable from a blank record. That is
    // precisely why the outcome of the read, and not its emptiness, decides.
    const { item } = await load({}, { ...allTables(), clients: [] });
    expect(item.missingRecords).toEqual([
      "Date of birth missing from record",
      "Phone missing from record",
      "Address missing from record",
    ]);
  });
});

describe("independence — a clinical failure does not suppress TRUE record chips", () => {
  it("blocks fail, clients read fine and IS incomplete: the chips stand", async () => {
    const { item } = await load(
      { session_blocks: "error" },
      {
        ...allTables(),
        clients: [{ id: RETURNING, date_of_birth: null, phone: null, address: null }],
      },
    );
    expect(item.unavailable).toBe(true);
    // These come from a read that answered, about facts that are true.
    expect(item.missingRecords).toEqual([
      "Date of birth missing from record",
      "Phone missing from record",
      "Address missing from record",
    ]);
  });

  it("both fail: no clinical claim AND no record claim", async () => {
    const { item } = await load({ session_blocks: "error", clients: "reject" });
    expect(item.unavailable).toBe(true);
    expect(item.missingRecords).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SOURCE CONTRACT — the mechanical property that regressed.
// ---------------------------------------------------------------------------

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const PREVIEWS = read("lib/dashboard/before-today-previews.ts");

describe("no read on this path may discard its error again", () => {
  it("every read goes through the fail-closed wrapper", () => {
    expect(PREVIEWS.match(/\.from\(/g)?.length).toBe(4);
    expect(PREVIEWS.match(/readRows\(\s*\n?\s*"before_today_previews_/g)?.length).toBe(4);
    // The exact shape that lost the error: `data` destructured on its own from
    // an awaited query.
    expect(PREVIEWS).not.toMatch(/const \{ data[^}]*\} = await supabase/);
  });

  it("both failure channels are handled, not just PostgREST's", () => {
    expect(PREVIEWS).toMatch(/const \{ data, error \} = await run\(\)/);
    expect(PREVIEWS).toMatch(/if \(error\) \{/);
    expect(PREVIEWS).toMatch(/\} catch \{/);
  });

  it("the clients read is classified apart from the clinical ones", () => {
    expect(PREVIEWS).toMatch(
      /const clinicalUnavailable =\s*\n?\s*sessionsRead\.failed \|\| blocksRead\.failed \|\| areasFailed;/,
    );
    expect(PREVIEWS).toMatch(/const clientRecordUnavailable = clientsRead\.failed;/);
  });

  it("logs classification only — never a message, an id, or clinical text", () => {
    const logger = PREVIEWS.slice(
      PREVIEWS.indexOf("function logReadFailure("),
      PREVIEWS.indexOf("async function readRows("),
    );
    expect(logger.length).toBeGreaterThan(100);
    expect(logger).toMatch(/code: typeof code === "string" \? code : null/);
    expect(logger).not.toMatch(/\.message/);
    expect(logger).not.toMatch(/client_id|session_id|caution|notes|phone|address/);
  });
});
