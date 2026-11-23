import type { ReactNode } from "react";

// HON-40 shell contract, step 0: the MOUNT POINT for the once-per-page notification host (subscription,
// toast queue, live count). Mounted in layout.tsx above BOTH header containers, because the header
// renders every control twice (one per header mode) and a subscription or toast host inside a control
// would run twice. It is a pass-through today. HON-106 owns this file and replaces the body; the props
// below are the contract:
//   initialPersistedUnread  the server-read count of unread persisted notifications for this viewer
//   computedUnread          the computed overdue-disinfectant count (no row, no event); a live count
//                           must never drop it, only the persisted part is live
export function NotificationsProvider({
  children,
}: {
  initialPersistedUnread: number;
  computedUnread: number;
  children: ReactNode;
}) {
  return <>{children}</>;
}
