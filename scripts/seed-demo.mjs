/**
 * Seeds the local Socrates data directory (LH_DATA_DIR or ./data) with
 * realistic demo sessions, a Library source note, and a flashcard deck so you
 * can explore Textbook view, Takeaways, Watch-out traps, Source split pane,
 * Progress, Study Flow, and /mobile immediately.
 *
 * Safe to re-run (overwrites only the demo-* / demo note files).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_ROOT = process.env.LH_DATA_DIR
	? path.resolve(process.env.LH_DATA_DIR)
	: path.resolve(process.cwd(), "data");

const CHATS_DIR = path.join(DATA_ROOT, "chats");
const NOTES_DIR = path.join(DATA_ROOT, "notes");
const CARDS_DIR = path.join(DATA_ROOT, "flashcards");
const CACHE_FILE = path.join(DATA_ROOT, "cache", "chat-summaries.json");

fs.mkdirSync(CHATS_DIR, { recursive: true });
fs.mkdirSync(NOTES_DIR, { recursive: true });
fs.mkdirSync(CARDS_DIR, { recursive: true });

const now = Date.now();
const DAY = 86_400_000;

// 1. Seed a Library Source Note (so the "Source" split pane + highlight-to-quote works immediately)
const noteName = "STAT 110 — Conditional Probability & Bayes Rule.md";
const noteId = `src_${crypto.createHash("sha256").update(noteName).digest("hex").slice(0, 12)}`;
const noteText = `# Conditional Probability & Bayes' Rule

## 1. Conditioning as Sample Space Restriction
Given an event B with P(B) > 0, the conditional probability of A given B is:
  P(A | B) = P(A ∩ B) / P(B)

Intuitively, conditioning on B throws away all outcomes outside B and rescales the remaining probabilities so they sum to 1.

## 2. Asymmetry: P(A | B) vs P(B | A)
Confusing P(A | B) with P(B | A) is the prosecutor's fallacy (or inverse fallacy).
Both share the same numerator P(A ∩ B), but P(A | B) divides by P(B) while P(B | A) divides by P(A).

## 3. Bayes' Theorem & Base Rates
  P(H | E) = P(E | H) · P(H) / P(E)
where by the Law of Total Probability:
  P(E) = P(E | H) P(H) + P(E | ¬H) P(¬H).

Medical testing example:
- Prevalence P(Disease) = 1 / 1000 = 0.001
- Sensitivity P(+ | Disease) = 0.99
- False-positive rate P(+ | Healthy) = 0.01
Out of 1,000 people: ~1 sick person tests positive, while ~10 of the 999 healthy people falsely test positive.
Therefore P(Disease | +) ≈ 1 / (1 + 10) ≈ 9.0%.

## 4. Sequential Updating
When new independent evidence E2 arrives, yesterday's posterior P(H | E1) becomes today's prior.
Two independent positive tests on the 1-in-1,000 disease raise the posterior from ~9% to ~91%.
`;

const noteDir = path.join(NOTES_DIR, noteId);
fs.mkdirSync(noteDir, { recursive: true });
const noteBytes = Buffer.from(noteText, "utf-8");
fs.writeFileSync(path.join(noteDir, noteName), noteBytes);
fs.writeFileSync(path.join(noteDir, "text.txt"), noteText, "utf-8");
fs.writeFileSync(
	path.join(noteDir, "meta.json"),
	JSON.stringify(
		{
			id: noteId,
			name: noteName,
			kind: "text",
			importedAt: new Date(now - 2 * DAY).toISOString(),
			bytes: noteBytes.byteLength,
		},
		null,
		"\t",
	),
	"utf-8",
);

// 2. Seed a Flashcard Deck linked to the source note (for Today, Progress → Cards, Study Flow, and /mobile)
const deck = {
	noteId,
	noteName,
	generatedAt: now - 2 * DAY,
	cards: [
		{
			id: "card_demo00000001",
			front: "Why can P(A | B) and P(B | A) differ dramatically even though they share the same numerator?",
			back: "They share P(A ∩ B) in the numerator, but P(A | B) divides by P(B) while P(B | A) divides by P(A). When one event is much rarer than the other, the denominators differ by orders of magnitude.",
			quote: "Both share the same numerator P(A ∩ B), but P(A | B) divides by P(B) while P(B | A) divides by P(A).",
			createdAt: now - 2 * DAY,
			reviews: [{ at: now - 2 * DAY, grade: 2 }],
		},
		{
			id: "card_demo00000002",
			front: "A 1-in-1,000 disease has a 99% accurate test (99% sensitivity, 1% false-positive rate). Roughly what is P(Disease | +)?",
			back: "About 9% (~1/11). Out of 1,000 people, ~1 sick person tests positive while ~10 healthy people produce false positives.",
			quote: "Out of 1,000 people: ~1 sick person tests positive, while ~10 of the 999 healthy people falsely test positive.",
			createdAt: now - 2 * DAY,
			reviews: [{ at: now - 3 * DAY, grade: 1 }],
		},
		{
			id: "card_demo00000003",
			front: "In sequential Bayesian updating, what becomes the prior when a second independent piece of evidence arrives?",
			back: "The posterior from the first update, P(H | E1), becomes the new prior for updating with E2.",
			quote: "When new independent evidence E2 arrives, yesterday's posterior P(H | E1) becomes today's prior.",
			createdAt: now - 2 * DAY,
			reviews: [],
		},
	],
};
fs.writeFileSync(path.join(CARDS_DIR, `${noteId}.json`), JSON.stringify(deck, null, "\t"), "utf-8");

// 3. Seed Demo Learn Session #1: Bayes' Theorem (showcases Live Interactive Textbook, Takeaways, Watch-out traps, Dialogue archive)
const bayesTree = {
	version: 1,
	nodes: [
		{ id: "sample-space", title: "Shrinking the Sample Space", summary: "Conditioning restricts the universe to B and re-normalizes." },
		{ id: "asymmetry", title: "Why P(A | B) ≠ P(B | A)", summary: "Reversing the condition changes the denominator." },
		{ id: "bayes-rule", title: "Bayes’ Rule & The Base Rate", summary: "Combining prior prevalence with test accuracy." },
		{ id: "sequential", title: "Sequential Updating", summary: "Yesterday’s posterior becomes today’s prior." },
	],
	edges: [
		{ from: "sample-space", to: "asymmetry" },
		{ from: "asymmetry", to: "bayes-rule" },
		{ from: "bayes-rule", to: "sequential" },
	],
};

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const bayesChat = {
	id: "demo-bayes",
	title: "Bayes’ Theorem & Updating Beliefs",
	createdAt: new Date(now - 600_000).toISOString(),
	updatedAt: new Date(now - 60_000).toISOString(),
	kind: "teach",
	version: 1,
	tree: bayesTree,
	sectionNotes: {
		asymmetry:
			"**Rule of thumb:** Convert percentages into out-of-1,000 natural counts first — remember that $$\\frac{P(A \\mid B)}{P(B \\mid A)} = \\frac{P(A)}{P(B)}$$ so rare priors shrink the posterior dramatically.",
	},
	messages: [
		{
			role: "user",
			id: "u0",
			content: [{ type: "text", text: "Teach me Bayes’ theorem so I actually stop falling for base-rate traps." }],
			timestamp: now - 500_000,
		},
		{
			role: "assistant",
			id: "a0",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now - 480_000,
			content: [
				{
					type: "text",
					text: "Great goal. I’ve mapped a 4-section progression starting from conditioning as sample-space shrinking and building up to sequential updating.",
				},
				{ type: "toolCall", id: "call-plan", name: "plan_init", arguments: { tree: bayesTree } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-plan",
			toolName: "plan_init",
			isError: false,
			timestamp: now - 479_000,
			content: [{ type: "text", text: "Plan initialized." }],
			details: { ok: true, tree: bayesTree },
		},
		{
			role: "assistant",
			id: "a1",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now - 400_000,
			content: [
				{
					type: "text",
					text: "Conditioning on an event $B$ discards every outcome where $B$ did not happen and rescales the surviving probabilities so they sum to $1$ again:\n\n$$P(A \\mid B) = \\frac{P(A \\cap B)}{P(B)}, \\quad P(B) > 0$$\n\nThink of it as literally cutting out circle $B$ from the Venn diagram and making it your new universe.",
				},
				{
					type: "toolCall",
					id: "call-q1",
					name: "quiz",
					arguments: { nodeId: "sample-space", type: "check", question: "A fair die lands even. What is P(roll = 2 | even)?" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-q1",
			toolName: "quiz",
			isError: false,
			timestamp: now - 390_000,
			content: [{ type: "text", text: "Answered" }],
			details: {
				kind: "quiz",
				tool: "quiz",
				questionType: "check",
				questionText: "A fair die lands even. What is P(roll = 2 | even)?",
				dontKnow: false,
				answers: [{ index: 2, label: "1/3", value: "1/3" }],
				correctIndices: [2],
				correct: true,
				confidence: 4,
				explanation: "Only {2, 4, 6} survive, so 2 is 1 out of 3.",
			},
		},
		{
			role: "user",
			id: "u1",
			content: [{ type: "text", text: "Only {2, 4, 6} survive, so 2 is 1 out of 3." }],
			timestamp: now - 380_000,
		},
		{
			role: "assistant",
			id: "a2",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now - 300_000,
			content: [
				{
					type: "text",
					text: "Reversing a conditional probability keeps the intersection $P(A \\cap B)$ identical, but swaps the reference pool from $B$ to $A$. When $A$ is rare and $B$ is common, $P(A \\mid B)$ and $P(B \\mid A)$ can differ by orders of magnitude.",
				},
				{
					type: "toolCall",
					id: "call-q2",
					name: "quiz",
					arguments: { nodeId: "asymmetry", type: "predict", question: "If 99% of sick people test positive, is P(Sick | +) also ~99%?" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-q2",
			toolName: "quiz",
			isError: false,
			timestamp: now - 290_000,
			content: [{ type: "text", text: "Answered" }],
			details: {
				kind: "quiz",
				tool: "quiz",
				questionType: "predict",
				questionText: "If 99% of sick people test positive, is P(Sick | +) also ~99%?",
				dontKnow: false,
				answers: [{ index: 1, label: "Yes, ~99%", value: "yes" }],
				correctIndices: [2],
				correct: false,
				confidence: 5,
				explanation: "P(Sick | +) divides by ALL positive tests — including false positives from the healthy majority.",
			},
		},
		{
			role: "user",
			id: "u2",
			content: [{ type: "text", text: "Oh! I flipped the denominator — healthy false positives widen the positive pool." }],
			timestamp: now - 280_000,
		},
		{
			role: "assistant",
			id: "a3",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: now - 100_000,
			content: [
				{
					type: "text",
					text: "Now let’s combine both pieces into **Bayes’ Rule**:\n\n$$P(\\text{Disease} \\mid +) = \\frac{P(+ \\mid \\text{Disease}) \\cdot P(\\text{Disease})}{P(+)}$$\n\nSuppose a rare condition affects **1 in 1,000** people, and a test has **99%** sensitivity and **99%** specificity. Out of 1,000 people tested, roughly how many **false positives** do the 999 healthy people generate — and what does that make $P(\\text{Disease} \\mid +)$?",
				},
				{
					type: "toolCall",
					id: "call-e3",
					name: "quiz",
					arguments: {
						nodeId: "bayes-rule",
						type: "check",
						question: "Out of 1,000 people, ~1 is sick and ~10 healthy people falsely test positive. What is P(Disease | +)?",
						options: ["~99%", "~50%", "~9%"],
					},
				},
			],
		},
	],
};

// 4. Seed Demo Learn Session #2: Linear Algebra (so sidebar, Today & Progress feel alive)
const linAlgTree = {
	version: 1,
	nodes: [
		{ id: "eigenvectors", title: "Geometric Meaning of Eigenvectors", summary: "Directions that stay on their own span under A." },
		{ id: "char-poly", title: "The Characteristic Polynomial", summary: "Solving det(A - λI) = 0." },
	],
	edges: [{ from: "eigenvectors", to: "char-poly" }],
};

const linAlgChat = {
	id: "demo-linear-algebra",
	title: "Eigenvalues & Diagonalization",
	createdAt: new Date(now - 3 * DAY).toISOString(),
	updatedAt: new Date(now - 2 * DAY).toISOString(),
	kind: "teach",
	version: 1,
	tree: linAlgTree,
	sectionNotes: {
		eigenvectors: "An eigenvector doesn't rotate under $A$ — it only stretches or flips by $\\lambda$.",
	},
	messages: [
		{
			role: "user",
			id: "lu0",
			content: [{ type: "text", text: "Help me build geometric intuition for eigenvectors." }],
			timestamp: now - 3 * DAY,
		},
		{
			role: "assistant",
			id: "la1",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now - 3 * DAY + 10_000,
			content: [
				{
					type: "text",
					text: "Most vectors change direction when multiplied by a matrix $A$. An **eigenvector** $v \\neq 0$ is special because $A$ only scales it along its own line:\n\n$$A v = \\lambda v$$",
				},
				{
					type: "toolCall",
					id: "call-lq1",
					name: "quiz",
					arguments: { nodeId: "eigenvectors", type: "check", question: "If Av = -2v, what happens geometrically to v?" },
				},
			],
		},
		{
			role: "toolResult",
			toolCallId: "call-lq1",
			toolName: "quiz",
			isError: false,
			timestamp: now - 3 * DAY + 20_000,
			content: [{ type: "text", text: "Answered" }],
			details: {
				kind: "quiz",
				tool: "quiz",
				questionType: "check",
				questionText: "If Av = -2v, what happens geometrically to v?",
				dontKnow: false,
				answers: [{ index: 1, label: "Flips direction and doubles in length", value: "flip-double" }],
				correctIndices: [1],
				correct: true,
				confidence: 5,
				explanation: "Negative λ reverses direction; |λ| = 2 doubles its length.",
			},
		},
		{
			role: "assistant",
			id: "la2",
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-2.5-pro",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: now - 2 * DAY,
			content: [
				{
					type: "text",
					text: "To find all eigenvalues without guessing, rewrite $Av = \\lambda v$ as $(A - \\lambda I)v = 0$. Since $v \\neq 0$, the matrix $A - \\lambda I$ must be singular:\n\n$$\\det(A - \\lambda I) = 0$$",
				},
				{
					type: "toolCall",
					id: "call-lq2",
					name: "explain",
					arguments: { nodeId: "char-poly", type: "check", question: "Why must det(A - λI) = 0 for a non-zero eigenvector v to exist?" },
				},
			],
		},
	],
};

fs.writeFileSync(path.join(CHATS_DIR, "demo-bayes.json"), JSON.stringify(bayesChat, null, "\t"), "utf-8");
fs.writeFileSync(path.join(CHATS_DIR, "demo-linear-algebra.json"), JSON.stringify(linAlgChat, null, "\t"), "utf-8");

// Invalidate chat summary cache so the sidebar picks up the seeded chats immediately.
fs.rmSync(CACHE_FILE, { force: true });

console.log(`Seeded demo data into ${DATA_ROOT}:`);
console.log("  - 2 Learn sessions: /chat/demo-bayes, /chat/demo-linear-algebra");
console.log(`  - 1 Library source note: ${noteName} (${noteId})`);
console.log("  - 1 Flashcard deck (3 cards) for Today, Progress, Study Flow & /mobile");
