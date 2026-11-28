// HON-130: autosaved note drafts are OFF everywhere until the privacy and terms pages are live and Sam turns them on.
// SERVER-ONLY allow-list (a comma-separated list of studio ids in HONE_NOTE_DRAFTS_STUDIO_IDS), never a client-visible flag.
// Unset, empty or malformed means OFF in every environment. While OFF the draft commands refuse with the closed code
// "disabled" and store nothing, and the page renders no autosave.
export const NOTE_DRAFTS_STUDIOS_ENV = "HONE_NOTE_DRAFTS_STUDIO_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function noteDraftsEnabledFor(studioId: string, raw: string | undefined = process.env[NOTE_DRAFTS_STUDIOS_ENV]): boolean {
  if (!raw || !UUID.test(studioId)) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID.test(s))
    .includes(studioId.toLowerCase());
}
