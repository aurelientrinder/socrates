"use client";
import { QuestionDock } from "@/components/question-dock";
import { StatsBar } from "@/components/stats-bar";
const input = {
	question: "Un oscillateur non amorti est formé d'une masse $m$ fixée à un ressort linéaire de raideur $k$ ; sa pulsation propre est $\\omega_0$. On double la masse en gardant le même ressort. Quelle est la nouvelle pulsation propre, en fonction de $\\omega_0$ ?",
	options: [{ label: "$\\omega_0/\\sqrt{2}$" }, { label: "$\\omega_0/2$" }, { label: "$\\omega_0$" }, { label: "$\\omega_0\\sqrt{2}$" }],
	correctAnswer: "$\\omega_0$",
	explanation: "x",
};
export default function P() {
	return (
		<div className="mx-auto mt-40 mb-8 max-w-[640px] rounded-2xl border bg-card shadow-lg">
			<QuestionDock toolName="quiz" toolCallId="q1" input={input as never} expanded onExpand={() => {}} onSubmit={() => {}} warmup={{ step: 1, total: 1, onSkip: () => {} }}
				tools={<StatsBar turns={[]} dictationSlot={<button className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground">🎙 Dictate</button>} flat />} />
		</div>
	);
}
