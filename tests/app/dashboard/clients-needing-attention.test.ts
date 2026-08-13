import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildClientsNeedingAttention,
  type AttentionBlockInput,
  type AttentionSessionInput,
} from "@/lib/dashboard/clients-needing-attention";

// PR #214: Clients needing attention. Recorded-history surfacing for
// the Dashboard Action needed section; never medical advice.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");
const HELPER = read("lib/dashboard/clients-needing-attention.ts");
const PAGE = read("app/(app)/dashboard/page.tsx");
const MODEL = read("lib/dashboard/todo-model.ts");
const LIST = read("app/(app)/dashboard/todo-list.tsx");

function session(
  id: string,
  clientId: string,
  startedAt: string,
  note: string | null = null,
): AttentionSessionInput {
  return {
    id,
    client_id: clientId,
    client_name: `Client ${clientId}`,
    started_at: startedAt,
    next_session_note: note,
  };
}

function block(
  sessionId: string,
  over: Partial<AttentionBlockInput> = {},
): AttentionBlockInput {
  return {
    session_id: sessionId,
    caution_for_next_session: false,
    caution_note: null,
    reaction_type: null,
    tolerance_rating: null,
    ...over,
  };
}

describe("buildClientsNeedingAttention", () => {
  // DASH-TRUTH-01: a plan for the next visit is clinical MEMORY, not work.
  // It was inclusion rule B; it no longer includes anyone on its own. The
  // original invariant this test proved — a client matching more than one
  // signal is counted exactly ONCE — is unchanged and still asserted, and the
  // plan itself is still carried on the row as context.
  it("watch note includes a client; a plan alone does NOT; overlap counts ONCE", () => {
    const out = buildClientsNeedingAttention(
      [
        session("s1", "watchy", "2026-06-10T10:00:00Z"),
        session("s2", "planny", "2026-06-09T10:00:00Z", "Plan text."),
        session("s3", "both", "2026-06-08T10:00:00Z", "Plan too."),
      ],
      [
        block("s1", { caution_for_next_session: true, caution_note: "go easy" }),
        block("s3", { caution_note: "watch this" }),
      ],
    );
    expect(out.totalClients).toBe(2);
    expect(out.clients.map((c) => c.clientId)).not.toContain("planny");
    const both = out.clients.find((c) => c.clientId === "both")!;
    expect(both.hasWatch).toBe(true);
    // still carried, still just once — a watch+plan client is ONE row
    expect(both.hasPlan).toBe(true);
    expect(out.clients.filter((c) => c.clientId === "both")).toHaveLength(1);
  });

  it("clients with no watch/plan/notable reaction are excluded", () => {
    const out = buildClientsNeedingAttention(
      [session("s1", "quiet", "2026-06-10T10:00:00Z")],
      [block("s1", { reaction_type: "none", tolerance_rating: 5 })],
    );
    expect(out.totalClients).toBe(0);
  });

  it("notable reaction on the most recent charted session includes the client", () => {
    const out = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z"),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [
        block("new", { reaction_type: "swelling" }),
        block("old", { caution_note: null, reaction_type: "irritation" }),
      ],
    );
    expect(out.totalClients).toBe(1);
    expect(out.clients[0].notableReactionLabel).toBe("Swelling");
  });

  it("an old notable reaction superseded by a calm newer charted session does not flag", () => {
    const out = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z"),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [
        block("new", { reaction_type: "mild_redness" }),
        block("old", { reaction_type: "swelling" }),
      ],
    );
    expect(out.totalClients).toBe(0);
  });

  it("newest WATCH source wins per client (PR #203 rule)", () => {
    // The recency rule still holds for watch notes: the newest session
    // carrying a caution is the source, and an older one never overrides it.
    const freshWatch = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z"),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [
        block("new", { caution_note: "Newest caution." }),
        block("old", { caution_note: "Stale caution." }),
      ],
    );
    const c = freshWatch.clients[0];
    expect(c.hasWatch).toBe(true);
    expect(c.previewLine).toBe("Newest caution.");
  });

  it("a plan-only newer session does NOT suppress an older watch note", () => {
    // Review 3778510290 — a clinical-safety regression introduced by
    // DASH-TRUTH-01, and a correction to what this file previously asserted.
    //
    // The old rule was "newest session with watch OR PLAN content wins". That
    // was coherent while a plan was itself an inclusion reason: a plan-only
    // newest session hid the older caution, but the client still appeared, for
    // the plan. Once plan stopped being an inclusion signal, the same path
    // dropped the client entirely and a genuine watch note vanished from To do.
    //
    // "Plan is not To-do content in ANY position" has to include supersession.
    const out = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z", "Plan for next visit."),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [block("old", { caution_note: "Go gentler on the chin." })],
    );
    expect(out.totalClients).toBe(1);
    const c = out.clients[0];
    expect(c.hasWatch).toBe(true);
    expect(c.previewLine).toBe("Go gentler on the chin.");
    // the plan is still only context, and its TEXT never travels
    expect(c.hasPlan).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Plan for next visit.");
  });

  it("a newer CAUTION still supersedes an older one, and plans do not interfere", () => {
    const out = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z", "A plan."),
        session("mid", "c1", "2026-06-05T10:00:00Z"),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [
        block("mid", { caution_note: "Middle caution." }),
        block("old", { caution_note: "Oldest caution." }),
      ],
    );
    expect(out.clients[0].previewLine).toBe("Middle caution.");
  });

  it("sorting: watch first, then date desc; a plan-only client never consumes the cap", () => {
    // Was "watch first, then plan-only, then date desc". Plan is no longer a
    // ranking signal, because ordering by it pushed reaction-only clients —
    // actual work — below clients with nothing to do. The surviving invariants
    // are: watch outranks everything, ties break newest-first, and the cap is
    // applied to the included set.
    const out = buildClientsNeedingAttention(
      [
        session("p1", "planA", "2026-06-12T10:00:00Z", "p"), // newest of all
        session("w1", "watchA", "2026-06-01T10:00:00Z"), // oldest of all
        session("r1", "reactB", "2026-06-11T10:00:00Z"),
        session("r2", "reactC", "2026-06-10T10:00:00Z"),
      ],
      [
        block("w1", { caution_note: "w" }),
        block("r1", { reaction_type: "swelling" }),
        block("r2", { reaction_type: "irritation" }),
      ],
      { limit: 2 },
    );
    // watchA leads despite being oldest; reactB beats reactC on date; and the
    // NEWEST client of all is absent because a plan is not work. If plan-only
    // clients were still included they would occupy this entire limit.
    expect(out.clients.map((c) => c.clientId)).toEqual(["watchA", "reactB"]);
    expect(out.totalClients).toBe(3); // unique INCLUDED clients, capped list
    expect(out.totalClients).not.toBe(4);
  });

  it("latest tolerance is surfaced only alongside another reason", () => {
    // The other reason used to be a plan; a plan no longer includes anyone, so
    // this now rides along with a watch note. The invariant is unchanged:
    // tolerance is CONTEXT on an already-included client, never an inclusion
    // rule of its own — we invent no low-tolerance threshold.
    const out = buildClientsNeedingAttention(
      [session("s1", "c1", "2026-06-10T10:00:00Z")],
      [block("s1", { caution_note: "watch", tolerance_rating: 2 })],
    );
    expect(out.clients[0].latestToleranceRating).toBe(2);
    // Tolerance alone never includes a client (tested above via
    // the excluded quiet client with tolerance 5; same with low):
    const lowOnly = buildClientsNeedingAttention(
      [session("s1", "c1", "2026-06-10T10:00:00Z")],
      [block("s1", { tolerance_rating: 1 })],
    );
    expect(lowOnly.totalClients).toBe(0);
  });
});

describe("placement + UI", () => {
  // Dashboard V2 Part 2B: "Clients needing attention" is no longer its own card
  // inside the Practice Snapshot. Its clients now flow through the ONE
  // normalized To-do model as `treatment_memory` rows and render in the single
  // To-do list. The inclusion rules and the loader are unchanged; these pins
  // follow the rendering to where it actually lives.
  it("attention clients reach the unified To-do list as treatment_memory rows", () => {
    expect(MODEL).toMatch(/input\.attention\.clients/);
    expect(MODEL).toMatch(/treatment_memory:\$\{c\.clientId\}/);
    expect(PAGE).toMatch(/attention: clientsNeedingAttention/);
    expect(PAGE).toMatch(/<DashboardTodoList todo=\{dashboardTodo\}/);
  });

  it("every inclusion signal still reaches the row, and so does the tolerance context", () => {
    expect(MODEL).toMatch(/Watch note/);
    // DASH-TRUTH-01: a plan for the next visit is clinical memory, not work, so
    // it is deliberately NOT an inclusion reason any more.
    expect(MODEL).not.toMatch(/reasons\.push\("Plan for next visit"\)/);
    expect(MODEL).toMatch(/Latest recorded reaction:/);
    expect(MODEL).toMatch(/Latest tolerance:/);
  });

  it("the row still links to that client, and the overflow count survives", () => {
    expect(MODEL).toMatch(/href: `\/clients\/\$\{c\.clientId\}`/);
    // The retired card's "+ N more" affordance.
    expect(MODEL).toMatch(/totalClients - input\.attention\.clients\.length/);
    expect(LIST).toMatch(/more not shown/);
  });

  it("the snapshot no longer carries an attention surface at all", () => {
    // The duplicate is gone by construction, not by ordering. Assert on
    // RENDERED surface and on the data dependency — a prose mention in a
    // comment is not an attention surface, and asserting on prose would make
    // this test fail for a documentation edit.
    expect(SNAPSHOT).not.toMatch(/<h[23][^>]*>\s*Action needed/);
    expect(SNAPSHOT).not.toMatch(/Clients needing attention</);
    expect(SNAPSHOT).not.toMatch(/ClientsNeedingAttention/);
    expect(SNAPSHOT).not.toMatch(/export function ActionNeeded/);
  });

  it("empty state uses calm wording and makes no all-clear claim", () => {
    expect(LIST).toMatch(/Nothing to do right now/);
    expect(LIST).not.toMatch(/[Aa]ll clear|[Aa]ll clients are safe|[Nn]o issues/);
    expect(MODEL).not.toMatch(/[Aa]ll clear|[Aa]ll clients are safe/);
  });

  it("no new top-level nav item; not in Record Keeping", () => {
    expect(read("app/(app)/layout.tsx")).not.toMatch(/[Nn]eeding attention/);
    expect(read("app/(app)/records/page.tsx")).not.toMatch(/NeedingAttention/);
  });
});

describe("data/performance + safety", () => {
  it("two batched reads with a documented 200-session cap; read-only", () => {
    expect(HELPER).toMatch(/const SCAN_CAP = 200;/);
    expect(HELPER.match(/\.from\(/g)?.length).toBe(2);
    expect(HELPER).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(PAGE).toMatch(/getClientsNeedingAttention\(studio\.id\)/);
  });

  it("no unsafe wording", () => {
    // Previously sliced SNAPSHOT from "Action needed" — an index that no
    // longer exists, so the sweep silently degraded to one character. Point it
    // at the surfaces that actually render this now.
    for (const src of [MODEL, LIST, HELPER]) {
      for (const p of [
        /diagnos/i,
        /unsafe/i,
        /\bcaused\b/i,
        /recommend/i,
        /\bbest\b/i,
        /should use/i,
        /warning sign/i,
        /problem client/i,
        /treatment success/i,
        /\brisk\b/i,
      ]) {
        expect(src).not.toMatch(p);
      }
    }
  });
});
