// What the session charting page shows for the Current / New switch, decided in one place so turning the rollout off can be
// tested end to end. `readMetadata` is called ONLY when the switch is available, so a hidden switch costs no extra
// read, and a stored "new" can never leak through a closed rollout. A failed read means Current.
import { resolveChartingView, type ChartingView } from "@/lib/charting/view-preference";

export async function chartingViewForPage(o: {
  /** The server's rollout answer for this studio (lib/rollouts/charting-rollout.ts): an error is already false. */
  rolloutOn: boolean;
  readMetadata: () => Promise<unknown>;
}): Promise<{ toggleVisible: boolean; view: ChartingView }> {
  if (!o.rolloutOn) return { toggleVisible: false, view: "current" };
  let metadata: unknown;
  try {
    metadata = await o.readMetadata();
  } catch {
    metadata = undefined;
  }
  return resolveChartingView(metadata, true);
}
