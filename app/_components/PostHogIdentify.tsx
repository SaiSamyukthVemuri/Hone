"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

// Identifies the authenticated practitioner in PostHog on each authenticated
// page load. Mounted only inside the (app) layout — the same safe-routes
// boundary as SafeAnalytics — so it never runs on token-bearing public routes.
export function PostHogIdentify({
  userId,
  role,
}: {
  userId: string;
  role: string;
}) {
  useEffect(() => {
    posthog.identify(userId, { role });
  }, [userId, role]);

  return null;
}
