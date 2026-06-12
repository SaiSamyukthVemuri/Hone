import { createClient } from "@/lib/supabase/server";
import {
  isReactionType,
  reactionTypeLabel,
  type ReactionType,
} from "@/lib/sessions/clinical-response";

// PR #214: "Clients needing attention" for the Dashboard's Action
// needed section. Recorded-history surfacing, never medical advice:
// a client is flagged ONLY because their recorded notes flag them.
//
// V1 inclusion rules (any one includes the client; each client is
// counted ONCE):
//   A. Watch/caution note: the client's newest session carrying any
//      watch/plan content has a caution flag or caution note (the
//      same newest-with-content rule as the PR #203 pre-client
//      watch/plan source, applied per client).
//   B. Plan for next visit: that same source has a next_session_note.
//   C. Notable recorded reaction on the most recent charted session
//      (moderate redness, swelling, sensitivity, irritation; the
//      existing reaction vocabulary, no new values).
//   Low tolerance is NOT an inclusion rule (no threshold exists in
//   the codebase, and we do not invent one); the latest tolerance is
//   shown only when the client is already included.
//   Record-completeness reminders are deliberately excluded: the
//   existing action cards already cover them, and this card focuses
//   on clinical treatment memory.
//
// Performance: TWO batched reads (the studio's most recent charted
// sessions, capped at 200, plus their treatment areas), grouped in
// memory; never one query per client.

export const NOTABLE_REACTIONS: ReadonlyArray<ReactionType> = [
  "moderate_redness",
  "swelling",
  "sensitivity",
  "irritation",
];

export type AttentionSessionInput = {
  id: string;
  client_id: string;
  client_name: string;
  started_at: string;
  next_session_note: string | null;
};

export type AttentionBlockInput = {
  session_id: string;
  caution_for_next_session: boolean;
  caution_note: string | null;
  reaction_type: string | null;
  tolerance_rating: number | null;
};

export type ClientNeedingAttention = {
  clientId: string;
  clientName: string;
  latestDate: string;
  hasWatch: boolean;
  hasPlan: boolean;
  notableReactionLabel: string | null;
  latestToleranceRating: number | null;
  previewLine: string;
};

export type ClientsNeedingAttention = {
  totalClients: number;
  clients: ClientNeedingAttention[];
  // True when the underlying scan hit its cap; counts are then "of
  // the most recent scanned sessions", documented in the UI helper.
  scanCapped: boolean;
};

// Pure: fold the batched rows into the per-client attention list.
// Sessions must be ordered newest-first.
export function buildClientsNeedingAttention(
  sessionsNewestFirst: ReadonlyArray<AttentionSessionInput>,
  blocks: ReadonlyArray<AttentionBlockInput>,
  options: { limit?: number; scanCapped?: boolean } = {},
): ClientsNeedingAttention {
  const limit = options.limit ?? 5;
  const blocksBySession = new Map<string, AttentionBlockInput[]>();
  for (const b of blocks) {
    const list = blocksBySession.get(b.session_id) ?? [];
    list.push(b);
    blocksBySession.set(b.session_id, list);
  }

  type Acc = {
    clientName: string;
    latestDate: string;
    hasWatch: boolean;
    hasPlan: boolean;
    watchText: string | null;
    planText: string | null;
    notableReactionLabel: string | null;
    latestToleranceRating: number | null;
    sourceFound: boolean;
    latestChartedSeen: boolean;
  };
  const byClient = new Map<string, Acc>();

  for (const s of sessionsNewestFirst) {
    const acc = byClient.get(s.client_id) ?? {
      clientName: s.client_name,
      latestDate: s.started_at,
      hasWatch: false,
      hasPlan: false,
      watchText: null,
      planText: null,
      notableReactionLabel: null,
      latestToleranceRating: null,
      sourceFound: false,
      latestChartedSeen: false,
    };
    const sessionBlocks = blocksBySession.get(s.id) ?? [];

    // Newest charted session only: notable reaction + latest tolerance.
    if (!acc.latestChartedSeen && sessionBlocks.length > 0) {
      acc.latestChartedSeen = true;
      for (const b of sessionBlocks) {
        if (
          !acc.notableReactionLabel &&
          b.reaction_type &&
          isReactionType(b.reaction_type) &&
          (NOTABLE_REACTIONS as readonly string[]).includes(b.reaction_type)
        ) {
          acc.notableReactionLabel = reactionTypeLabel(b.reaction_type);
        }
        if (acc.latestToleranceRating == null && b.tolerance_rating != null) {
          acc.latestToleranceRating = b.tolerance_rating;
        }
      }
    }

    // Newest session with ANY watch/plan content wins (the PR #203
    // pre-client rule, per client). Earlier sessions never override.
    if (!acc.sourceFound) {
      const cautionBlock = sessionBlocks.find(
        (b) => b.caution_for_next_session || b.caution_note?.trim(),
      );
      const plan = s.next_session_note?.trim() || null;
      if (cautionBlock || plan) {
        acc.sourceFound = true;
        acc.hasWatch = !!cautionBlock;
        acc.watchText =
          cautionBlock?.caution_note?.trim() ||
          (cautionBlock ? "Previously noted" : null);
        acc.hasPlan = !!plan;
        acc.planText = plan;
      }
    }
    byClient.set(s.client_id, acc);
  }

  const included = [...byClient.entries()]
    .filter(
      ([, a]) => a.hasWatch || a.hasPlan || a.notableReactionLabel !== null,
    )
    .map(([clientId, a]) => ({
      clientId,
      clientName: a.clientName,
      latestDate: a.latestDate,
      hasWatch: a.hasWatch,
      hasPlan: a.hasPlan,
      notableReactionLabel: a.notableReactionLabel,
      latestToleranceRating: a.latestToleranceRating,
      previewLine:
        a.watchText ??
        a.planText ??
        (a.notableReactionLabel
          ? `Latest recorded reaction: ${a.notableReactionLabel}`
          : ""),
    }))
    .sort((x, y) => {
      if (x.hasWatch !== y.hasWatch) return x.hasWatch ? -1 : 1;
      if (x.hasPlan !== y.hasPlan) return x.hasPlan ? -1 : 1;
      return x.latestDate < y.latestDate ? 1 : -1;
    });

  return {
    totalClients: included.length,
    clients: included.slice(0, limit),
    scanCapped: options.scanCapped ?? false,
  };
}

const SCAN_CAP = 200;

export async function getClientsNeedingAttention(
  studioId: string,
): Promise<ClientsNeedingAttention> {
  const supabase = await createClient();
  const { data: sessionRows } = await supabase
    .from("sessions")
    .select(
      "id, client_id, started_at, next_session_note, client:clients(id, name, archived_at)",
    )
    .eq("studio_id", studioId)
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(SCAN_CAP);
  type Raw = {
    id: string;
    client_id: string;
    started_at: string;
    next_session_note: string | null;
    client:
      | { id: string; name: string; archived_at: string | null }
      | { id: string; name: string; archived_at: string | null }[]
      | null;
  };
  const sessions: AttentionSessionInput[] = ((sessionRows ?? []) as Raw[])
    .map((r) => {
      const c = Array.isArray(r.client) ? (r.client[0] ?? null) : r.client;
      return c && !c.archived_at
        ? {
            id: r.id,
            client_id: r.client_id,
            client_name: c.name,
            started_at: r.started_at,
            next_session_note: r.next_session_note,
          }
        : null;
    })
    .filter((r): r is AttentionSessionInput => r !== null);

  const { data: blockRows } =
    sessions.length > 0
      ? await supabase
          .from("session_blocks")
          .select(
            "session_id, caution_for_next_session, caution_note, reaction_type, tolerance_rating",
          )
          .eq("studio_id", studioId)
          .in(
            "session_id",
            sessions.map((s) => s.id),
          )
          .is("deleted_at", null)
      : { data: [] as AttentionBlockInput[] };

  return buildClientsNeedingAttention(
    sessions,
    (blockRows ?? []) as AttentionBlockInput[],
    { limit: 5, scanCapped: (sessionRows ?? []).length >= SCAN_CAP },
  );
}
