import { describe, expect, it } from "vitest";
import { buildClientsNeedingAttention, type AttentionBlockInput, type AttentionSessionInput } from "@/lib/dashboard/clients-needing-attention";
import { buildMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";
import { attentionIdentity } from "@/lib/dashboard/attention-identity";
import { buildNeedsAttention } from "@/lib/dashboard/needs-attention-model";

// Codex P2 (#1356): the clinical reminder's dismissal token came from the session's started_at, so a NEW reaction or caution on the
// same session stayed dismissed. The token now fingerprints the clinical state being reported.

const session: AttentionSessionInput = { id: "s1", client_id: "c1", client_name: "Client One", started_at: "2026-11-01T15:00:00Z", next_session_note: null };
const block = (over: Partial<AttentionBlockInput> = {}): AttentionBlockInput => ({
  session_id: "s1", caution_for_next_session: false, caution_note: null, reaction_type: null, tolerance_rating: null, observation_chips_list: [], ...over,
});
const stamp = (blocks: AttentionBlockInput[], sessions = [session]) => buildClientsNeedingAttention(sessions, blocks).clients[0]?.stateStamp;

describe("clinical reminder dismissal state", () => {
  it("is stable while nothing changed, and carries no readable clinical text", () => {
    const a = stamp([block({ caution_for_next_session: true, caution_note: "Avoid left cheek" })]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(stamp([block({ caution_for_next_session: true, caution_note: "Avoid left cheek" })])).toBe(a);
  });
  it("a caution added to the SAME session changes it", () => {
    const one = stamp([block({ caution_for_next_session: true, caution_note: "Avoid left cheek" })]);
    const two = stamp([block({ caution_for_next_session: true, caution_note: "Avoid left cheek" }), block({ caution_for_next_session: true, caution_note: "Skip neck" })]);
    expect(two).not.toBe(one);
  });
  it("a caution's text edited changes it", () => {
    expect(stamp([block({ caution_for_next_session: true, caution_note: "A" })])).not.toBe(stamp([block({ caution_for_next_session: true, caution_note: "B" })]));
  });
  it("a reaction recorded on the same session changes it", () => {
    const withCaution = block({ caution_for_next_session: true, caution_note: "Avoid left cheek" });
    const base = stamp([withCaution]);
    const reacted = stamp([withCaution, block({ reaction_type: "blistering" })]);
    expect(reacted).not.toBe(base);
  });
  it("end to end: a stored clinical reminder no longer becomes a Needs attention item (HON-65), so it has no dismissal instance to key", () => {
    const todo = {
      items: [
        {
          id: "treatment_memory:c1", kind: "treatment_memory", subject: { kind: "client", id: "c1", label: "Client One" }, reason: "Caution", detail: null,
          action: { label: "Open", href: "/clients/c1" }, priority: 1, occurredAt: "2026-11-01T15:00:00Z", tone: "normal", state: "aaaa1111bbbb2222",
        },
      ],
      hasItems: true, moreCount: 0,
    };
    const out = buildNeedsAttention({
      assistant: buildMissingRecordsAssistant({ unchartedAppointments: [], incompleteIntakes: [], sessions: [] }),
      intakesAwaitingReview: [], todo: todo as never, upcomingVisitClientIds: new Set(),
    });
    expect(out.clients).toEqual([]);
    expect(out.others).toEqual([]);
    expect(out.itemCount).toBe(0);
  });
});
