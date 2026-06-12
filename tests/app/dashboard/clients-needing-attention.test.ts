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
  it("watch note includes a client; plan includes a client; both count ONCE", () => {
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
    expect(out.totalClients).toBe(3);
    const both = out.clients.find((c) => c.clientId === "both")!;
    expect(both.hasWatch).toBe(true);
    expect(both.hasPlan).toBe(true);
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

  it("newest watch/plan source wins per client (PR #203 rule)", () => {
    const out = buildClientsNeedingAttention(
      [
        session("new", "c1", "2026-06-10T10:00:00Z", "Newest plan."),
        session("old", "c1", "2026-06-01T10:00:00Z"),
      ],
      [block("old", { caution_note: "stale caution" })],
    );
    const c = out.clients[0];
    expect(c.hasPlan).toBe(true);
    expect(c.hasWatch).toBe(false); // stale caution never overrides
    expect(c.previewLine).toBe("Newest plan.");
  });

  it("sorting: watch first, then plan-only, then date desc; cap with + N more data", () => {
    const out = buildClientsNeedingAttention(
      [
        session("p1", "planA", "2026-06-10T10:00:00Z", "p"),
        session("w1", "watchA", "2026-06-01T10:00:00Z"),
        session("p2", "planB", "2026-06-11T10:00:00Z", "p"),
      ],
      [block("w1", { caution_note: "w" })],
      { limit: 2 },
    );
    expect(out.clients.map((c) => c.clientId)).toEqual(["watchA", "planB"]);
    expect(out.totalClients).toBe(3); // unique clients, capped list
  });

  it("latest tolerance is surfaced only alongside another reason", () => {
    const out = buildClientsNeedingAttention(
      [session("s1", "c1", "2026-06-10T10:00:00Z", "plan")],
      [block("s1", { tolerance_rating: 2 })],
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
  it("the card sits in the Action needed section alongside the existing cards", () => {
    const action = SNAPSHOT.slice(SNAPSHOT.indexOf("Action needed"));
    expect(action).toMatch(/Clients needing attention/);
    expect(action).toMatch(/Incomplete procedure records/);
    expect(action).toMatch(/Missing probe lot numbers/);
    expect(action).toMatch(/Aftercare not marked/);
    expect(action).toMatch(/Based on recorded watch notes and next-visit plans\./);
  });

  it("list rows carry name, date, badges, preview, and Open client link", () => {
    expect(SNAPSHOT).toMatch(/Watch note/);
    expect(SNAPSHOT).toMatch(/Plan for next visit/);
    expect(SNAPSHOT).toMatch(/Latest recorded reaction:/);
    expect(SNAPSHOT).toMatch(/Latest tolerance:/);
    expect(SNAPSHOT).toMatch(/href=\{`\/clients\/\$\{c\.clientId\}`\}/);
    expect(SNAPSHOT).toMatch(/\+ \{attention\.totalClients - attention\.clients\.length\} more/);
  });

  it("empty state uses the required wording (no all-clear claims)", () => {
    expect(SNAPSHOT).toMatch(/Nothing flagged from recorded treatment history\./);
    expect(SNAPSHOT).not.toMatch(/[Aa]ll clear|[Aa]ll clients are safe|[Nn]o issues/);
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
    for (const src of [SNAPSHOT.slice(SNAPSHOT.indexOf("Action needed")), HELPER]) {
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
