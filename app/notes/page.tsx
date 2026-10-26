import { redirect } from "next/navigation";

// The Notes page is part of the Library now (redesign wave).
export default function NotesPage() {
	redirect("/library");
}
