import { notFound } from "next/navigation";
import { CheatSheetPage } from "@/components/cheatsheet-view";
import { getSheet } from "@/src/server";

export const dynamic = "force-dynamic";

/** One exam cheat sheet: its progress while written, then the sheet with each line marked. */
export default async function SheetPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const sheet = getSheet(id);
	if (!sheet) notFound();
	return <CheatSheetPage key={sheet.id} initial={sheet} />;
}
