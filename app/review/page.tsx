import { redirect } from "next/navigation";

// The Review page is the Memory tab of Progress now (redesign wave).
export default function ReviewPage() {
	redirect("/progress");
}
