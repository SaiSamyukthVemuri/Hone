/** WHO a draft belongs to: practitioner id + studio id of the signed-in session. The client sends the scope its saver was created under with every save and discard, and the server refuses when the session no longer matches (another user signed in, in another tab). */
export function draftScope(practitionerId: string, studioId: string): string {
  return `${practitionerId}:${studioId}`;
}
