import { describe, expect, it } from "vitest";
import {
  buildClientsNeedingAttention,
  type AttentionBlockInput,
  type AttentionSessionInput,
} from "@/lib/dashboard/clients-needing-attention";
import { TODO_DISCLOSURE_LIMIT } from "@/lib/dashboard/todo-model";

// Review 3779063515 — A To-do row is ranked by the timestamp of the SIGNAL
// that put it on the list.
//
// Plans had already been removed from inclusion and from the explicit sort
// key, but ranking still read a generic "latest session date", so a plan-only
// session kept reaching the order through that alias. At the bounded
// disclosure limit this is clinical-safety relevant: a stale caution carried
// on a fresh plan date can displace a newer genuine caution entirely.
//
// The public field is now `attentionDate` and there is no second name holding
// the client's newest session date, so the alias cannot come back.

const PLAN = "A plan for the next visit.";

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

const d = (day: number) =>
  `2026-01-${String(day).padStart(2, "0")}T10:00:00.000Z`;

describe("attention rank comes from the signal, never from a plan", () => {
  it("R1 older caution + newer plan-only session: included, ranked by the CAUTION date", () => {
    const out = buildClientsNeedingAttention(
      [
        session("a2", "A", d(10), PLAN), // plan-only, newest
        session("a1", "A", d(1)), // the caution
      ],
      [block("a1", { caution_note: "Go gentler." })],
    );
    expect(out.totalClients).toBe(1);
    expect(out.clients[0].attentionDate).toBe(d(1));
    expect(out.clients[0].attentionDate).not.toBe(d(10));
  });

  it("R2 a newer genuine caution outranks a stale one wearing a fresh plan date", () => {
    const out = buildClientsNeedingAttention(
      [
        session("a2", "A", d(10), PLAN),
        session("a1", "A", d(1)),
        session("b1", "B", d(5)),
      ],
      [
        block("a1", { caution_note: "A caution." }),
        block("b1", { caution_note: "B caution." }),
      ],
    );
    expect(out.clients.map((c) => c.clientId)).toEqual(["B", "A"]);
  });

  it("R3 a newer caution supersedes an older one and supplies the rank date", () => {
    const out = buildClientsNeedingAttention(
      [session("a2", "A", d(8)), session("a1", "A", d(1))],
      [
        block("a2", { caution_note: "Newer caution." }),
        block("a1", { caution_note: "Older caution." }),
      ],
    );
    expect(out.clients[0].attentionDate).toBe(d(8));
    expect(out.clients[0].previewLine).toBe("Newer caution.");
  });

  it("R4 a plan-only client is not included at all", () => {
    const out = buildClientsNeedingAttention(
      [session("a1", "A", d(10), PLAN)],
      [block("a1")],
    );
    expect(out.totalClients).toBe(0);
  });

  it("R5 reaction + newer plan: rank comes from the REACTION date", () => {
    const out = buildClientsNeedingAttention(
      [
        session("a2", "A", d(10), PLAN),
        session("a1", "A", d(6)),
      ],
      [block("a1", { reaction_type: "swelling" })],
    );
    expect(out.totalClients).toBe(1);
    expect(out.clients[0].attentionDate).toBe(d(6));
  });

  it("R6 watch + reaction: the rank date is one of the real signals, never the plan", () => {
    const out = buildClientsNeedingAttention(
      [
        session("a3", "A", d(20), PLAN),
        session("a2", "A", d(9)),
        session("a1", "A", d(2)),
      ],
      [
        block("a2", { reaction_type: "swelling" }),
        block("a1", { caution_note: "A caution." }),
      ],
    );
    const c = out.clients[0];
    expect(c.hasWatch).toBe(true);
    expect([d(9), d(2)]).toContain(c.attentionDate);
    expect(c.attentionDate).not.toBe(d(20));
  });

  it("THE P1: at the real disclosure limit, a plan date cannot displace a newer caution", () => {
    // Reproduces the reported defect at the ACTUAL bound rather than with two
    // rows. `filler` clients occupy the limit with cautions dated d(2). Client
    // A holds a STALE caution d(1) plus a very fresh plan-only session d(28);
    // client B holds a genuinely newer caution d(3).
    //
    // Under the old ranking A carried d(28) and sorted first, pushing B out of
    // the returned window entirely. Under signal ranking A carries d(1) and is
    // last, so B survives.
    const limit = TODO_DISCLOSURE_LIMIT;
    const sessions: AttentionSessionInput[] = [];
    const blocks: AttentionBlockInput[] = [];

    for (let i = 0; i < limit - 1; i++) {
      const id = `F${i}`;
      sessions.push(session(`f${i}`, id, d(2)));
      blocks.push(block(`f${i}`, { caution_note: `filler ${i}` }));
    }
    // A: stale caution, very fresh plan-only session
    sessions.push(session("a2", "A", d(28), PLAN));
    sessions.push(session("a1", "A", d(1)));
    blocks.push(block("a1", { caution_note: "A stale caution." }));
    // B: genuinely newer caution
    sessions.push(session("b1", "B", d(3)));
    blocks.push(block("b1", { caution_note: "B newer caution." }));

    // newest-first, as the loader supplies
    sessions.sort((x, y) => (x.started_at < y.started_at ? 1 : -1));

    const out = buildClientsNeedingAttention(sessions, blocks, { limit });
    const ids = out.clients.map((c) => c.clientId);

    expect(out.totalClients).toBe(limit + 1);
    expect(out.clients).toHaveLength(limit);
    // B's genuine newer caution is present, and in fact leads
    expect(ids).toContain("B");
    expect(ids[0]).toBe("B");
    // A is the one displaced, because its real signal is the oldest
    expect(ids).not.toContain("A");
    // and A's rank date was never the plan's
    const all = buildClientsNeedingAttention(sessions, blocks, {
      limit: limit + 5,
    });
    expect(all.clients.find((c) => c.clientId === "A")!.attentionDate).toBe(d(1));
  });

  it("no field on the row carries the client's newest unrelated session date", () => {
    // Structural: the alias is gone, not merely unused.
    const out = buildClientsNeedingAttention(
      [session("a2", "A", d(10), PLAN), session("a1", "A", d(1))],
      [block("a1", { caution_note: "Go gentler." })],
    );
    const row = out.clients[0] as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("latestDate");
    expect(JSON.stringify(out)).not.toContain(d(10));
  });
});
