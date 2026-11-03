// Client profile save: write only what the staff member changed, and only if nobody else changed it first.
//
// The edit form used to post every field it loaded, and the action wrote all of them back, so a tab opened
// before an intake sync or another staff edit silently reverted the newer value, and an older form that omitted
// a field blanked it. The form now carries the values it LOADED (the baseline, exactly as stored). The action
// compares each submitted field with its baseline, writes only the fields that changed, and makes the write
// conditional: `where <column> is not distinct from <baseline>` for every changed column, so zero rows means
// somebody else changed one of them (or the client is gone) and nothing is written.
//
// App-only interim: the baseline comes from the browser, which is fine because it is only a precondition; it
// can never widen what the caller may write (role, studio and RLS are checked server-side as before).
// A database revision (held migration M1/M2) replaces this later.
import { parsePreferredName } from "@/lib/clients/identity";

export const PROFILE_KEYS = [
  "name",
  "preferred_name",
  "pronouns",
  "date_of_birth",
  "phone",
  "email",
  "address",
  "fitzpatrick_type",
  "allergies",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

export type BaselineValue = string | number | null;
export type ProfileBaseline = Record<ProfileKey, BaselineValue>;

export const STALE_FORM_ERROR =
  "This page is out of date. Reload it and make your change again; nothing was saved.";
export const CHANGED_BY_SOMEONE_ELSE_ERROR =
  "Someone else changed this client after you opened this page. Nothing was saved. Review the changes below.";
export const NOT_SAVED_ERROR = "Not saved. Reload the page and try again.";
export const CLEAR_PREFERRED_ERROR =
  "To remove the preferred name, press Remove preferred name. Otherwise type a name.";

export const PROFILE_FIELD_LABELS: Record<ProfileKey, string> = {
  name: "Name",
  preferred_name: "Preferred name",
  pronouns: "Pronouns",
  date_of_birth: "Date of birth",
  phone: "Phone",
  email: "Email",
  address: "Address",
  fitzpatrick_type: "Fitzpatrick type",
  allergies: "Allergies",
  emergency_contact_name: "Emergency contact name",
  emergency_contact_phone: "Emergency contact phone",
};

/** The values the page loaded, exactly as stored (raw, so the conditional write can compare them). */
export function baselineFromRow(row: Record<string, unknown>): ProfileBaseline {
  const out = {} as ProfileBaseline;
  for (const key of PROFILE_KEYS) {
    const v = row[key];
    out[key] = typeof v === "string" || typeof v === "number" ? v : null;
  }
  return out;
}

/**
 * Upper bound on the baseline JSON. It is a sanity ceiling, NOT a limit on what a record may hold: a client whose
 * stored allergies or address text is long must still be editable, so this sits far above any real profile. The
 * request itself is already bounded by the server-action body limit (16mb in next.config.ts), and the submission
 * carries the same values again, so half of that is the most a baseline could ever be.
 */
export const MAX_BASELINE_CHARS = 4_000_000;

/** Strict: every key present, each a string, number or null. Anything else is not a baseline. */
export function parseBaseline(raw: unknown): ProfileBaseline | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BASELINE_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const out = {} as ProfileBaseline;
  for (const key of PROFILE_KEYS) {
    if (!(key in rec)) return null;
    const v = rec[key];
    if (v !== null && typeof v !== "string" && typeof v !== "number") return null;
    out[key] = v;
  }
  return out;
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const t = value.trim();
  return t.length === 0 ? null : t;
}

function intOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : value.trim() === "" ? NaN : parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** A stored or baseline value, put in the same shape a submission is parsed into. */
function normalizeStored(key: ProfileKey, raw: BaselineValue): string | number | null {
  if (key === "fitzpatrick_type") return intOrNull(raw);
  if (key === "preferred_name") {
    const parsed = parsePreferredName(raw === null ? null : String(raw));
    return parsed.ok ? parsed.value : trimmedOrNull(raw === null ? null : String(raw));
  }
  return trimmedOrNull(raw === null ? null : String(raw));
}

/** The fields the possible-duplicate check combines. */
export const IDENTITY_KEYS = ["name", "phone", "date_of_birth"] as const satisfies readonly ProfileKey[];

export type ProfilePlan =
  | {
      ok: true;
      /** Only the changed columns, parsed. Empty = nothing to save. */
      patch: Partial<Record<ProfileKey, string | number | null>>;
      /**
       * The stored value each changed column must still have for the write to apply. When an identity field
       * (name, phone, date of birth) changes, the OTHER identity fields are guarded too (`guard: true`): the
       * duplicate check combines them, so the combination that was checked must be the one that is saved.
       */
      conditions: Array<{ key: ProfileKey; value: BaselineValue; guard?: boolean }>;
    }
  | { ok: false; error: string };

/**
 * Decide what to write. A key absent from the submission is never a candidate, so an omitted field can never
 * clear anything. A present key is written only when it differs from the baseline.
 */
export function planProfileUpdate(formData: FormData, baseline: ProfileBaseline): ProfilePlan {
  const patch: Partial<Record<ProfileKey, string | number | null>> = {};
  const conditions: Array<{ key: ProfileKey; value: BaselineValue; guard?: boolean }> = [];

  for (const key of PROFILE_KEYS) {
    if (!formData.has(key)) continue;
    const raw = formData.get(key);
    let submitted: string | number | null;
    if (key === "name") {
      submitted = typeof raw === "string" ? trimmedOrNull(raw) : null;
      if (!submitted) return { ok: false, error: "Name is required." };
    } else if (key === "preferred_name") {
      const parsed = parsePreferredName(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      submitted = parsed.value;
    } else if (key === "fitzpatrick_type") {
      submitted = typeof raw === "string" ? intOrNull(raw) : null;
    } else {
      submitted = typeof raw === "string" ? trimmedOrNull(raw) : null;
    }

    const before = normalizeStored(key, baseline[key]);
    if (submitted === before) continue;

    if (key === "preferred_name" && submitted === null && before !== null && formData.get("clear_preferred_name") !== "yes") {
      return { ok: false, error: CLEAR_PREFERRED_ERROR };
    }
    patch[key] = submitted;
    conditions.push({ key, value: baseline[key] });
  }
  if (IDENTITY_KEYS.some((k) => k in patch)) {
    for (const key of IDENTITY_KEYS) {
      if (!(key in patch)) conditions.push({ key, value: baseline[key], guard: true });
    }
  }
  return { ok: true, patch, conditions };
}

/**
 * PostgREST carries every `.eq` condition in the URL, and the API gateway refuses a long URL (measured on the local
 * stack: a filter value of 8,000 characters is accepted, 12,000 is refused with 414). A client whose stored allergies
 * or address text is long could therefore never be edited in that field: the save failed at transport and was
 * reported as not saved.
 *
 * So a condition travels in the URL only while its ENCODED value is at most URL_CONDITION_MAX_VALUE_CHARS and the
 * encoded conditions together stay within URL_CONDITION_TOTAL_CHARS. A changed field whose baseline is over the
 * threshold is written WITHOUT its own equality condition: for that field the guarantee is exactly what production
 * had before this change (last write wins). Every short changed field and the identity guards keep their conditions.
 * The atomic fix for a long field is a JSON-body database function (held, with M1); it is not part of this change.
 */
export const URL_CONDITION_MAX_VALUE_CHARS = 2_000;
export const URL_CONDITION_TOTAL_CHARS = 6_000;

const encodedLength = (value: BaselineValue): number => encodeURIComponent(value === null ? "null" : String(value)).length;

export function splitConditions<T extends { key: ProfileKey; value: BaselineValue }>(
  conditions: ReadonlyArray<T>,
): { inUrl: T[]; unconditioned: T[] } {
  const bySize = conditions
    .map((c, index) => ({ index, size: encodedLength(c.value) }))
    .sort((a, b) => a.size - b.size);
  const keep = new Set<number>();
  let used = 0;
  for (const item of bySize) {
    if (item.size > URL_CONDITION_MAX_VALUE_CHARS) continue;
    if (used + item.size > URL_CONDITION_TOTAL_CHARS) continue;
    used += item.size;
    keep.add(item.index);
  }
  return {
    inUrl: conditions.filter((_, i) => keep.has(i)),
    unconditioned: conditions.filter((_, i) => !keep.has(i)),
  };
}

export type ProfileConflict = {
  key: ProfileKey;
  label: string;
  current: string;
  yours: string;
  /** True when this page did not change the field: it only guards the duplicate check. */
  guard?: boolean;
};

function asFormString(value: BaselineValue | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * After a zero-row conditional write: which changed fields no longer hold their baseline value. Only called after
 * the role and client-access checks, and only returned to the same signed-in staff member; never logged.
 */
export function describeConflicts(
  plan: Extract<ProfilePlan, { ok: true }>,
  stored: Record<string, unknown>,
): ProfileConflict[] {
  const conflicts: ProfileConflict[] = [];
  for (const { key, value, guard } of plan.conditions) {
    const now = stored[key];
    const nowValue: BaselineValue = typeof now === "string" || typeof now === "number" ? now : null;
    if (nowValue === value) continue;
    conflicts.push({
      key,
      label: PROFILE_FIELD_LABELS[key],
      current: asFormString(nowValue),
      ...(guard ? { guard: true } : {}),
      // A guard-only field was not changed on this page: "yours" is the value this page still shows.
      yours: guard ? asFormString(value) : asFormString(plan.patch[key] ?? null),
    });
  }
  return conflicts;
}

/** Baseline for the form after the staff member reviewed a conflict: adopt the current stored value. */
export function adoptCurrent(baseline: ProfileBaseline, conflicts: ReadonlyArray<ProfileConflict>): ProfileBaseline {
  const next = { ...baseline };
  for (const c of conflicts) {
    next[c.key] = c.key === "fitzpatrick_type" ? intOrNull(c.current) : c.current === "" ? null : c.current;
  }
  return next;
}
