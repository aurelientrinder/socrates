import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Socrates",
		short_name: "Socrates",
		description: "A learning harness with a memory — FSRS-6 reviews, flashcards, and a knowledge map.",
		start_url: "/mobile",
		display: "standalone",
		background_color: "#faf9f5",
		theme_color: "#1c1917",
		icons: [
			{
				src: "/icon.svg",
				sizes: "any",
				type: "image/svg+xml",
				purpose: "any",
			},
		],
	};
}
