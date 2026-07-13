import { apilusModalityLabel } from "@/lib/constants";
import {
  isReactionType,
  reactionTypeLabel,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import { resolveBlockAreas, type BlockArea } from "@/lib/sessions/block-areas";

// PR #210: Client Treatment Intelligence Summary. Pure builder that
// turns a client's recorded treatment history (sessions + treatment
// areas) into the practitioner summary shown on the profile Overview.
//
// This is RECORDED-HISTORY analytics, never advice: every label the
// UI derives from this module says "recorded", "historically used",
// "latest", or "commonly recorded". Nothing here suggests settings,
// makes causal or outcome claims, or projects anything. Missing
// values stay null and render "Not recorded"; nothing is invented.
//
// Data conventions (matching the rest of the app):
//   * minutes  = session_blocks.minutes_performed (same source the
//     treatment-time tracker uses; entry-level legacy minutes are
//     deliberately not double-counted)
//   * hairs    = electrolysis_entries.hairs_treated, attributed to an
//     area via the entry's block
//   * a session counts as charted when it has treatment areas or raw
//     entries (same rule as pickLastTreatment)
//   * areas group by trimmed, case-insensitive name (primary_area,
//     falling back to legacy block_name); the most recent original
//     spelling is kept as the display label; blank/null area names
//     never crash and are excluded from area cards (their minutes and
//     hairs still count toward the overall totals)

export type IntelligenceSessionInput = {
  id: string;
  started_at: string;
  next_session_note?: string | null;
  electrolysis_entries: ReadonlyArray<{ hairs_treated: number | null }>;
  laser_entries: ReadonlyArray<unknown>;
};

export type IntelligenceBlockInput = {
  session_id: string;
  primary_area: string | null;
  side?: string | null;
  // Migration 0128: the structured treated areas for this block. When present the
  // block contributes to EVERY area's intelligence (not just primary_area), so a
  // "Cheeks + Sideburns" block appears under both. Grouping stays by area NAME
  // (laterality is a per-session record detail, aggregated out of the memory
  // card), keeping legacy single-area grouping unchanged.
  structured_areas?: ReadonlyArray<BlockArea> | null;
  block_name: string | null;
  mode: string | null;
  apilus_modality: string | null;
  energy_level: number | null;
  machine_frequency: string | null;
  probe_label: string | null;
  minutes_performed: number | null;
  tolerance_rating: number | null;
  reaction_type: string | null;
  caution_for_next_session: boolean;
  caution_note: string | null;
  entry_hairs: ReadonlyArray<number | null>;
};

export type AreaIntelligence = {
  name: string;
  sessions: number;
  areasCharted: number;
  minutes: number | null;
  hairs: number | null;
  hairsPerMinute: number | null;
  firstTreated: string;
  lastTreated: string;
  latestFrequency: string | null;
  latestProbe: string | null;
  latestModeLabel: string | null;
  latestEnergyLevel: number | null;
  commonReactionLabel: string | null;
  latestWatchNote: string | null;
};

export type TreatmentIntelligence = {
  charted: boolean;
  overall: {
    chartedSessions: number;
    areasCharted: number;
    minutes: number | null;
    hairs: number | null;
    hairsPerMinute: number | null;
    firstTreated: string | null;
    lastTreated: string | null;
  };
  areas: AreaIntelligence[];
  commonReactionLabel: string | null;
  latestReactionLabel: string | null;
  latestToleranceRating: number | null;
  latestWatchNote: string | null;
  latestPlan: string | null;
};

const MODE_LABELS: Record<string, string> = {
  thermo: "Thermolysis",
  blend: "Blend",
  galv: "Galvanic",
};

function positive(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function hairsPerMinute(
  hairs: number | null,
  minutes: number | null,
): number | null {
  if (!hairs || !minutes || hairs <= 0 || minutes <= 0) return null;
  return Math.round((hairs / minutes) * 10) / 10;
}

// The distinct area names a block treated, in display order, deduped
// case-insensitively. Structured rows (0128) win; otherwise the legacy
// primary_area, then block_name. Blank names are dropped (they never form a
// card but their minutes/hairs still land in the overall totals).
function blockAreaNames(block: IntelligenceBlockInput): string[] {
  const resolved = resolveBlockAreas(block.structured_areas ?? null, {
    primary_area: block.primary_area,
    side: block.side,
  });
  const source =
    resolved.length > 0
      ? resolved.map((r) => r.area.trim())
      : [(block.block_name ?? "").trim()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of source) {
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function modeLabelFor(block: IntelligenceBlockInput): string | null {
  if (block.apilus_modality) {
    return apilusModalityLabel(block.apilus_modality);
  }
  if (block.mode && MODE_LABELS[block.mode]) return MODE_LABELS[block.mode];
  return null;
}

// Most frequent non-empty reaction; ties prefer the most RECENT
// occurrence (inputs must be ordered oldest -> newest).
function commonReaction(
  reactionsOldestFirst: ReadonlyArray<string | null>,
): string | null {
  const counts = new Map<ReactionType, { count: number; lastIndex: number }>();
  reactionsOldestFirst.forEach((r, i) => {
    if (!r || !isReactionType(r)) return;
    const cur = counts.get(r) ?? { count: 0, lastIndex: -1 };
    counts.set(r, { count: cur.count + 1, lastIndex: i });
  });
  let top: ReactionType | null = null;
  let topCount = 0;
  let topLast = -1;
  for (const [r, { count, lastIndex }] of counts) {
    if (count > topCount || (count === topCount && lastIndex > topLast)) {
      top = r;
      topCount = count;
      topLast = lastIndex;
    }
  }
  return top ? reactionTypeLabel(top) : null;
}

export function buildTreatmentIntelligence(input: {
  sessionsNewestFirst: ReadonlyArray<IntelligenceSessionInput>;
  blocks: ReadonlyArray<IntelligenceBlockInput>;
}): TreatmentIntelligence {
  const { sessionsNewestFirst, blocks } = input;
  const sessionsOldestFirst = [...sessionsNewestFirst].reverse();
  const sessionDate = new Map(
    sessionsNewestFirst.map((s) => [s.id, s.started_at]),
  );
  const blocksBySession = new Map<string, IntelligenceBlockInput[]>();
  for (const b of blocks) {
    const list = blocksBySession.get(b.session_id) ?? [];
    list.push(b);
    blocksBySession.set(b.session_id, list);
  }

  // Charted sessions: same rule as the Last treatment card.
  const chartedSessions = sessionsNewestFirst.filter(
    (s) =>
      (blocksBySession.get(s.id)?.length ?? 0) > 0 ||
      s.electrolysis_entries.length > 0 ||
      s.laser_entries.length > 0,
  );
  if (chartedSessions.length === 0) {
    return {
      charted: false,
      overall: {
        chartedSessions: 0,
        areasCharted: 0,
        minutes: null,
        hairs: null,
        hairsPerMinute: null,
        firstTreated: null,
        lastTreated: null,
      },
      areas: [],
      commonReactionLabel: null,
      latestReactionLabel: null,
      latestToleranceRating: null,
      latestWatchNote: null,
      latestPlan: null,
    };
  }

  // Blocks ordered oldest -> newest by their session date so "latest"
  // and tie-breaks are well-defined.
  const blocksOldestFirst = [...blocks].sort((a, b) => {
    const da = sessionDate.get(a.session_id) ?? "";
    const db = sessionDate.get(b.session_id) ?? "";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  // Overall totals. Hairs come from entries (via blocks) PLUS legacy
  // blockless entries on the session rows, never double-counted: a
  // session's entries are counted from the session row only when it
  // has no blocks.
  let totalMinutes = 0;
  let totalHairs = 0;
  for (const b of blocksOldestFirst) {
    totalMinutes += positive(b.minutes_performed);
    for (const h of b.entry_hairs) totalHairs += positive(h);
  }
  for (const s of chartedSessions) {
    if ((blocksBySession.get(s.id)?.length ?? 0) > 0) continue;
    for (const e of s.electrolysis_entries) totalHairs += positive(e.hairs_treated);
  }

  const chartedDatesAsc = chartedSessions
    .map((s) => s.started_at)
    .sort();

  // Area grouping: trimmed case-insensitive key; most recent original
  // spelling wins as display label; blank names excluded from cards.
  type AreaAcc = {
    label: string;
    sessionIds: Set<string>;
    blockCount: number;
    minutes: number;
    hairs: number;
    dates: string[];
    reactionsOldestFirst: Array<string | null>;
    latest: IntelligenceBlockInput;
    latestWatchNote: string | null;
  };
  const areasByKey = new Map<string, AreaAcc>();
  for (const b of blocksOldestFirst) {
    const date = sessionDate.get(b.session_id) ?? "";
    // Migration 0128: a block contributes to EVERY structured area it treated
    // (grouped by area name, laterality aggregated out of the memory card), so a
    // "Cheeks + Sideburns" block appears under both. Legacy single-area blocks
    // resolve to their primary_area, then block_name — unchanged grouping.
    for (const rawName of blockAreaNames(b)) {
      const key = rawName.toLowerCase();
      const acc = areasByKey.get(key) ?? {
        label: rawName,
        sessionIds: new Set<string>(),
        blockCount: 0,
        minutes: 0,
        hairs: 0,
        dates: [],
        reactionsOldestFirst: [],
        latest: b,
        latestWatchNote: null,
      };
      acc.label = rawName; // newest spelling wins (oldest-first iteration)
      acc.sessionIds.add(b.session_id);
      acc.blockCount += 1;
      acc.minutes += positive(b.minutes_performed);
      for (const h of b.entry_hairs) acc.hairs += positive(h);
      acc.dates.push(date);
      acc.reactionsOldestFirst.push(b.reaction_type);
      acc.latest = b;
      if (b.caution_for_next_session || b.caution_note?.trim()) {
        acc.latestWatchNote = b.caution_note?.trim() || "Previously noted";
      }
      areasByKey.set(key, acc);
    }
  }

  const areas: AreaIntelligence[] = [...areasByKey.values()]
    .map((a) => {
      const dates = [...a.dates].sort();
      return {
        name: a.label,
        sessions: a.sessionIds.size,
        areasCharted: a.blockCount,
        minutes: a.minutes > 0 ? a.minutes : null,
        hairs: a.hairs > 0 ? a.hairs : null,
        hairsPerMinute: hairsPerMinute(
          a.hairs > 0 ? a.hairs : null,
          a.minutes > 0 ? a.minutes : null,
        ),
        firstTreated: dates[0] ?? "",
        lastTreated: dates[dates.length - 1] ?? "",
        latestFrequency: a.latest.machine_frequency,
        latestProbe: a.latest.probe_label,
        latestModeLabel: modeLabelFor(a.latest),
        latestEnergyLevel: a.latest.energy_level,
        commonReactionLabel: commonReaction(a.reactionsOldestFirst),
        latestWatchNote: a.latestWatchNote,
      };
    })
    .sort((x, y) => (x.lastTreated < y.lastTreated ? 1 : -1));

  // Client-level reaction / tolerance / watch / plan.
  const allReactionsOldestFirst = blocksOldestFirst.map((b) => b.reaction_type);
  let latestReactionLabel: string | null = null;
  let latestToleranceRating: number | null = null;
  let latestWatchNote: string | null = null;
  for (const b of blocksOldestFirst) {
    if (b.reaction_type && isReactionType(b.reaction_type)) {
      latestReactionLabel = reactionTypeLabel(b.reaction_type);
    }
    if (b.tolerance_rating != null) {
      latestToleranceRating = b.tolerance_rating;
    }
    if (b.caution_for_next_session || b.caution_note?.trim()) {
      latestWatchNote = b.caution_note?.trim() || "Previously noted";
    }
  }
  let latestPlan: string | null = null;
  for (const s of sessionsOldestFirst) {
    if (s.next_session_note?.trim()) latestPlan = s.next_session_note.trim();
  }

  return {
    charted: true,
    overall: {
      chartedSessions: chartedSessions.length,
      areasCharted: blocks.length,
      minutes: totalMinutes > 0 ? totalMinutes : null,
      hairs: totalHairs > 0 ? totalHairs : null,
      hairsPerMinute: hairsPerMinute(
        totalHairs > 0 ? totalHairs : null,
        totalMinutes > 0 ? totalMinutes : null,
      ),
      firstTreated: chartedDatesAsc[0] ?? null,
      lastTreated: chartedDatesAsc[chartedDatesAsc.length - 1] ?? null,
    },
    areas,
    commonReactionLabel: commonReaction(allReactionsOldestFirst),
    latestReactionLabel,
    latestToleranceRating,
    latestWatchNote,
    latestPlan,
  };
}
