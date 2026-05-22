// Pure helpers and types for the treatment-time system. Safe to import
// from client components. Server-only queries live in queries.ts.

export type TotalTreatmentTime = {
  totalMinutes: number;
  sessionCount: number;
  lastSessionAt: string | null;
};

export type AreaBreakdownRow = {
  area: string;
  minutes: number;
  percentage: number;
};

export type SessionRunningTotal = {
  sessionNumber: number;
  totalMinutesBefore: number;
};

export type EmailTreatmentTimeContext = {
  totalMinutes: number;
  sessionCount: number;
};

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

export function relativeLastSession(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "in the future";
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// Renders the client-facing email line, or null if the studio toggle is
// off. Possessive form reads naturally only with the given name.
export function buildTreatmentTimeLine(opts: {
  enabled: boolean;
  clientFirstName: string;
  context: EmailTreatmentTimeContext;
}): string | null {
  if (!opts.enabled) return null;
  const { sessionCount, totalMinutes } = opts.context;
  if (sessionCount === 0) {
    return `This will be ${opts.clientFirstName}'s first electrolysis session.`;
  }
  return `Treatment time so far: ${formatMinutes(totalMinutes)} · This will be session ${sessionCount + 1}.`;
}
