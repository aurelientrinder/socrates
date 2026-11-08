import { notFound } from "next/navigation";
import { ClassView } from "@/components/class-view";
import { classPage } from "@/src/server";

export const dynamic = "force-dynamic";

/** One class: its exam, what you know, its plan, sessions and notes (QoL pass, 2026-11-08). */
export default async function ClassPage({ params }: { params: Promise<{ key: string }> }) {
	const { key: raw } = await params;
	let key = raw;
	try {
		key = decodeURIComponent(raw);
	} catch {
		// keep the raw key
	}
	const data = classPage(key);
	if (!data) notFound();
	return <ClassView data={data} />;
}
