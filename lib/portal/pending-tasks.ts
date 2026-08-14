// Pure computation of a client's outstanding PORTAL tasks for the practitioner
// status card (Portal Access PR 3). Derived entirely from data the client
// profile already loads: intake status, active consent templates + latest
// signatures, and portal messages, so it adds NO queries and NO clinical
// content (only counts + one boolean). Kept intentionally small: quick status,
// not an audit timeline.

export type PortalPendingTasks = {
  // Intake started but not yet submitted by the client.
  intakeIncomplete: boolean;
  // Active consent templates the client has not signed at the current version
  // (covers both "never signed" and "signed an older version" = outdated).
  consentToSignCount: number;
  // Published portal messages the client has not yet opened.
  unreadMessageCount: number;
  hasAny: boolean;
};

export function computePortalPendingTasks(input: {
  intakeStatus: string | null | undefined;
  activeConsentTemplates: Array<{ id: string; version: number; status?: string }>;
  latestSignatures: Array<{ template_id: string; template_version: number }>;
  portalMessages: Array<{
    status: string;
    client_reviewed_at: string | null;
    archived_at?: string | null;
  }>;
}): PortalPendingTasks {
  const intakeIncomplete = input.intakeStatus === "in_progress";

  // A template is satisfied only when a signature exists at its CURRENT version.
  const signedAtCurrent = new Set(
    (input.latestSignatures ?? []).map(
      (s) => `${s.template_id}:${s.template_version}`,
    ),
  );
  const consentToSignCount = (input.activeConsentTemplates ?? [])
    .filter((t) => (t.status ? t.status === "active" : true))
    .filter((t) => !signedAtCurrent.has(`${t.id}:${t.version}`)).length;

  const unreadMessageCount = (input.portalMessages ?? []).filter(
    (m) =>
      m.status === "published" &&
      m.client_reviewed_at == null &&
      !m.archived_at,
  ).length;

  return {
    intakeIncomplete,
    consentToSignCount,
    unreadMessageCount,
    hasAny:
      intakeIncomplete || consentToSignCount > 0 || unreadMessageCount > 0,
  };
}
