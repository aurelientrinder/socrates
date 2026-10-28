import { notFound } from "next/navigation";
import { ExamPaper } from "@/components/exam-view";
import { getExamView } from "@/src/server";

export const dynamic = "force-dynamic";

/** One mock exam: its progress while written, its cover, the paper, the marked results. */
export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = getExamView(id);
	if (!view) notFound();
	return <ExamPaper key={view.id} initial={view} />;
}
