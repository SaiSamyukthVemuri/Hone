"use client";

import { createContext, useContext } from "react";

// Read-only pages share navigation with the queue, without loading its invitation composer.
export const InvitePendingContext = createContext(false);

export function useInviteOutcomePending(): boolean {
  return useContext(InvitePendingContext);
}
