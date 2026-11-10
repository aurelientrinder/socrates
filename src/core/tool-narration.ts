/**
 * TOOL-CALL NARRATION STRIP (2026-11-10). Some models (seen on Gemini) write the
 * tool call into the visible reply right before the real call, e.g.
 * "…de l'oscillateur ? Let's call `quiz` (`type: "predict"`)." The learner
 * must never read that. Display-only: raw records stay as recorded.
 *
 * Conservative on purpose: a sentence is removed only when it is a call verb
 * followed by a backticked tool name. Tool names that are also everyday words
 * (find, read, notes, problem…) additionally need an argument list, so a
 * programming lesson saying "call `find` on the array" is left alone.
 * A half-streamed narration at the very end of the text is hidden too.
 */

const DISTINCT = "quiz|probe_done|plan_init|conclude|list_sessions|list_propositions|web_search|web_fetch|web_fetch_pdf|pdf_info|pdf_extract|pdf_search|mermaid_plan";
const GENERIC = "find|grep|ls|read|notes|problem|research|demo|visual|pdf";
const VERB =
	"(?:let(?:'|’)s|let me|let us|i(?:'|’)ll|i will|i(?:'|’)m going to|now|next|time to)?\\s*(?:call(?:ing)?|invoke|invoking|trigger|triggering|launch|launching|appel(?:ons|le|er)|lan(?:ç|c)ons|je lance|j(?:'|’)appelle|utilisons)";
const ARGS = "\\s*\\((?:[^()`]|`[^`]*`)*\\)";
const TAIL = "[ \\t]*[.!:]?";

const WITH_ARGS = new RegExp(`(?:^|(?<=[\\s.!?:;]))${VERB}\\s+(?:the\\s+)?\`(?:${DISTINCT}|${GENERIC})\`(?:\\s+tool)?${ARGS}${TAIL}`, "gi");
const DISTINCT_BARE = new RegExp(`(?:^|(?<=[\\s.!?:;]))${VERB}\\s+(?:the\\s+)?\`(?:${DISTINCT})\`(?:\\s+tool)?${TAIL}`, "gi");
// Still streaming: "Let's call `qui" / "Let's call `quiz` (`type: "pre" at the very end.
// Any prefix of a distinctive tool name counts (q, qu, qui, quiz).
const PREFIXES = DISTINCT.split("|").flatMap((n) => Array.from({ length: n.length }, (_, k) => n.slice(0, k + 1)));
const PARTIAL = new RegExp(
	`(?:^|(?<=[\\s.!?:;]))${VERB}\\s+(?:the\\s+)?` + "`" + `(?:${PREFIXES.join("|")})(?:` + "`" + `(?:\\s+tool)?(?:\\s*\\([^)]*)?)?$`,
	"i"
);

export function stripToolNarration(text: string): string {
	if (!text.includes("`")) return text;
	const out = text.replace(PARTIAL, "").replace(WITH_ARGS, "").replace(DISTINCT_BARE, "");
	return out === text ? text : out.replace(/\s+$/, "");
}
