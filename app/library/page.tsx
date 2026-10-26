import { NotesView } from "@/components/notes-view";
import { PageFrame } from "@/components/page-header";
import { SessionLibrary } from "@/components/session-library";

/**
 * LIBRARY (redesign wave, 2026-10-26): what you have studied from and
 * studied in — the imported notes (the old Notes page) and every session,
 * searchable, beyond the sidebar's short recent list. /notes redirects here.
 */
export default function LibraryPage() {
	return (
		<PageFrame title="Library" testId="library-page">
			<NotesView />
			<SessionLibrary />
		</PageFrame>
	);
}
