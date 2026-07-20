// Hand-rolled minimal database types. Regenerate from Supabase later with:
//   npx supabase gen types typescript --project-id <ref> > lib/types/database.ts

// PR #279: numbing vocabulary (allowlist + labels) lives with the other
// clinical-response vocabulary; the type is imported here for SessionBlock.
import type { NumbingStatus } from "@/lib/sessions/clinical-response";

export type Modality = "electrolysis" | "laser";
export type ElectrolysisMode = "thermo" | "galv" | "blend";
export type PractitionerRole = "owner" | "practitioner";
export type PhotoType = "before" | "after" | "progress";
export type FitzpatrickType = 1 | 2 | 3 | 4 | 5 | 6;

export type Studio = {
  id: string;
  name: string;
  legal_entity_name: string | null;
  owner_email: string;
  created_at: string;
  // Booking v1 additions (migration 0010)
  timezone: string;
  // Migration 0109: practitioner-facing time display preference ("12h" | "24h",
  // default "12h"). Optional at the type level because a studio loaded via
  // `select *` before 0109 is applied won't carry it; read via resolveTimeFormat.
  time_format_preference?: "12h" | "24h";
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
  slug: string;
  address: string | null;
  booking_description: string | null;
  // Migration 0119 (Clinical Record — Phase 1): studio-scoped feature flag for
  // the "Finalize & sign" clinical-record boundary. Default OFF; opt-in per
  // studio during supervised rollout. Optional at the type level for rows loaded
  // via `select *` before 0119 is applied.
  clinical_finalization_enabled?: boolean;
  // Migration 0120 (Clinical Record — Phase 2): studio-scoped flag for corrections
  // & amendments. Separate from Phase 1; default OFF. Optional for pre-0120 rows.
  clinical_corrections_enabled?: boolean;
  // Migration 0121 (Google Calendar — Phase A): studio-scoped feature flags, all
  // default OFF. Only `google_calendar_connection_enabled` is used in Phase A
  // (gates the Connect UI + OAuth start). The other three name future phases
  // (outbound push / inbound busy / two-way edits) and remain OFF + unused.
  // Optional at the type level for rows loaded via `select *` before 0121.
  google_calendar_connection_enabled?: boolean;
  google_calendar_outbound_sync_enabled?: boolean;
  google_calendar_inbound_busy_enabled?: boolean;
  google_calendar_two_way_updates_enabled?: boolean;
  // Migration 0134 (practitioner-capacity foundation): studio-scoped flag that
  // enables per-practitioner capacity + parallelism. Default OFF; opt-in per
  // studio. Optional at the type level for rows loaded via `select *` before 0134.
  practitioner_capacity_enabled?: boolean;
  // Migration 0025: studio-level email toggles.
  send_confirmation_emails: boolean;
  send_24h_reminders: boolean;
  send_2h_reminders: boolean;
  auto_mark_no_shows: boolean;
  send_no_show_followup: boolean;
  // Migration 0026: opt-in display of client treatment time in emails.
  show_treatment_time_to_clients: boolean;
  // Migration 0036: how many months ahead the public booking page shows
  // available slots. Allowed values: 3, 4, 6. Default 3 (matches the
  // previously-hardcoded BOOKING_HORIZON_DAYS). Internal practitioner
  // booking is not subject to this limit.
  public_booking_horizon_months:
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9
    | 10
    | 11
    | 12;
  // Migration 0040: practitioner-chosen accent color for birthday
  // reminders (dashboard + client profile). Default 'purple'. Red/rose
  // is intentionally NOT an option — it's reserved for allergies/cautions.
  birthday_reminder_color: BirthdayReminderColor;
  // Migration 0043: per-studio postcare email content. All nullable.
  // The send action requires postcare_aftercare_text to be non-empty
  // before allowing a send. postcare_review_url is optional; when set,
  // the email renders a neutral review prompt (no discount logic).
  postcare_aftercare_text: string | null;
  postcare_warning_signs_text: string | null;
  postcare_product_recommendations_text: string | null;
  postcare_review_url: string | null;
  // Migration 0048: per-studio override for the postcare review
  // prompt wording. Default neutral text is used when this is null.
  // Rendered ONLY when postcare_review_url is also set.
  postcare_review_prompt_text: string | null;
  // Migration 0048: per-studio business contact email rendered in
  // the postcare email footer. When null/empty, the postcare path
  // falls back to owner_email.
  postcare_contact_email: string | null;
  // Migration 0110: postcare delivery mode. "manual" (default) or
  // "auto_on_complete" (auto-send when an appointment is marked complete).
  // Optional at the type level because a studio read via `select *` before
  // 0110 is applied won't carry it; the auto-send path defaults it to "manual".
  postcare_delivery_mode?: "manual" | "auto_on_complete";
  // Migration 0047: practitioner/owner "New booking" notification
  // toggle. Default true preserves existing behavior. Controls ONLY
  // the operational practitioner notification; client confirmation
  // (send_confirmation_emails) and all other emails are unaffected.
  notify_practitioner_on_new_booking: boolean;
  // Migration 0045: cancellation / no-show policy text. Per-studio,
  // owner-authored. C2a-core only; not used to collect cards. When
  // card-on-file is enabled in a later release, this text is what
  // gets rendered above the consent block and hashed into
  // payment_consents.rendered_consent_text_hash. policy_version is a
  // stable identifier (ISO timestamp) bumped only when the text
  // content changes.
  cancellation_policy_text: string | null;
  no_show_policy_text: string | null;
  policy_version: string | null;
  policy_updated_at: string | null;
  // Migration 0064 (PR #145): per-studio manual cancellation/no-show
  // fee amount, in cents. NULL means "fee not configured" and the
  // manual-fee preview blocks charge prepare for that type. Range
  // is enforced by CHECK (0..20000) at the column level.
  late_cancel_fee_cents: number | null;
  no_show_fee_cents: number | null;
  // Migration 0049: per-studio SMS toggles. All default false. SMS
  // only goes out when the matching toggle is on AND the client has
  // explicit consent AND the client is not opted out AND Twilio is
  // configured. Toggling on does nothing until Sam adds Twilio env
  // vars and runs the studio-toggle SQL for that studio.
  send_confirmation_sms: boolean;
  send_24h_sms_reminders: boolean;
  send_2h_sms_reminders: boolean;
};

// Migration 0040: closed preset list for the birthday reminder accent.
// Maps to vetted Tailwind class bundles in lib/birthday-colors.ts.
export type BirthdayReminderColor =
  | "purple"
  | "orange"
  | "blue"
  | "green"
  | "neutral";

export type TreatmentGoalStatus = "active" | "reached" | "revised" | "archived";

// Migration 0026: single estimated-total per client. Editing the row in
// place is the supported flow; status moves from active → reached or
// active → revised as the practitioner judges.
export type TreatmentGoal = {
  id: string;
  client_id: string;
  studio_id: string;
  estimated_total_minutes: number;
  notes: string | null;
  status: TreatmentGoalStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioAvailabilityDefault = {
  id: string;
  studio_id: string;
  day_of_week: number; // 0 = Sunday, 6 = Saturday
  is_open: boolean;
  open_time: string | null; // "HH:MM:SS"
  close_time: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioAvailabilityOverride = {
  id: string;
  studio_id: string;
  effective_date: string; // "YYYY-MM-DD"
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioBlockout = {
  id: string;
  studio_id: string;
  starts_on: string;
  ends_on: string;
  reason: string | null;
  created_at: string;
};

// Migration 0030: one-off time-specific blocks (lunch, meeting,
// emergency, etc). Categories are stored lowercase; the UI renders
// them in title case.
export type StudioTimedBlockCategory =
  | "lunch"
  | "break"
  | "meeting"
  | "emergency"
  | "personal"
  | "training"
  | "admin"
  | "other";

export type StudioTimedBlock = {
  id: string;
  studio_id: string;
  starts_at: string;
  ends_at: string;
  category: StudioTimedBlockCategory;
  private_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0031: weekly recurring break rules + materialized
// occurrences. Each occurrence mirrors into
// studio_calendar_reservations with source_kind =
// 'recurring_break_occurrence' so the unified gist exclusion
// enforces it the same way it enforces appointments, one-off
// blocks, and full-day blockouts.
export type StudioRecurringBreakLabel =
  | "lunch"
  | "break"
  | "admin"
  | "other";

export type StudioRecurringBreakRule = {
  id: string;
  studio_id: string;
  label: StudioRecurringBreakLabel;
  days_of_week: number[];
  start_local_time: string;
  end_local_time: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type StudioRecurringBreakOccurrence = {
  id: string;
  rule_id: string | null;
  studio_id: string;
  occurrence_date: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
};

// Migration 0030: unified shadow table. Source_kind covers
// appointment, timed_block, full_day_blockout, and (Phase 2)
// recurring_break_occurrence.
export type StudioCalendarReservationKind =
  | "appointment"
  | "timed_block"
  | "full_day_blockout"
  | "recurring_break_occurrence";

export type StudioCalendarReservation = {
  id: string;
  studio_id: string;
  source_kind: StudioCalendarReservationKind;
  source_id: string;
  starts_at: string;
  ends_at: string;
  // Migration 0134 (practitioner-capacity foundation): GiST partition key
  // (studio_id when OFF, practitioner_id when ON) + provenance practitioner_id.
  resource_key?: string;
  practitioner_id?: string | null;
};

export type Service = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  default_duration_minutes: number;
  price_cents: number | null;
  active: boolean;
  // Migration 0021: free-text modality grouping for the booking menu. Common
  // values: 'electrolysis', 'laser', 'consultation'. Null renders as "Other".
  modality: string | null;
  sort_order: number;
  // Migration 0025: optional pre-care text included in confirmation +
  // reminder emails for appointments of this service.
  pre_care_instructions: string | null;
  created_at: string;
  updated_at: string;
};

// Known modality values surfaced in UI dropdowns. The DB column accepts any
// string, so studios can introduce custom modalities later without a
// migration; KNOWN_MODALITIES is for the picker convenience only.
export type ServiceModality = "electrolysis" | "laser" | "consultation";
export const KNOWN_MODALITIES: ReadonlyArray<{
  value: ServiceModality;
  label: string;
}> = [
  { value: "electrolysis", label: "Electrolysis" },
  { value: "laser", label: "Laser" },
  { value: "consultation", label: "Consultation" },
];

export type AppointmentStatus =
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export type CancelledBy = "client" | "practitioner" | "owner";

export type Appointment = {
  id: string;
  studio_id: string;
  practitioner_id: string | null;
  client_id: string;
  service_id: string | null;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  status: AppointmentStatus;
  notes: string | null;
  cancellation_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: CancelledBy | null;
  created_at: string;
  updated_at: string;
  // Migration 0134 (practitioner-capacity foundation): denormalized mirror of
  // the studio capacity flag, maintained by trigger; routes the row into the
  // studio-wide vs per-practitioner exclusion. Optional for pre-0134 rows.
  capacity_enabled?: boolean;
  // Migration 0025: email tracking + opaque token used in cancel and
  // reschedule URLs.
  confirmation_sent_at: string | null;
  reminder_24h_sent_at: string | null;
  reminder_2h_sent_at: string | null;
  no_show_email_sent_at: string | null;
  confirmation_send_attempts: number;
  reminder_24h_send_attempts: number;
  reminder_2h_send_attempts: number;
  // Migration 0028: attempts counter for the no-show follow-up email,
  // added so the no-show path has the same 3-strike behavior as the others.
  no_show_email_send_attempts: number;
  // Migration 0043: postcare send tracking. sent_at IS NULL means "no
  // send has ever been attempted." The send action's first-send claim
  // is a conditional UPDATE on sent_at IS NULL; the same UPDATE sets
  // sent_at and increments attempts atomically. send_attempts is also
  // incremented on resend.
  postcare_email_sent_at: string | null;
  postcare_email_send_attempts: number;
  // PR #311 (migration 0100): postcare send-state correctness. sent_at is now
  // stamped ONLY after provider success; the claim moved to claimed_at.
  postcare_email_claimed_at: string | null;
  postcare_email_failed_at: string | null;
  postcare_email_last_error: string | null;
  postcare_email_last_attempt_at: string | null;
  // PR #260 (migration 0090): SHA-256 hex hash of the raw
  // cancel/reschedule/manage token — the ONLY token value stored at rest.
  // PR #264 (migration 0091): the legacy raw `cancellation_token` column
  // was dropped; public lookups hash the incoming URL token and match this
  // column, and already-emailed raw links resolve via the backfilled hash.
  cancellation_token_hash: string | null;
  // Migration 0069 (PR #163). Booking attribution: optional answer to
  // "How did you hear about us?" captured at booking time on the
  // public booking form. Internal lowercase value (e.g. "google",
  // "instagram", "friend_or_referral"); see lib/booking/referral-
  // source.ts for the canonical option set. Null on historical rows
  // and when the visitor declined to answer; the field is optional.
  referral_source: string | null;
  // Migration 0029: trailing-only protected interval
  // [starts_at, blocked_ends_at). buffer_minutes_snapshot is a copy
  // of studios.buffer_minutes at the moment the row was inserted or
  // last had its starts_at/ends_at/studio_id changed. Both columns
  // are populated by the snapshot_appointment_buffer trigger; the
  // app never writes them directly. The exclusion constraint
  // enforces non-overlap on this interval per studio.
  buffer_minutes_snapshot: number;
  blocked_ends_at: string;
  // Migration 0049: SMS tracking, parallel to the email tracking
  // above plus an explicit _claimed_at per SMS type. Claim is held
  // by public.claim_sms_send before the Twilio HTTP call; cleared by
  // public.record_sms_result. Stale claims (>5 minutes) are
  // reclaimable, so a crashed sender does not permanently block.
  sms_confirmation_sent_at: string | null;
  sms_confirmation_send_attempts: number;
  sms_confirmation_claimed_at: string | null;
  sms_reminder_24h_sent_at: string | null;
  sms_reminder_24h_send_attempts: number;
  sms_reminder_24h_claimed_at: string | null;
  sms_reminder_2h_sent_at: string | null;
  sms_reminder_2h_send_attempts: number;
  sms_reminder_2h_claimed_at: string | null;
  // Migration 0080 (PR #189): email claim columns, parallel to the
  // SMS _claimed_at columns above. Held by public.claim_email_send
  // before the Resend call; cleared by public.record_email_result.
  // Stale claims (>5 minutes) are reclaimable.
  confirmation_claimed_at: string | null;
  reminder_24h_claimed_at: string | null;
  reminder_2h_claimed_at: string | null;
  // Intake-form reminder idempotency (migration 0098). Same column-based,
  // claim-before-send pattern as the 24h/2h reminders; send_attempts default 0.
  intake_reminder_7d_sent_at: string | null;
  intake_reminder_7d_send_attempts: number;
  intake_reminder_7d_claimed_at: string | null;
  intake_reminder_3d_sent_at: string | null;
  intake_reminder_3d_send_attempts: number;
  intake_reminder_3d_claimed_at: string | null;
  // Migration 0125 (Google Calendar B2.3-a): outbound-sync source-of-truth
  // versioning + reschedule lineage. sync_version is trigger-maintained
  // (bump_appointment_sync_version) and monotonically increases when a
  // serialized field (starts_at/ends_at/status) changes; it is the source
  // version in the deterministic outbox idempotency key. The rescheduled_*
  // lineage + cancellation_kind are written by the reschedule/cancel RPCs in
  // B2.4 (dormant here); the enqueue trigger reads them for carry-forward
  // rebind + delete-vs-reschedule disambiguation. The app never writes
  // sync_version directly.
  sync_version: number;
  rescheduled_from_appointment_id: string | null;
  rescheduled_to_appointment_id: string | null;
  cancellation_kind: string | null;
};

// Migration 0049: SMS types accepted by claim_sms_send and
// record_sms_result. Exported so app code can name the type
// statically instead of stringly-typed.
export type SmsType = "confirmation" | "reminder_24h" | "reminder_2h";

// Migration 0052: client portal foundation. Both tables store only
// SHA-256 hex hashes of their raw tokens; the raw tokens never reach
// the DB. Server actions interact with these tables via the
// service-role admin client; RLS is enabled on both with no policies
// so user-scoped clients see zero rows.
export type ClientPortalMagicLink = {
  id: string;
  studio_id: string;
  client_id: string;
  token_hash: string;
  email_normalized: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
  created_ip_hash: string | null;
  user_agent_hash: string | null;
};

export type ClientPortalSession = {
  id: string;
  studio_id: string;
  client_id: string;
  session_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string | null;
};

// Migration 0053: one-way practitioner → client secure portal
// messages. Subject + body are stored on the row; the body is
// rendered exclusively inside the portal and is never included in
// the notification email. All writes happen via server actions on
// the admin client; the practitioner side is gated by
// getCurrentPractitionerWithStudio() and the portal side by
// getCurrentPortalSession() + (studio_id, client_id) scoping.
export type ClientPortalMessageStatus = "draft" | "published" | "archived";

export type ClientPortalMessage = {
  id: string;
  studio_id: string;
  client_id: string;
  created_by_practitioner_id: string;
  subject: string;
  body: string;
  status: ClientPortalMessageStatus;
  published_at: string;
  client_reviewed_at: string | null;
  notification_email_sent_at: string | null;
  notification_email_error: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0054: client replies to a specific secure portal message.
// Replies hang off a single client_portal_messages row (message_id
// FK). v1 constrains created_by to 'client'; a future practitioner-
// threaded-reply PR (deferred) will widen the enum and CHECK. Reply
// body is rendered exclusively inside Hone; the studio-side
// notification email never includes it. All writes happen via server
// actions on the admin client; the portal side is gated by
// getCurrentPortalSession() + parent-message (studio_id, client_id,
// message_id) match, and the practitioner side is gated by
// getCurrentPractitionerWithStudio() + (studio_id, client_id).
export type ClientPortalMessageReplyCreatedBy = "client";

export type ClientPortalMessageReply = {
  id: string;
  studio_id: string;
  client_id: string;
  message_id: string;
  body: string;
  created_by: ClientPortalMessageReplyCreatedBy;
  practitioner_seen_at: string | null;
  notification_email_sent_at: string | null;
  notification_email_error: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0057: studio-authored consent / e-sign templates. v1
// supports treatment consent, policy acknowledgement, photo
// consent, plus a card-on-file authorization placeholder reserved
// for the future Stripe / card-on-file PR (no payment behaviour
// in this PR). Versioned + status-gated; archived templates hide
// from portal and default practitioner lists but are referenced
// by historical client_consent_signatures via ON DELETE RESTRICT.
export type ConsentTemplateStatus = "draft" | "active" | "archived";
export type ConsentTemplateFormType =
  | "general"
  | "treatment_consent"
  | "policy_acknowledgement"
  | "card_authorization"
  | "photo_consent";

export type ConsentFormTemplate = {
  id: string;
  studio_id: string;
  title: string;
  description: string | null;
  body: string;
  form_type: ConsentTemplateFormType;
  version: number;
  status: ConsentTemplateStatus;
  // PR #167. Decouples client-portal visibility from the
  // practitioner-side status enum. A template only reaches the
  // portal when is_live = true. The DB CHECK constraint guarantees
  // is_live = true implies status = 'active', so a draft / archived
  // row can never be live. Backfill in migration 0072 set is_live
  // = (status = 'active') for every existing row, preserving
  // current portal visibility. New templates default to is_live
  // false on the column and to status 'draft' in
  // createConsentTemplateAction.
  is_live: boolean;
  created_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0057: append-only immutable record of one client
// signing one template at one moment. Snapshot fields capture the
// title / body / version as rendered to the client; template_hash
// is SHA-256 hex over the canonical concatenation built by
// buildConsentTemplateSnapshot(). Multiple signatures of the same
// (client, template) pair are allowed and preserved; the portal +
// practitioner UI surface the latest per template.
//
// Migration 0060 (PR #137) extended the table with response columns
// to support photo_consent allow / deny without mutating prior
// rows. response is always 'accepted' for non-photo forms and
// either 'accepted' or 'denied' for photo_consent forms.
// response_label_snapshot is the human-readable label the client
// chose at sign time (nullable for legacy rows).
export type ClientConsentSignatureResponse = "accepted" | "denied";

export type ClientConsentSignature = {
  id: string;
  studio_id: string;
  client_id: string;
  template_id: string;
  template_title_snapshot: string;
  template_body_snapshot: string;
  template_version: number;
  template_hash: string;
  signature_name: string;
  signed_at: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
  created_at: string;
  response: ClientConsentSignatureResponse;
  response_label_snapshot: string | null;
};

// Migration 0058: card-on-file durable mapping. One active row per
// (studio, client) is enforced by partial unique. Stripe identifiers
// (customer / payment_method / setup_intent / account) are NEVER
// surfaced to the rendered UI; only brand / last4 / exp_month /
// exp_year flow into views. PR #135. Phase 1 stores cards; no
// charges, no PaymentIntents, no refunds, no public-booking
// card-required flow.
export type ClientPaymentMethodStatus = "active" | "removed";
export type ClientPaymentMethodAddedVia = "portal" | "practitioner_recovery";

export type ClientPaymentMethod = {
  id: string;
  studio_id: string;
  client_id: string;
  stripe_account_id: string;
  stripe_livemode: boolean;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  stripe_setup_intent_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  status: ClientPaymentMethodStatus;
  card_authorization_signature_id: string | null;
  added_via: ClientPaymentMethodAddedVia;
  added_at: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AppointmentAudit = {
  id: string;
  appointment_id: string;
  actor_type: "practitioner" | "client" | "system";
  actor_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type Practitioner = {
  id: string;
  studio_id: string;
  user_id: string | null;
  display_name: string;
  email: string;
  role: PractitionerRole;
  active: boolean;
  // Migration 0023: token from lib/practitioner-colors PRACTITIONER_COLORS.
  // Free text in the DB; UI resolves via resolvePractitionerColor.
  color: string;
  // Migration 0027: terms/privacy acceptance stamps (timestamp +
  // accepted document version). Added here by the PR #221 drift
  // check; the columns have existed since 0027.
  terms_accepted_at: string | null;
  terms_version: string | null;
  privacy_accepted_at: string | null;
  privacy_version: string | null;
  // Migration 0079/0116: SHA-256 hash of the calendar feed token — the ONLY
  // at-rest form of the credential. The raw calendar_feed_token column (0046)
  // was dropped in 0116; the raw token is surfaced only once at generate/rotate.
  // The feed route authenticates by hashing the URL's token and matching this.
  calendar_feed_token_hash: string | null;
  // Migration 0084 (PR #203): sticky machine-frequency default.
  // Last-used value, written by the treatment-area save actions;
  // seeds NEW treatment-area drafts. UI default only; the value
  // actually used stays on session_blocks.machine_frequency.
  default_machine_frequency: MachineFrequency | null;
  created_at: string;
};

export type Client = {
  id: string;
  studio_id: string;
  name: string;
  pronouns: string | null;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  fitzpatrick_type: FitzpatrickType | null;
  skin_notes: string | null;
  allergies: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  contraindications: Record<string, unknown> | null;
  photo_consent: boolean;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  // Migration 0050: soft-archive for test/duplicate cleanup. When
  // archived_at is non-null, the client is hidden from active
  // client lists, the calendar quick-book picker, and the birthday
  // surface. The detail page (/clients/[id]) still resolves so the
  // practitioner can un-archive or view history. archived_by is a
  // practitioners.id with on-delete-set-null.
  archived_at: string | null;
  archived_by: string | null;
  // Migration 0049: SMS consent and opt-out. consent_at is stamped
  // when the client explicitly opts in (public booking checkbox or a
  // practitioner action); opt_out_at is stamped by the Twilio inbound
  // STOP webhook or by a practitioner. opt_out takes precedence over
  // consent: a client who has opted out gets no SMS regardless of
  // consent_at. _source CHECK-constrained in migration 0049 to a
  // small allowlist.
  sms_consent_at: string | null;
  sms_consent_source: "public_booking" | "practitioner" | "import" | null;
  sms_opted_out_at: string | null;
  sms_opt_out_source: "twilio_stop" | "practitioner" | null;
  // Migration 0052: lowercased/trimmed email maintained by trigger
  // for portal lookups. Added here by the PR #221 drift check.
  normalized_email: string | null;
};

// Migration 0126 (Willow PR A): dedicated dated CONSULTATION notes + SKIN/HAIR
// ANALYSIS clinical records. Append-only; a correction is a NEW row linked via
// supersedes_note_id (the original is never overwritten). The "latest" of a kind
// is the newest row not superseded by any other row.
export type ClinicalNoteKind = "consultation" | "skin_hair_analysis";

export type ClientClinicalNote = {
  id: string;
  client_id: string;
  studio_id: string;
  practitioner_id: string;
  kind: ClinicalNoteKind;
  body: string;
  areas: string[];
  occurred_at: string;
  supersedes_note_id: string | null;
  created_at: string;
};

// Read-model: a clinical note joined with its author's display name plus a
// derived flag for whether a later revision superseded it. Kept here (not in the
// server-only query module) so client components can import the type.
export type ClinicalNoteWithAuthor = ClientClinicalNote & {
  author_name: string | null;
  is_superseded: boolean;
};

export type ApilusModality =
  | "Multiplex"
  | "Microflash"
  | "Picoflash"
  | "Synchro"
  | "Thermoflash"
  | "Meloflash"
  | "Evolublend"
  | "Omniblend"
  | "Picoblend"
  | "Synchroblend"
  | "Multiblend";

export type ProbeType =
  | "Stainless steel regular"
  | "Stainless steel gold"
  | "IBL"
  | "ITH";
export type MachineFrequency = "13.56 MHz" | "27.12 MHz";

export type SessionRecordStatus = "draft" | "finalized" | "void";
// Migration 0119: provenance. Existing rows are 'legacy' (never finalizable);
// sessions created after rollout default to 'native'. Only native drafts can be
// finalized. legacy_classification is descriptive-only and never affects reads.
export type SessionRecordOrigin = "native" | "legacy";
export type SessionLegacyClassification =
  | "clearly_completed"
  | "clearly_incomplete"
  | "ambiguous";

// Migration 0120 (Clinical Record — Phase 2): corrections & amendments.
export type SnapshotVersionType = "original" | "correction";
export type ClinicalAmendmentType =
  | "late_note"
  | "clarification"
  | "missing_detail"
  | "photo"
  | "other";

// A row of clinical_record_snapshots including Phase 2 lineage fields. Read-only;
// the snapshot JSON itself is never surfaced to ordinary practitioners.
export type ClinicalRecordSnapshotMeta = {
  id: string;
  studio_id: string;
  session_id: string;
  version_no: number;
  content_hash: string;
  hash_algorithm: string;
  canonicalization_version: number;
  finalized_by: string | null;
  finalized_at: string;
  version_type: SnapshotVersionType;
  supersedes_snapshot_id: string | null;
  correction_reason: string | null;
  corrected_by: string | null;
  corrected_by_display_name: string | null;
  corrected_at: string | null;
  created_at: string;
};

export type ClinicalRecordAmendment = {
  id: string;
  studio_id: string;
  session_id: string;
  applies_to_snapshot_id: string;
  amendment_type: ClinicalAmendmentType;
  reason: string;
  body: string | null;
  structured_addition: Record<string, unknown> | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  authored_by: string;
  authored_by_display_name: string | null;
  authored_at: string;
  content_hash: string;
  created_at: string;
};

export type ClinicalAuditEvent = {
  id: string;
  studio_id: string;
  session_id: string;
  operation_type: "correction" | "amendment";
  actor_practitioner_id: string;
  actor_display_name: string | null;
  record_version_before: number | null;
  record_version_after: number | null;
  snapshot_id: string | null;
  previous_snapshot_id: string | null;
  amendment_id: string | null;
  affected_entity_type: string | null;
  affected_entity_ids: string[] | null;
  reason: string | null;
  occurred_at: string;
};

export type Session = {
  id: string;
  studio_id: string;
  client_id: string;
  practitioner_id: string;
  performed_by_practitioner_id: string | null;
  modality: Modality;
  started_at: string;
  started_at_original: string;
  ended_at: string | null;
  session_notes: string | null;
  price_paid_cents: number | null;
  created_at: string;
  // Migration 0119 (Clinical Record — Phase 1): finalization lifecycle. New +
  // existing sessions default to 'draft' (editable). 'finalized' locks the
  // clinical content (DB-enforced) and points at the immutable snapshot.
  record_status: SessionRecordStatus;
  record_origin: SessionRecordOrigin;
  legacy_classification: SessionLegacyClassification | null;
  finalized_at: string | null;
  finalized_by: string | null;
  record_version: number;
  current_snapshot_id: string | null;
  // Migration 0013: soft delete.
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  // Migration 0024: optional attachment to a multi-session treatment plan.
  treatment_plan_id: string | null;
  // Migration 0068: optional link to the appointment that produced this
  // session. Null on historical rows and on client-scoped session
  // creation (no appointment in scope). Server actions validate
  // (studio_id, client_id) lineage before writing this field. One
  // appointment may have zero or more sessions; one session belongs
  // to zero or one appointment. No unique constraint on this column.
  appointment_id: string | null;
  // Migration 0082 (PR #190, clinical memory): plan for the NEXT
  // visit, written while charting this one. Surfaced as "From last
  // visit" context when the client returns. Optional.
  next_session_note: string | null;
  // Migration 0085 (PR #205): explicit, practitioner-marked stamp
  // that procedure/risks were explained and aftercare info provided.
  // Required line on the health-inspection "Client Record for
  // Invasive Procedures" form. Never auto-set.
  aftercare_and_risks_explained_at: string | null;
  aftercare_and_risks_explained_by: string | null;
};

export type TreatmentPlanStatus = "active" | "closed";

// Migration 0024: tracks multi-session electrolysis work against a target
// visit count. Sessions opt in via sessions.treatment_plan_id.
//
// Migration 0034 (Treatment Plan v2 schema, Phase B): adds three nullable
// columns — budget_notes, practitioner_notes, treatment_goal_minutes_override.
// suggested_visit_count is retained as NOT NULL; the legacy
// "Estimated visits" UI keeps writing it. Stage data (cadence + visit
// length + duration) lives on the child treatment_plan_stages table.
export type TreatmentPlan = {
  id: string;
  client_id: string;
  studio_id: string;
  name: string;
  suggested_visit_count: number;
  status: TreatmentPlanStatus;
  created_by_practitioner_id: string | null;
  closed_by_practitioner_id: string | null;
  created_at: string;
  closed_at: string | null;
  // Migration 0034 additive columns (nullable; legacy rows are still valid).
  budget_notes: string | null;
  practitioner_notes: string | null;
  treatment_goal_minutes_override: number | null;
  // Migration 0038 (Body Chart v1 Phase A): optional structured primary
  // area for this plan, e.g. "Chin" or "Underarms". Free-form 1..60
  // chars; the practitioner UI uses lib/constants.ts AREA_REGIONS as
  // the canonical picker but "Other" + custom strings are allowed.
  // Migration 0051 keeps this column for backward compatibility: every
  // multi-area writer mirrors the first selected area into primary_area
  // so legacy readers (session area defaulting, banner fallback, data
  // export) still resolve to a single canonical area string.
  primary_area: string | null;
  // Migration 0051: multi-area + month-timeline reframing.
  //
  // treatment_areas: ordered list of structured areas this plan
  //   treats. NULL or empty means "use primary_area as the single
  //   area" (legacy plans). When non-empty, areas[0] mirrors
  //   primary_area for backward compatibility. Cap is 12 elements
  //   (DB CHECK).
  // estimated_timeline_months_min / _max: optional months estimate
  //   for the whole plan. Reminder/display only; not a clinical
  //   guarantee. Either side may be NULL (one-sided estimates allowed);
  //   when both are present min <= max (DB CHECK). Each side is
  //   constrained to 1..60 months.
  treatment_areas: string[] | null;
  estimated_timeline_months_min: number | null;
  estimated_timeline_months_max: number | null;
};

// Migration 0034: one stage of a treatment plan. A plan can contain
// multiple stages (e.g. weekly 15-min visits for 3 months, then monthly
// maintenance visits for 12 months). studio_id is denormalized for RLS
// and is always derived from the parent plan by a BEFORE trigger.
export type TreatmentPlanStageHowOftenUnit =
  | "weekly"
  | "every_2_weeks"
  | "monthly";
export type TreatmentPlanStageLengthUnit = "weeks" | "months";

export type TreatmentPlanStage = {
  id: string;
  plan_id: string;
  studio_id: string;
  sort_order: number;
  name: string | null;
  how_often_unit: TreatmentPlanStageHowOftenUnit;
  visit_length_minutes: number;
  stage_length_value: number;
  stage_length_unit: TreatmentPlanStageLengthUnit;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionAudit = {
  id: string;
  session_id: string;
  edited_by_practitioner_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  edited_at: string;
};

export type ElectrolysisEntry = {
  id: string;
  session_id: string;
  // Legacy single-area field. Always populated for backwards compatibility
  // (first entry of `areas`). New code should prefer `areas`.
  area: string;
  // Migration 0017: multiple areas treated with the same settings.
  areas: string[] | null;
  probe_size: string | null;
  probe_lot_id: string | null;
  mode: ElectrolysisMode | null;
  intensity: number | null;
  duration_seconds: number | null;
  pulse_count: number;
  // Seconds between high-frequency pulses; only set when pulse_count > 1
  // (0.03–1.90s). NULL for single-pulse entries and pre-0102 rows.
  pulse_delay_seconds: number | null;
  comments: string | null;
  // Migration 0108: structured treatment-observation chips (array of canonical
  // chip labels; see lib/observation-chips.ts). Free-text notes stay in
  // `comments`. Defaults to [] for legacy rows. Read via normalizeChips().
  observation_chips: string[];
  // Migration 0011: parameters moved from session level to entry level.
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  machine_frequency: MachineFrequency | null;
  // Migration 0012: optional total hair count per entry.
  hairs_treated: number | null;
  // Migration 0019: pointer to the block this entry belongs to. Nullable
  // because legacy rows existed before blocks; 0020 backfilled them. All
  // new inserts get a block_id via ensureEntryHasBlock().
  block_id: string | null;
  created_at: string;
  // Migration 0042 (Session Logging Phase 3): structured blend / galvanic
  // readings. All nullable and additive; legacy rows are unaffected and the
  // generic intensity / duration_seconds above are kept for them.
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
  galvanic_intensity_percent: number | null;
  thermolysis_intensity_percent: number | null;
  thermolysis_duration_seconds: number | null;
  units_of_lye: number | null;
  // Migration 0114: audited soft-delete ("Remove/void pass"). A voided pass is
  // hidden from all active views but the row is preserved. NULL = active.
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
};

// Migration 0019: block-level treatment params. SessionMode mirrors the
// existing ElectrolysisMode values (thermo / blend / galv).
export type SessionMode = ElectrolysisMode;

// Body Chart v1 Phase B (migration 0039): structured anatomical area
// metadata for analytics. `side` is a small closed enum enforced by a DB
// CHECK; the other two columns are length-bounded free text. All three
// are nullable and additive — legacy blocks are unaffected.
export type SessionBlockSide =
  | "center"
  | "left"
  | "right"
  | "bilateral"
  | "n/a";

// Migration 0128 (Willow charting): multiple treated areas per settings block,
// each with its own laterality. Additive child of session_blocks; studio_id is
// trigger-derived from the parent block. See lib/sessions/block-areas.ts.
export type SessionBlockArea = {
  id: string;
  session_block_id: string;
  studio_id: string;
  area: string;
  laterality: "left" | "right" | "bilateral" | "midline" | "not_applicable";
  display_order: number;
  created_at: string;
};

export type SessionBlock = {
  id: string;
  studio_id: string;
  session_id: string;
  sort_order: number;
  block_name: string | null;
  block_notes: string | null;
  mode: SessionMode | null;
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  probe_type: ProbeType | null;
  probe_size: string | null;
  machine_frequency: MachineFrequency | null;
  started_at: string | null;
  ended_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  created_at: string;
  updated_at: string;
  // Migration 0039 additive columns (nullable; legacy rows are still valid).
  primary_area: string | null;
  side: SessionBlockSide | null;
  custom_area_detail: string | null;
  // Migration 0041 (Session Logging Phase B): structured probe taxonomy.
  // A single validated probe choice from the lib/probes.ts catalog,
  // decomposed for analytics. All nullable and additive; legacy rows
  // (and the legacy probe_type / probe_size above) are unaffected.
  probe_key: string | null;
  probe_brand: string | null;
  probe_material: string | null;
  probe_piece_type: string | null;
  probe_shank: string | null;
  probe_size_value: string | null;
  probe_length: string | null;
  probe_label: string | null;
  // Migration 0085 (PR #205): lot/batch number of the probe used on
  // this treatment area, read off the box while charting. Required
  // by the health-inspection client procedure record. Optional text.
  probe_lot_number: string | null;
  // Migration 0082 (PR #190, clinical memory): structured client
  // response per block. All nullable / safely defaulted; legacy rows
  // render without these lines. reaction_type allowlist lives in
  // lib/sessions/clinical-response.ts and the 0082 CHECK constraint.
  tolerance_rating: number | null;
  reaction_type: string | null;
  reaction_notes: string | null;
  caution_for_next_session: boolean;
  caution_note: string | null;
  // Migration 0095 (PR #279, Chloe charting feedback). numbing_status is NULL
  // for every legacy row ("Not recorded"); 'none' = no numbing used; 'used' =
  // numbing used. probe_lot_confirmed records that the practitioner confirmed
  // the probe lot/batch for this treatment (vs suggested-from-records or typed
  // but unconfirmed); legacy rows default to false. Allowlist + default live in
  // the 0095 CHECK + lib/sessions/clinical-response.ts.
  numbing_status: NumbingStatus | null;
  probe_lot_confirmed: boolean;
};

export type LaserEntry = {
  id: string;
  session_id: string;
  zone: string;
  session_number: number | null;
  equipment_params: Record<string, unknown> | null;
  observation_notes: string | null;
  ejection_results: string | null;
  created_at: string;
  // Migration 0114: audited soft-delete ("Remove/void pass"). NULL = active.
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
};

export type ProbeLot = {
  id: string;
  studio_id: string;
  probe_size: string;
  lot_number: string | null;
  expiry_date: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
};

export type ClientPricing = {
  id: string;
  studio_id: string;
  client_id: string | null;
  service_name: string;
  price_cents: number;
  notes: string | null;
  effective_from: string;
};

export type Photo = {
  id: string;
  studio_id: string;
  client_id: string;
  session_id: string | null;
  area: string | null;
  storage_path: string;
  photo_type: PhotoType | null;
  taken_at: string;
};

// Migration 0092 (PR #271): secure treatment image storage. Practitioner-only
// metadata for images held in the PRIVATE `treatment-images` bucket; access is
// always server-side service-role + signed URL after a studio-ownership check.
// Column set must match the 0092 migration exactly (check-db-types gate).
export type TreatmentImage = {
  id: string;
  studio_id: string;
  client_id: string;
  session_id: string | null;
  session_block_id: string | null;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  content_type: string;
  size_bytes: number;
  uploaded_by: string | null;
  // Optional practitioner-authored note/caption (migration 0099). Free text,
  // capped at 1000 chars by the update action; NULL = no note.
  practitioner_note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
};

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type PendingInvitation = {
  id: string;
  studio_id: string;
  email: string;
  invited_by: string | null;
  role: PractitionerRole;
  display_name: string | null;
  status: InvitationStatus;
  created_at: string;
  accepted_at: string | null;
};

// Migration 0022: practitioner-authored short notes pinned to a client and
// surfaced everywhere that client appears (profile, appointment detail,
// today's roster). No edit-in-place: remove and re-add to change.
export type ClientPinnedNote = {
  id: string;
  client_id: string;
  studio_id: string;
  text: string;
  created_by_practitioner_id: string | null;
  created_at: string;
};

// Migration 0035: practitioner-only relationship memory + sensitive
// warnings. One row per client (UNIQUE on client_id). studio_id is
// derived from the parent client by trigger; the row is created lazily
// on first save. These fields are NEVER exposed to client/public/email
// surfaces — see the privacy contract in the migration comment and the
// import audit in PR #27.
export type ClientPersonalNotes = {
  id: string;
  client_id: string;
  studio_id: string;
  personal_notes: string;
  private_warnings: string;
  updated_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ClientTag = {
  id: string;
  studio_id: string;
  client_id: string;
  label: string;
  color: string | null;
  created_at: string;
  created_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
};

export type IntakeStatus = "in_progress" | "submitted" | "reviewed";

export type ClientIntakeForm = {
  id: string;
  studio_id: string;
  client_id: string;
  status: IntakeStatus;
  current_step: number;
  responses: Record<string, unknown>;
  started_at: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  practitioner_notes: string | null;
  deleted_at: string | null;
  // Practitioner-triggered reissue audit (migration 0044). Both null
  // when the row was created by the booking-confirmation flow.
  requested_at: string | null;
  requested_by: string | null;
  // Intake link send/expiry display metadata (migration 0097). A display
  // mirror of the most recently issued link — the signed token remains the
  // authoritative expiry. last_sent_at/expires_at are null on legacy rows and
  // until the next mint; send_count defaults to 0.
  intake_link_last_sent_at: string | null;
  intake_link_expires_at: string | null;
  intake_link_send_count: number;
  created_at: string;
  updated_at: string;
};

export type AuditLog = {
  id: string;
  studio_id: string;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

// Migration 0070 (PR #164). Practitioner notification center.
// Business events for the practitioner workflow (new booking, client
// cancellation, client reschedule). Studio-wide visibility in v1;
// practitioner_id is stored but not yet used for per-practitioner
// filtering. Writes happen via the server-only helper in
// lib/notifications/practitioner-notifications.ts; reads + mark-read
// happen via the authenticated RLS client.
export type PractitionerNotificationEventType =
  | "new_booking"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "intake_submitted";

export type PractitionerNotification = {
  id: string;
  studio_id: string;
  practitioner_id: string | null;
  event_type: string;
  title: string;
  body: string | null;
  appointment_id: string | null;
  client_id: string | null;
  href: string | null;
  read_at: string | null;
  created_at: string;
};

// Migration 0085 (PR #205): health-inspection record keeping.
// Studio-scoped operational logbooks behind is_studio_member RLS.
// Practitioner-facing only; never exposed on public/portal surfaces.

export type RecordKeepingSterileItem = {
  id: string;
  studio_id: string;
  date_purchased: string;
  item_description: string;
  manufacturer_name: string;
  amount_purchased: string;
  lot_number: string;
  expiry_date: string | null;
  notes: string | null;
  created_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RecordKeepingDisinfectant = {
  id: string;
  studio_id: string;
  date_prepared: string;
  disinfectant_name: string;
  concentration: string;
  date_discarded: string | null;
  // Migration 0096 (PR #280): the date this batch must be replaced/discarded by.
  // Distinct from date_prepared (made) and date_discarded (actually discarded).
  // Drives a read-time due/overdue alert; nullable, legacy rows read safely.
  discard_due_date: string | null;
  operator_practitioner_id: string | null;
  operator_name: string;
  notes: string | null;
  created_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

// SENSITIVE: personal/health information. Studio RLS only; no public
// or client-portal surface may ever import readers of this table.
export type RecordKeepingExposureIncident = {
  id: string;
  studio_id: string;
  incident_date: string;
  exposed_person_full_name: string;
  exposed_person_address: string;
  exposed_person_phone: string;
  exposure_details: string;
  action_taken: string;
  staff_involved_name: string;
  notes: string | null;
  created_by_practitioner_id: string | null;
  created_at: string;
  updated_at: string;
};

// Migration 0086 (PR #206): append-only Record Keeping audit trail.
// Rows are written ONLY by security-definer triggers; RLS exposes a
// studio-scoped SELECT and nothing else, so normal users can never
// insert, edit, or delete events.
export type RecordKeepingAuditEvent = {
  id: string;
  studio_id: string;
  record_type:
    | "sterile_item"
    | "disinfectant"
    | "exposure_incident"
    | "session_aftercare"
    | "session_block_probe_lot";
  record_id: string;
  action:
    | "created"
    | "updated"
    | "aftercare_marked"
    | "aftercare_cleared"
    | "probe_lot_updated";
  changed_fields: string[];
  changes: Record<string, { old: unknown; new: unknown }>;
  actor_practitioner_id: string | null;
  actor_user_id: string | null;
  actor_display_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// Migration 0089 (PR #252): Imported Treatment Memory. A safe
// destination for historical treatment memory migrated from paper
// cards / Jane / Fresha / spreadsheets -- distinct from live charting.
// Imports are migration/editing data, so correction is soft voiding
// (voided_at / voided_by / void_reason), never hard delete. The batch
// is the unit of void/rollback.
export type ImportSourceType =
  | "paper_card"
  | "jane"
  | "fresha"
  | "spreadsheet"
  | "other";

export type ImportBatch = {
  id: string;
  studio_id: string;
  source_type: ImportSourceType;
  source_system: string | null;
  source_label: string | null;
  row_count: number | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  updated_at: string;
};

export type ImportedTreatmentMemory = {
  id: string;
  studio_id: string;
  client_id: string;
  import_batch_id: string;
  source_type: ImportSourceType;
  source_system: string | null;
  source_label: string | null;
  source_row_number: number | null;
  // Clean parsed visit date; occurred_on_text preserves messy original.
  occurred_on: string | null;
  occurred_on_text: string | null;
  treatment_area_text: string | null;
  modality: string | null;
  method_or_machine: string | null;
  probe_type: string | null;
  probe_size: string | null;
  probe_lot: string | null;
  tolerance_text: string | null;
  reaction_text: string | null;
  caution_note: string | null;
  next_visit_note: string | null;
  aftercare_marked: boolean | null;
  imported_note: string | null;
  imported_by: string | null;
  imported_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};

// Append-only audit trail for the import domain (dedicated, separate
// from RecordKeepingAuditEvent). Rows written ONLY by a security-definer
// trigger; RLS exposes a studio-scoped SELECT and nothing else.
export type ImportedTreatmentMemoryAuditEvent = {
  id: string;
  studio_id: string;
  record_type: "import_batch" | "imported_treatment_memory";
  record_id: string;
  action: "created" | "updated";
  changed_fields: string[];
  changes: Record<string, { old: unknown; new: unknown }>;
  actor_practitioner_id: string | null;
  actor_user_id: string | null;
  actor_display_name: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

// Google Calendar — Phase B, PR B1 (migration 0124). SCHEMA-ONLY types; NO
// runtime code reads or writes these tables in B1 (they document the dormant
// outbound-sync foundation for B2/B3).
export type CalendarEventLinkSyncStatus =
  | "pending"
  | "synced"
  | "conflict"
  | "error"
  | "deleted";

export type CalendarEventLink = {
  id: string;
  studio_id: string;
  connection_id: string;
  hone_entity_type: "appointment" | "timed_block";
  hone_entity_id: string;
  google_calendar_id: string;
  google_event_id: string | null;
  google_ical_uid: string | null;
  source_system: "hone" | "google";
  last_hone_version: number; // metadata only in B1
  google_etag: string | null;
  sync_status: CalendarEventLinkSyncStatus;
  last_sync_direction: "hone_to_google" | "google_to_hone" | null;
  last_synced_at: string | null;
  last_error_code: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CalendarSyncOutboxOpType =
  | "event.create"
  | "event.update"
  | "event.delete"
  | "full.resync";

// Four-state model ONLY (no 'failed'). pending/processing/done/dead.
export type CalendarSyncOutboxStatus = "pending" | "processing" | "done" | "dead";

export type CalendarSyncOutbox = {
  id: string;
  studio_id: string;
  connection_id: string;
  op_type: CalendarSyncOutboxOpType;
  hone_entity_type: "appointment" | "timed_block" | null;
  hone_entity_id: string | null;
  // Operational metadata ONLY — never PHI/tokens/raw Google content. B2 builds
  // this server-side via a fixed allow-listed serializer from typed params.
  payload: Record<string, unknown>;
  idempotency_key: string; // deterministic; {type}:{id}:{op}:{source_version}
  status: CalendarSyncOutboxStatus;
  priority: number; // 0..1000; LOWER = higher priority; default 100
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  processed_at: string | null; // set ONLY on 'done'
  created_at: string;
  updated_at: string;
};
