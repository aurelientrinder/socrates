# Socrates — Next-Horizon Roadmap

Living tracker for evolving Socrates into a ubiquitous, SOTA learning harness where memory, pedagogy, capture, and UX work in tandem.

Status legend: `[ ]` Todo · `[~]` In Progress · `[x]` Done

---

## Pillar 1: SOTA Learning Harness (Memory & Cognitive Engine)

- [x] **Unify the three memory silos** (`plan:*`, `prop:*`, and `flashcards`) into one coherent memory model so quizzes, practice, reviews, flashcards, and mock exams all inform retention, weak spots, study plans, and cheat sheets.
- [x] **Graph-propagated FSRS (FIRe — Fractional Implicit Repetition)**
  - Upward credit: passing a composition/exam/check on a conclusion grants fractional stability credit to its underlying `GraphChain` premises.
  - Downward blast-radius & root-cause repair: lapsing or overconfident misses flag dependent conclusions as shaky and route remediation to the weakest prerequisite.
- [x] **Upgrade FSRS-4.5 → FSRS-5/6 + Personal Weight Fitting**
  - Add same-day short-term stability modeling (`w17`, `w18`, `w19`) and trainable decay (`w20`).
  - Fit personalized FSRS weights to the learner's own recall history once enough reviews accumulate (~100–200).
- [x] **Diagnostic-Hotspot Context Injection**
  - Automatically inject a topic's structural prerequisite neighborhood, active overconfident misses (`weakSpotReport`), and recurring `missClass` patterns into every new session.

---

## Pillar 2: Ubiquity (Learn Anywhere & Zero-Friction Capture)

- [x] **Local-First Sync + Mobile Companion / PWA**
  - Encrypted sync (AES-256-GCM folder sync for iCloud/Dropbox/Google Drive/Syncthing) over local JSON/JSONL data with lossless per-domain merge.
  - Fast mobile companion (`/mobile` PWA) optimized for 2–5 minute offline-capable flashcard bursts and Today's due summary.
- [ ] **1-Click Capture from Everywhere**
  - Browser extension / global OS hotkey / share sheet to send arXiv papers, YouTube transcripts, highlights, or screenshots straight to the Reading Queue → background extraction → graph & flashcards.
- [x] **Side-by-Side Source Learning**
  - Open PDFs, papers, or lecture slides alongside a Socratic session (`Source` split pane + `?note=` deep-link) with PDF/Text toggle, search, and highlight-to-quote into the composer.

---

## Pillar 3: "Everything in Tandem" UX (One Cohesive Flow)

- [x] **Adaptive "Study Flow" Session (Auto-Piloted Block)**
  - One "Start 25-min Flow" entry point on Today (`15m / 25m / 45m`) that seamlessly chains retrieval warm-up → frontier `Learn` → `Practice` discrimination/composition with a persistent top stepper and completion recap.
- [x] **Document-First Lesson UX (Kill the Chat Look)**
  - Sectioned, collapsible live textbook chapters keyed to plan nodes (`SectionHeader`, `deriveLessonSections`).
  - Persistent anti-amnesia state strip (`LessonStateStrip`: current section, prerequisites established, Collapse covered / Expand all) + clickable `PlanRail` TOC.
  - Deep-link from any Knowledge Graph node (`#message-<id>`) auto-expands collapsed sections and scrolls to the exact passage.
- [ ] **Real-Time Voice Socratic Mode (Feynman Loop)**
  - Low-latency voice-to-voice Socratic dialogue where the learner explains concepts out loud and the tutor interrupts/probes weak links in real time.

---

## Pillar 4: Next-Level Learning Mechanics

- [ ] **Cross-Topic Interleaved Discrimination**
  - Interleaved drill generator that mixes confusable concepts across different sessions/courses to train recognition and transfer.
- [ ] **Living Misconception / "Mental Model Bugs" Ledger**
  - Synthesize recurring failure patterns from `Your thinking` notes, confident misses, and `missClass` tags; feed them automatically into future practice, mock exams, and cheat-sheet warnings.
- [ ] **Inline STEM / Code Scratchpad**
  - Pair `PracticeDock` with live LaTeX preview, runnable JS/Python sandbox (Pyodide), and line-level derivation checking.

---

## Pillar 5: Reliability, Speed & Pedagogical Evals

- [ ] **Pedagogical Eval Suite**
  - Automated evals over real transcripts verifying teaching quality (edge-of-understanding pacing, no answer leaks before `predict`, faithful free-recall grading, probe adaptation).
- [ ] **Provider Flexibility & Offline Fallback**
  - Pluggable LLM providers (Anthropic, OpenAI, local Ollama for offline reviews) alongside Gemini so each role can use the best model.

---

## Active Work Log

### Unifying the Three Memory Silos
- **Status:** Done (2026-11-19).
- **What shipped:** Deterministic `plan:* → prop:*` provenance resolution (`planNodeMessageIds` + `resolvePlanToPropositions` cached in `ChatDigest` v2), optional generation-time `Flashcard.nodeId` linking in `flashcard-maker.ts`, unified `flashcardRecallEvents` fold preserving sitting-first-answer semantics, `card:*` fallback + `/progress?tab=cards` routing, course exam readiness integration, and conversational `Review` queue filtering.
- **Key files involved:** `src/core/retention.ts`, `src/core/flashcards.ts`, `src/core/exam.ts`, `src/core/briefing.ts`, `src/agent/subagents/flashcard-maker.ts`, `src/server/chat-digests.ts`, `src/server/chats.ts`, `src/server/flashcards.ts`, `src/server/review.ts`, `components/review-view.tsx`, `tests/unified-memory.test.ts`.

### Graph-Propagated FSRS (FIRe)
- **Status:** Done (2026-11-19).
- **What shipped:** Conservative upward FIRe implicit stability credit (`0.5` at 1 hop, `0.25` at 2 hops, `GRADE_GOOD` only, cycle-safe, never fabricates untested premises or alters `lastReviewedAt`), downward blast-radius `shakyPremises` surfaced on Memory view and Cheat Sheet standing, prerequisite-first review/plan ordering (`orderPrerequisitesFirst`), and root-cause drill auto-pull (`withPrerequisiteRepairs`).
- **Key files involved:** `src/core/retention.ts`, `src/core/cheatsheet.ts`, `src/core/weak-spots.ts`, `src/server/chats.ts`, `src/server/review.ts`, `components/review-view.tsx`, `tests/fire-propagation.test.ts`.

### Upgrade FSRS-4.5 → FSRS-6 + Personal Weight Fitting
- **Status:** Done (2026-11-19).
- **What shipped:** Upgraded to 21-parameter FSRS-6 (same-day short-term stability `w17–w19`, trainable forgetting-curve decay `w20`, exponential `D0`, linearly damped difficulty update), zero-dependency L2-regularized Adam personal weight fitter (`src/core/fsrs-fit.ts`, unlocks at 100 follow-up reviews), `data/fsrs-weights.json` persistence, `/api/fsrs` (`GET`/`POST`/`DELETE`), and `FsrsFitCard` in `Progress → Memory`.
- **Key files involved:** `src/core/retention.ts`, `src/core/flashcards.ts`, `src/core/weak-spots.ts`, `src/core/fsrs-fit.ts`, `src/store/fsrs-weights.ts`, `src/server/chats.ts`, `src/server/flashcards.ts`, `app/api/fsrs/route.ts`, `components/fsrs-fit-card.tsx`, `components/review-view.tsx`, `app/progress/page.tsx`, `tests/fsrs6-fit.test.ts`.

### Diagnostic-Hotspot Context Injection
- **Status:** Done (2026-11-19).
- **What shipped:** Pure diagnostic brief builder (`src/core/diagnostics.ts`) extracting 1–2 hop prerequisite neighborhoods, topic-prioritized overconfident weak spots, and recurring practice `missClass` patterns (cached in `ChatDigest` v3), injected at session start as a collapsible `diagnostic-context` marker rendered by `DiagnosticContextCard`.
- **Key files involved:** `src/core/diagnostics.ts`, `src/core/native-messages.ts`, `src/core/view.ts`, `src/server/chat-digests.ts`, `src/server/chats.ts`, `app/api/chats/route.ts`, `components/diagnostic-context-card.tsx`, `components/chat.tsx`, `tests/diagnostics.test.ts`.

### Local-First Encrypted Folder Sync + Mobile Companion PWA
- **Status:** Done (2026-11-20).
- **What shipped:** Pure deterministic per-domain sync merge (`src/core/sync-merge.ts`: JSONL ledger union, flashcard deck/review union, newest-wins sessions/exams/FSRS weights), AES-256-GCM + scrypt encrypted folder sync (`src/server/sync.ts`, `src/store/sync.ts`, `/api/sync`, Settings → Data & updates UI), `fsrs-weights.json` backup inclusion, PWA manifest + service worker + icon (`app/manifest.ts`, `public/sw.js`, `public/icon.svg`), and offline-capable `/mobile` burst companion (`components/mobile-companion.tsx`).
- **Key files involved:** `src/core/sync-merge.ts`, `src/store/sync.ts`, `src/server/sync.ts`, `src/server/backup.ts`, `app/api/sync/route.ts`, `components/settings/sync-section.tsx`, `components/settings/settings-dialog.tsx`, `app/manifest.ts`, `public/sw.js`, `public/icon.svg`, `components/pwa-register.tsx`, `app/layout.tsx`, `app/mobile/page.tsx`, `components/mobile-companion.tsx`, `tests/sync-merge.test.ts`.

### Side-by-Side Source Learning
- **Status:** Done (2026-11-20).
- **What shipped:** Docked `SourcePane` split reader inside sessions (`Source` toggle in `TopBar` + `?note=<noteId>` deep-link) with note picker, inline PDF viewer (`/api/notes/:id/file`) + searchable extracted-text toggle, and highlight-to-quote (`Quote` / `Ask why`) injecting cited blockquotes directly into the composer.
- **Key files involved:** `src/core/source-quote.ts`, `components/source-pane.tsx`, `components/chat.tsx`, `tests/source-quote.test.ts`.

### Adaptive "Study Flow" Session
- **Status:** Done (2026-11-20).
- **What shipped:** Pure 3-stage flow planner (`src/core/study-flow.ts`), `POST /api/flow` endpoint creating Stage 1+2 with warm-up + diagnostic hotspots + course note deep-link, persistent `StudyFlowStrip` below `TopBar` with 1-click Learn → Practice handoff and Flow Complete recap, and `StudyFlowLauncher` (`15m / 25m / 45m`) on Today.
- **Key files involved:** `src/core/study-flow.ts`, `app/api/flow/route.ts`, `components/study-flow-strip.tsx`, `components/chat.tsx`, `components/today-view.tsx`, `tests/study-flow.test.ts`.

### Document-First Lesson UX
- **Status:** Done (2026-11-20).
- **What shipped:** Pure chapter sectioning engine (`src/core/lesson-sections.ts`: `deriveLessonSections`, `sectionForMessage`), persistent anti-amnesia `LessonStateStrip` (active section, prerequisite chips, Collapse covered / Expand all), collapsible textbook `SectionHeader`s, clickable `PlanRail` TOC scrolling, and automatic section expansion on Knowledge Map `#message-<id>` deep-links.
- **Key files involved:** `src/core/lesson-sections.ts`, `components/lesson-document.tsx`, `components/session-rail.tsx`, `components/chat.tsx`, `tests/lesson-sections.test.ts`.
