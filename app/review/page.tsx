import { ReviewView } from "@/components/review-view";
import { retentionAcrossSessions } from "@/src/server";

// Dynamic: retention decays with the clock and every visit re-reads the
// session records, so the view is always as of now.
export const dynamic = "force-dynamic";

export default function ReviewPage() {
	return <ReviewView report={retentionAcrossSessions()} />;
}
