import type { SupabaseClient } from "@supabase/supabase-js";

// SETTINGS-REGISTRY. The one place that says which boolean columns on `studios`
// are settings, what each defaults to, and what kind of thing each is.
//
// WHY. Enforcement points used to read their own column ad hoc, so a new control
// could ship without a default, a class or a decision about what an absent value
// means. tests/lib/studio/settings-registry.test.ts fails when a boolean column
// on Studio is neither registered here nor listed as deliberately not a setting,
// and when a default here drifts from the migration that created the column.
//
// Nothing here changes behaviour: it adopts no caller yet, and every default is
// the column's existing DB default. A value read before a column exists (a row
// from before its migration) resolves to the default, never to a guess.

export type StudioSettingKind =
  /** A permanent, owner-controlled studio preference. */
  | "preference"
  /** A rollout or containment switch that is not a lasting preference. */
  | "rollout"
  /** Locked by the database (CHECK) and not a product capability. Never expose. */
  | "retired";

export type StudioSettingDef = {
  readonly default: boolean;
  readonly kind: StudioSettingKind;
  /** Where a read must happen so a flip takes effect on in-flight work. */
  readonly readAt: "send-time" | "render" | "action";
};

export const STUDIO_SETTINGS = {
  send_confirmation_emails: { default: true, kind: "preference", readAt: "send-time" },
  send_24h_reminders: { default: true, kind: "preference", readAt: "send-time" },
  send_2h_reminders: { default: true, kind: "preference", readAt: "send-time" },
  send_intake_reminders: { default: true, kind: "preference", readAt: "send-time" },
  notify_practitioner_on_new_booking: { default: true, kind: "preference", readAt: "send-time" },
  auto_mark_no_shows: { default: true, kind: "preference", readAt: "send-time" },
  send_no_show_followup: { default: false, kind: "preference", readAt: "send-time" },
  show_treatment_time_to_clients: { default: false, kind: "preference", readAt: "render" },
  send_confirmation_sms: { default: false, kind: "preference", readAt: "send-time" },
  send_24h_sms_reminders: { default: false, kind: "preference", readAt: "send-time" },
  send_2h_sms_reminders: { default: false, kind: "preference", readAt: "send-time" },
  send_waitlist_invitation_sms: { default: false, kind: "preference", readAt: "send-time" },
  client_cancellation_enabled: { default: true, kind: "preference", readAt: "action" },
  client_reschedule_enabled: { default: true, kind: "preference", readAt: "action" },
  client_portal_enabled: { default: true, kind: "preference", readAt: "action" },
  practitioner_capacity_enabled: { default: false, kind: "preference", readAt: "action" },
  practitioner_capacity_booking_enabled: { default: false, kind: "rollout", readAt: "action" },
  google_calendar_connection_enabled: { default: false, kind: "preference", readAt: "action" },
  google_calendar_outbound_sync_enabled: { default: false, kind: "preference", readAt: "send-time" },
  google_calendar_inbound_busy_enabled: { default: false, kind: "preference", readAt: "action" },
  // No reader exists in app/ or lib/ today (GEN-SETTINGS-CLASSIFY): registered so it
  // cannot be mistaken for an enforced control. Wire it or drop it.
  google_calendar_two_way_updates_enabled: { default: false, kind: "rollout", readAt: "action" },
  onboarding_v2_enabled: { default: false, kind: "rollout", readAt: "render" },
  clinical_finalization_enabled: { default: false, kind: "retired", readAt: "action" },
  clinical_corrections_enabled: { default: false, kind: "retired", readAt: "action" },
} as const satisfies Record<string, StudioSettingDef>;

export type StudioSettingKey = keyof typeof STUDIO_SETTINGS;

/** Boolean Studio columns that are deliberately NOT settings. Empty today. */
export const NOT_A_SETTING: ReadonlyArray<string> = [];

export function isStudioSettingKey(key: string): key is StudioSettingKey {
  return Object.prototype.hasOwnProperty.call(STUDIO_SETTINGS, key);
}

/**
 * Resolve one setting from a studio row. An absent or null value (a row read
 * before the column's migration) is the registered default, which is the same
 * value the column would hold.
 */
export function resolveStudioSetting(
  row: Partial<Record<StudioSettingKey, boolean | null>>,
  key: StudioSettingKey,
): boolean {
  const v = row[key];
  return typeof v === "boolean" ? v : STUDIO_SETTINGS[key].default;
}

/**
 * Read several settings for ONE studio, studio-scoped. Callers that act on a
 * setting call this at the moment of acting, not at page load.
 */
export async function readStudioSettings<K extends StudioSettingKey>(
  supabase: SupabaseClient,
  studioId: string,
  keys: ReadonlyArray<K>,
): Promise<Record<K, boolean> | null> {
  const { data, error } = await supabase
    .from("studios")
    .select(keys.join(","))
    .eq("id", studioId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as Partial<Record<K, boolean | null>>;
  const out = {} as Record<K, boolean>;
  for (const k of keys) out[k] = resolveStudioSetting(row, k);
  return out;
}
