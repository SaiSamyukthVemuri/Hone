"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { quickBlockScopeFor, type BlockScopeNames } from "@/lib/calendar/block-scope";
import { QuickBlockDrawer, type QuickBlockDraft } from "./QuickBlockDrawer";

// Block time from the views that have no time grid (the by-practitioner Week and the Month). The time-grid
// views start it from a drag or the phone's "+"; without this an owner on these two views could not reserve
// time. It opens the same drawer, with the same who-it-blocks rule, on the selected date.
export function CalendarBlockTime({ showTrigger = true, date, studioTimezone, blockScopeNames, isOwner, currentPractitionerId, currentPractitionerName }: {
  showTrigger?: boolean; date: string; studioTimezone: string; blockScopeNames: BlockScopeNames | undefined; isOwner: boolean;
  currentPractitionerId: string; currentPractitionerName: string;
}) {
  const [draft, setDraft] = useState<QuickBlockDraft | null>(null);
  return <>
    {showTrigger && (
      <Button type="button" size="sm" variant="secondary"
        onClick={() => setDraft({ localDate: date, startLocal: "12:00", endLocal: "12:30" })}>
        Block time
      </Button>
    )}
    <QuickBlockDrawer open={draft !== null} draft={draft}
      studioTimezone={studioTimezone} onClose={() => setDraft(null)}
      scope={quickBlockScopeFor({ names: blockScopeNames, isOwner, currentPractitionerId, currentPractitionerName })} />
  </>;
}
