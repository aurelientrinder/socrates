import { CourseCalendar } from "@/components/course-calendar";
import { CoursesView } from "@/components/courses-view";
import { ExamLibrary } from "@/components/exam-library";
import { NotesView } from "@/components/notes-view";
import { LIBRARY_TABS, PageFrame, PageTabs } from "@/components/page-header";
import { SessionLibrary } from "@/components/session-library";

/**
 * LIBRARY (redesign wave, 2026-10-26): what you have studied from and
 * studied in — the courses (a group of notes per class), the imported notes (the old Notes page) and every session,
 * searchable, beyond the sidebar's short recent list, and the mock exams.
 * The Calendar tab (2026-10-29) is the learner's calendar as a week grid,
 * where each event is filed under a class by hand.
 * /notes redirects here.
 */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
	const { tab } = await searchParams;
	const calendar = tab === "calendar";
	return (
		<PageFrame title="Library" testId="library-page" width={calendar ? "max-w-[78rem]" : undefined}>
			<PageTabs tabs={LIBRARY_TABS} active={calendar ? "calendar" : "overview"} />
			{calendar ? (
				<CourseCalendar />
			) : (
				<>
					<CoursesView />
					<NotesView />
					<ExamLibrary />
					<SessionLibrary />
				</>
			)}
		</PageFrame>
	);
}
