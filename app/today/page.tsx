import { redirect } from "next/navigation";

// Today is the home screen now (redesign wave).
export default function TodayRedirect() {
	redirect("/");
}
