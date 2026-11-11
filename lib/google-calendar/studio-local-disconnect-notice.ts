// The ONE sentence pair shown after a studio-local Google Calendar disconnection, whoever did it: the member from their own settings, or the
// owner after removing a team member. Sam's decision (Vercel finding 01M6SPYTZ01MAGB74CGWVV953E): disconnection removes THIS studio's stored
// credentials and stops its sync, and never revokes the grant at Google, so Google authorization may remain. It must not say the account
// was "disconnected from Google", and it names no other studio.
export const STUDIO_LOCAL_DISCONNECT_NOTICE =
  "This studio's stored Google credentials were removed and its sync has stopped. Google authorization may remain; it can be removed in Google account settings, under Security, then Third-party apps and services.";
