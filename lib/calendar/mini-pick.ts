// A mini-calendar pick is a link, so when the picked date is the one the server already renders the URL
// does not change and nothing re-renders. The mobile day view keeps a local strip selection that such a
// pick must still reset, so the pick is also announced in the browser. Client-only; carries one date.
export const MINI_PICK_EVENT = "hone:calendar-mini-pick";

export function announceMiniPick(date: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(MINI_PICK_EVENT, { detail: date }));
}
