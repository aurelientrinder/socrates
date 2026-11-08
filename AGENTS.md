<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# No guessing

All design authority belongs to the human. **Never guess a design or implementation decision.** If anything is ambiguous — naming, behavior, data shapes, UX, defaults, scope boundaries, prompt wording — STOP and ask with the ask-user-question tool before proceeding. If you are "a little unsure," you are unsure: ask. A wrong guess is far more expensive than a question. Ask early, ask specific, one question per call.

Concretely: first investigate and plan rigorously (asking the user design questions along the way), get the plan approved by the user, and only then implement. Implementation should be mechanical execution of an approved plan — not interpretation.

# Available Custom Subagents

This project defines custom subagents in `.agents/agents/` that should be used for specific tasks to keep the primary agent's context clean:

- **`locator`** (`.agents/agents/locator/agent.md`): Read-only codebase indexing utility. Delegate broad symbol searches, grep sweeps, interface lookups, and call site discovery to `locator` before reading full files in the main conversation.
- **`test-runner`** (`.agents/agents/test-runner/agent.md`): Build and test runner. Delegate test runs (`npm test`), typechecks (`npm run typecheck`), linting (`npm run lint`), or build tasks to `test-runner` to execute and filter down output to only failing assertions, compiler errors, and stack traces.

