"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { quickBlockScopeFor, type BlockScopeNames } from "@/lib/calendar/block-scope";
import { QuickBlockDrawer } from "./QuickBlockDrawer";

// Block time from the views that have no time grid (the by-practitioner Week and the Month). The time-grid
// views start it from a drag or the phone's "+"; without this an owner on these two views could not reserve
// time. It opens the same drawer, with the same who-it-blocks rule, on the selected date.
export function CalendarBlockTime({ date, studioTimezone, blockScopeNames, isOwner, currentPractitionerId, currentPractitionerName }: {
  date: string; studioTimezone: string; blockScopeNames: BlockScopeNames | undefined; isOwner: boolean;
  currentPractitionerId: string; currentPractitionerName: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>Block time</Button>
    <QuickBlockDrawer open={open} draft={open ? { localDate: date, startLocal: "12:00", endLocal: "12:30" } : null}
      studioTimezone={studioTimezone} onClose={() => setOpen(false)}
      scope={quickBlockScopeFor({ names: blockScopeNames, isOwner, currentPractitionerId, currentPractitionerName })} />
  </>;
}
