import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono, Source_Sans_3, Source_Serif_4 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { ReviewReminder } from "@/components/review-reminder";

// Two typeface sets (globals.css picks by <html data-typeface>). Classic:
// chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN). Claude:
// chrome = DM Sans, prose + titles = Source Serif 4 — open-licensed
// stand-ins for the Claude app's proprietary Anthropic Sans/Serif. Code
// is JetBrains Mono in both.
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });
const claudeSans = DM_Sans({ subsets: ["latin"], variable: "--font-claude-sans" });
const claudeSerif = Source_Serif_4({ subsets: ["latin"], variable: "--font-claude-serif" });

/** Pre-paint theme script: sets <html class="dark"> and data-typeface from
 *  the last applied appearance BEFORE the first frame, so a light (or dark)
 *  user never sees the other palette flash. Sources, best first: the
 *  desktop shell's persisted theme (window.lh.bootTheme — the server port,
 *  and so the page's storage origin, changes every desktop launch), then
 *  this browser's localStorage copy. AppearanceProvider writes both and
 *  takes over once the settings record loads. Defaults = the factory. */
const BOOT_THEME_SCRIPT = `(function(){try{var b=(window.lh&&window.lh.bootTheme)||null;if(!b){try{b=JSON.parse(localStorage.getItem("lh.appearance.boot")||"null")}catch(e){}}b=b||{};var m=b.mode||"light";if(m==="system")m=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var d=document.documentElement;d.classList.toggle("dark",m==="dark");d.setAttribute("data-typeface",b.typeface==="classic"?"classic":"claude")}catch(e){}})()`;

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html
			lang="en"
			data-typeface="claude"
			className={`${ui.variable} ${prose.variable} ${claudeSans.variable} ${claudeSerif.variable}`}
			// The boot script below edits class/data-typeface before hydration.
			suppressHydrationWarning
		>
			<head>
				<script dangerouslySetInnerHTML={{ __html: BOOT_THEME_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* The opt-in daily review reminder (spaced repetition): renders nothing. */}
			<ReviewReminder />
		</body>
		</html>
	);
}
