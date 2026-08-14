import { TODO_DISCLOSURE_LIMIT } from "@/lib/dashboard/todo-model";
import { createClient } from "@/lib/supabase/server";
import {
  NOTABLE_CODED_REACTION_TYPES,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import { notableReactionLabel } from "@/lib/sessions/reaction-unified";

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
//   B. RETIRED by DASH-TRUTH-01. A next_session_note (plan for the next
//      visit) used to include the client. It is clinical memory, not work,
//      so it no longer includes anyone and no longer ranks anyone; it is
//      still carried on the row as context when another rule includes them.
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

// DERIVED from the central clinical-response contract, never re-declared here.
// This used to be a hard-coded copy of the four notable enum members: a second
// source of truth that would silently miss any future change to the notable set
// (and did not know about the safety-relevant response LABELS at all). The
// runtime path below goes through `notableReactionLabel`, which reads the same
// contract; this export is retained only for type-level consumers.
export const NOTABLE_REACTIONS: ReadonlyArray<ReactionType> =
  NOTABLE_CODED_REACTION_TYPES;

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
  // Charting unification: reactions may live as chips in the block's live
  // entries' observation_chips (canonical going forward) as well as the legacy
  // reaction_type. Carry ALL live entries' observation_chips so the notable-
  // reaction rule reads the unified representation. Empty for legacy-only rows.
  observation_chips_list?: ReadonlyArray<unknown>;
};

export type ClientNeedingAttention = {
  clientId: string;
  clientName: string;
  // Review 3779063515. The timestamp of the SIGNAL THAT PUT THIS ROW ON THE
  // LIST (a caution or a notable reaction) never the client's newest
  // session.
  //
  // This deliberately REPLACES the old `latestDate` rather than sitting beside
  // it. A generic "latest session date" is exactly the alias through which a
  // plan-only session kept reaching ranking after plans were removed from
  // inclusion and from the sort key: client A (caution Jan 1 + plan-only
  // Jan 10) outranked client B (caution Jan 5), and at the bounded disclosure
  // limit A's stale caution could displace B's newer genuine one. Leaving a
  // second name in place would leave that leak available.
  attentionDate: string;
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
    // Dates of the ACTUAL To-do signals, tracked separately. A session that
    // contributes only a plan sets neither.
    watchDate: string | null;
    reactionDate: string | null;
    hasWatch: boolean;
    hasPlan: boolean;
    watchText: string | null;
    notableReactionLabel: string | null;
    latestToleranceRating: number | null;
    watchSourceFound: boolean;
    latestChartedSeen: boolean;
  };
  const byClient = new Map<string, Acc>();

  for (const s of sessionsNewestFirst) {
    const acc = byClient.get(s.client_id) ?? {
      clientName: s.client_name,
      watchDate: null,
      reactionDate: null,
      hasWatch: false,
      hasPlan: false,
      watchText: null,
      notableReactionLabel: null,
      latestToleranceRating: null,
      watchSourceFound: false,
      latestChartedSeen: false,
    };
    const sessionBlocks = blocksBySession.get(s.id) ?? [];

    // Newest charted session only: notable reaction + latest tolerance.
    if (!acc.latestChartedSeen && sessionBlocks.length > 0) {
      acc.latestChartedSeen = true;
      for (const b of sessionBlocks) {
        if (!acc.notableReactionLabel) {
          // Unified: notable reaction from legacy reaction_type OR reaction chips
          // in the block's live entries' observation_chips.
          const label = notableReactionLabel(
            b.reaction_type,
            b.observation_chips_list ?? [],
          );
          if (label) {
            acc.notableReactionLabel = label;
            acc.reactionDate = s.started_at;
          }
        }
        if (acc.latestToleranceRating == null && b.tolerance_rating != null) {
          acc.latestToleranceRating = b.tolerance_rating;
        }
      }
    }

    // Newest session carrying a WATCH note wins (the PR #203 pre-client rule,
    // per client). Earlier sessions never override it.
    //
    // Review 3778510290. A plan must not TERMINATE this search. The rule used
    // to be "newest session with watch OR plan content wins", which was
    // coherent while a plan was itself an inclusion reason: a plan-only newest
    // session set sourceFound, hid any older caution, and the client still
    // appeared: for the plan. Once DASH-TRUTH-01 removed plan as an inclusion
    // signal, that same path dropped the client entirely and a genuine
    // clinical watch note disappeared from To do.
    //
    // "Plan is not To-do content in ANY position" has to include this one:
    // not inclusion, not ranking, not reason, not detail, not preview, and not
    // supersession. So the watch search is now driven by cautions alone. A
    // caution is superseded only by a newer caution, which surfaces the
    // client anyway, so the failure direction is a watch note persisting,
    // never one silently vanishing.
    if (!acc.watchSourceFound) {
      const cautionBlock = sessionBlocks.find(
        (b) => b.caution_for_next_session || b.caution_note?.trim(),
      );
      if (cautionBlock) {
        acc.watchSourceFound = true;
        acc.hasWatch = true;
        acc.watchDate = s.started_at;
        acc.watchText =
          cautionBlock.caution_note?.trim() || "Previously noted";
      }
    }

    // Whether a plan EXISTS, tracked INDEPENDENTLY of the watch search so the
    // two cannot suppress one another. Context only: a boolean, never the
    // note. The text stays where it belongs: Treatment Memory, appointment
    // prep, history and Today → Remember all read sessions.next_session_note
    // directly and are untouched.
    if (!acc.hasPlan && (s.next_session_note?.trim() || null)) {
      acc.hasPlan = true;
    }
    byClient.set(s.client_id, acc);
  }

  // DASH-TRUTH-01 / review 3777045539. A plan for the next visit is clinical
  // memory, not work, so it must stop being an INCLUSION signal HERE, at the
  // source, not later at presentation.
  //
  // Filtering it downstream was wrong in a way that loses real clinical
  // signal: plan-only clients still passed this filter, still sorted AHEAD of
  // reaction-only clients (hasPlan was the second sort key), and still consumed
  // slots in the slice below. With enough plan-only clients a genuine notable
  // reaction could be cut entirely and the Dashboard could report nothing
  // needing attention. Excluding them before sort/count/limit is the only
  // placement that cannot starve real work.
  const included = [...byClient.entries()]
    .filter(([, a]) => a.hasWatch || a.notableReactionLabel !== null)
    .map(([clientId, a]) => ({
      clientId,
      clientName: a.clientName,
      // The later of the genuine signals. Both a caution and a notable
      // reaction are real To-do signals, so the honest "when did this client
      // last need attention" is the newer of the two. A plan can never
      // contribute, because plan-only sessions set neither date.
      attentionDate:
        a.watchDate && a.reactionDate
          ? a.watchDate > a.reactionDate
            ? a.watchDate
            : a.reactionDate
          : (a.watchDate ?? a.reactionDate ?? ""),
      hasWatch: a.hasWatch,
      hasPlan: a.hasPlan,
      notableReactionLabel: a.notableReactionLabel,
      latestToleranceRating: a.latestToleranceRating,
      // DASH-TRUTH-01 / P2. A plan for the next visit is not To-do content in
      // ANY position, not inclusion, ranking, reason, detail or preview. It
      // used to sit here as the second fallback, so a client included for a
      // notable REACTION could still have their plan text rendered as the
      // row's detail. The row is included because of a watch note or a
      // reaction, so the preview says one of exactly those two things.
      previewLine:
        a.watchText ??
        (a.notableReactionLabel
          ? `Latest recorded reaction: ${a.notableReactionLabel}`
          : ""),
    }))
    .sort((x, y) => {
      // Watch note first, then most recent attention signal, then a
      // deterministic tiebreak.
      //
      // hasPlan is not a ranking signal, and neither is any date a plan can
      // set. Review 3780005405 closed the last route by which one could still
      // reach the order: this comparator returned -1 in BOTH directions for
      // equal attention dates, which is not a total order, so Array#sort fell
      // back to input order, and input order is `byClient` insertion order,
      // established by each client's newest scanned session. A plan-only
      // session could therefore still decide which of two equal-dated clients
      // survived the disclosure limit.
      //
      // Ordering must be a function of the row's own fields alone. The
      // clientId tiebreak makes the comparator antisymmetric and transitive,
      // so the result is identical for any input permutation. This mirrors
      // compareTodoItems, which has always ended in an id tiebreak.
      if (x.hasWatch !== y.hasWatch) return x.hasWatch ? -1 : 1;
      if (x.attentionDate !== y.attentionDate) {
        return x.attentionDate < y.attentionDate ? 1 : -1;
      }
      return x.clientId < y.clientId ? -1 : x.clientId > y.clientId ? 1 : 0;
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
          // Set-based, studio-scoped, one query: block fields + the block's live
          // entries' observation_chips embedded (PostgREST join, NOT N+1) so the
          // unified notable-reaction rule can read reaction chips too.
          .select(
            "session_id, caution_for_next_session, caution_note, reaction_type, tolerance_rating, electrolysis_entries(observation_chips, deleted_at)",
          )
          .eq("studio_id", studioId)
          .in(
            "session_id",
            sessions.map((s) => s.id),
          )
          .is("deleted_at", null)
      : { data: [] };

  type RawBlock = {
    session_id: string;
    caution_for_next_session: boolean;
    caution_note: string | null;
    reaction_type: string | null;
    tolerance_rating: number | null;
    electrolysis_entries?:
      | ReadonlyArray<{ observation_chips: unknown; deleted_at: string | null }>
      | null;
  };
  const blocks: AttentionBlockInput[] = ((blockRows ?? []) as RawBlock[]).map((b) => ({
    session_id: b.session_id,
    caution_for_next_session: b.caution_for_next_session,
    caution_note: b.caution_note,
    reaction_type: b.reaction_type,
    tolerance_rating: b.tolerance_rating,
    observation_chips_list: (b.electrolysis_entries ?? [])
      .filter((e) => e.deleted_at == null)
      .map((e) => e.observation_chips),
  }));

  return buildClientsNeedingAttention(sessions, blocks, {
    // DASH-TRUTH-02: return enough rows for the Dashboard disclosure to be real.
    // Bounded by TODO_DISCLOSURE_LIMIT; the SCAN_CAP above is unchanged.
    limit: TODO_DISCLOSURE_LIMIT,
    scanCapped: (sessionRows ?? []).length >= SCAN_CAP,
  });
}
