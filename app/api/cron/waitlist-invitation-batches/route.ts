import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { runRounds } from "@/lib/waitlist/over-invite-run";

// Sends the owner's CONFIRMED over-invite batches. It processes what the owner already confirmed and nothing else: it creates no batch and adds no
// recipient, and a batch only exists because an owner confirmed it. Rounds run per studio round-robin (the claim's own fairness) until no item is
// pending or the time budget is spent; the next invocation continues, and an item claimed but never issued returns to the queue when its lease
// expires. It returns counts only: no name, email, token or id. SMS is not part of this route.
// 60 seconds is the most a Hobby serverless function may run; the budget leaves room for the round in flight to finish.
export const maxDuration = 60;
export const OVER_INVITE_CRON_BUDGET_MS = 40_000;

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const summary = await runRounds({ budgetMs: OVER_INVITE_CRON_BUDGET_MS });
  return NextResponse.json({ ok: true, ...summary });
}
