"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

import { transformMathDelimiters } from "@/src/core";
import { streamdownPlugins } from "./message";
import { mdComponents } from "@/components/md-blocks";
import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const AUTO_CLOSE_DELAY = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    children,
    ...props
  }: ReasoningProps) => {
    // COLLAPSED BY DEFAULT, ALWAYS (owner, streaming round 2026-10-01):
    // the old default opened on streaming and an auto-open effect
    // re-fought a manual collapse — the block "wasn't collapsible until
    // it finished". Collapsed is the default; opening is always the
    // learner's click; the auto-close after the stream still tidies a
    // row the learner had opened.
    const resolvedDefaultOpen = defaultOpen ?? false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);

    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen]
    );

    const contextValue = useMemo(
      () => ({ isOpen, isStreaming, setIsOpen }),
      [isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean) => ReactNode;
};

/* The settled label (owner round, 2026-10-05): static "Agent's thinking" —
   the duration was live-turn state that died on remount anyway ("thought
   for a few seconds"), bookkeeping for information we knowingly lose. The
   label pairs with the user's collapsed "Your thinking" rows — one
   language; motion (spinner + shimmer) stays the working signal. */
const defaultGetThinkingMessage = (isStreaming: boolean) => {
  if (isStreaming) {
    return <Shimmer duration={1}>Thinking...</Shimmer>;
  }
  return <p>Thinking</p>;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          /* The heading register (owner round 4, 2026-10-05): the small
             mono caps of the card eyebrows — matching YOUR THINKING, whose
             rail offsets it by exactly the one-character difference. */
          "flex w-full items-center gap-2 text-muted-foreground text-xs font-medium transition-colors hover:text-foreground",
          className
        )}
        {...props}
        /* FOCUS HYGIENE (owner, keyboard round 2026-10-10): a pointer click
           on the thinking toggle must not leave focus here — the learner's
           next Enter submits, it must not re-toggle. Radix composes this
           with its own toggle handler. */
        onClick={(e) => blurAfterPointerClick(e)}
      >
        {children ?? (
          <>
            {/* The working-state grammar (owner, streaming round
                2026-10-01): the Braille spinner replaces the brain icon
                WHILE STREAMING ONLY — motion is the signal, so a finished
                row carries no icon at all, just text + chevron. Size:
                the component default (h-3) — IDENTICAL to the placeholder
                spinner (owner, 2026-10-02): the handoff between the two
                states must be visually seamless, one size everywhere. */}
            {isStreaming && <BrailleSpinner label="Thinking" />}
            {getThinkingMessage(isStreaming)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

// Shares message.tsx's Streamdown config (math delimiters, dark mermaid,
// remark-breaks) — reasoning renders the same contract as message text.

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    >
      <Streamdown components={mdComponents} plugins={streamdownPlugins}>
        {transformMathDelimiters(children)}
      </Streamdown>
    </CollapsibleContent>
  )
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";

/**
 * THE THINKING MARK (chat redesign, 2026-11-15): a brain glyph whose
 * strokes carry a slow travelling dash while the tutor thinks, like a
 * signal running through it, plus a soft breathing scale. At rest the
 * same glyph sits still and muted. Ink only, no accent colour.
 */
export function BrainMark({ active, className }: { active: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("lh-brain relative inline-flex size-[18px] shrink-0 items-center justify-center", active && "lh-brain-active", className)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="size-full">
        <path className="lh-brain-base" d="M12 18V5" />
        <path className="lh-brain-base" d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
        <path className="lh-brain-base" d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path className="lh-brain-base" d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path className="lh-brain-base" d="M18 18a4 4 0 0 0 2-7.464" />
        <path className="lh-brain-base" d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path className="lh-brain-base" d="M6 18a4 4 0 0 1-2-7.464" />
        <path className="lh-brain-base" d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
        {active && (
          <g className="lh-brain-signal">
            <path d="M12 18V5" />
            <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
            <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
            <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
            <path d="M18 18a4 4 0 0 0 2-7.464" />
            <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
            <path d="M6 18a4 4 0 0 1-2-7.464" />
            <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
          </g>
        )}
      </svg>
    </span>
  );
}

/** The working line every "the tutor is thinking" moment shares: the
 *  placeholder before the first token, the side thread's wait, and the
 *  live head of a reply's thinking block. */
export function ThinkingIndicator({ label = "Thinking", detail, className }: { label?: string; detail?: string; className?: string }) {
  return (
    <span
      data-testid="thinking-indicator"
      className={cn("flex min-w-0 items-center gap-2.5 font-ui text-[14px] text-muted-foreground", className)}
      role="status"
    >
      <BrainMark active className="text-foreground/75" />
      <Shimmer duration={1.6} className="shrink-0 font-medium">{label}</Shimmer>
      {detail && <span className="min-w-0 truncate text-muted-foreground/80">{detail}</span>}
    </span>
  );
}

/** The newest bold headline in the thoughts (Gemini writes its thought
 *  summaries as "**Heading**" + paragraph): the live status line. */
export function latestThoughtHeadline(texts: readonly string[]): string | undefined {
  for (let i = texts.length - 1; i >= 0; i--) {
    const all = [...(texts[i] ?? "").matchAll(/\*\*([^*\n]{3,80})\*\*/g)];
    const last = all.at(-1)?.[1];
    if (last) return last.trim();
  }
  return undefined;
}

/**
 * ONE THINKING BLOCK PER REPLY (owner, chat-feed redesign 2026-11-01),
 * REDRAWN AS A TRACE (2026-11-15): no box any more. The block is a quiet
 * line led by the brain mark: animated with the newest thought headline
 * while the tutor thinks, still and muted once done. Opening it shows the
 * thoughts along a thin vertical trace, one node per step, the way the
 * Gemini, ChatGPT and Claude apps show their reasoning.
 */
export const ThinkingGroup = memo(
  ({ texts, isStreaming, className }: { texts: string[]; isStreaming: boolean; className?: string }) => {
    const steps = texts.filter((t) => t.trim() !== "");
    const headline = isStreaming ? latestThoughtHeadline(steps) : undefined;
    return (
      <Reasoning
        isStreaming={isStreaming}
        data-testid="thinking-group"
        className={cn("mb-1 w-full", className)}
      >
        <ReasoningTrigger className="group/think w-fit max-w-full gap-2.5 py-1 text-[14px] font-normal">
          <BrainMark active={isStreaming} className={isStreaming ? "text-foreground/75" : "text-muted-foreground"} />
          {isStreaming ? (
            <span className="flex min-w-0 items-center gap-2">
              <Shimmer duration={1.6} className="shrink-0 font-medium">Thinking</Shimmer>
              {headline && <span className="min-w-0 truncate text-muted-foreground/80" data-testid="thinking-headline">{headline}</span>}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 font-medium">
              <span>Thought process</span>
              {steps.length > 1 && (
                <span className="font-normal text-muted-foreground/75" data-testid="thinking-steps">
                  · {steps.length} steps
                </span>
              )}
            </span>
          )}
          <ChevronDownIcon className="size-3.5 shrink-0 -rotate-90 opacity-60 transition-transform group-data-[state=open]/think:rotate-0" />
        </ReasoningTrigger>
        <CollapsibleContent
          className={cn(
            "text-[14px] text-muted-foreground outline-none",
            "data-[state=closed]:fade-out-0 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        >
          <ol className="lh-think-trace mt-1.5 mb-2 [&_p]:my-1.5 [&_strong]:text-foreground/80 ml-[8.5px] border-l border-border pl-[19px]">
            {steps.map((t, i) => (
              <li key={i} className="relative py-1.5 leading-relaxed">
                <span aria-hidden className="absolute top-[0.85rem] -left-[23px] size-[7px] rounded-full border border-border bg-background" />
                <Streamdown components={mdComponents} plugins={streamdownPlugins}>
                  {transformMathDelimiters(t)}
                </Streamdown>
              </li>
            ))}
          </ol>
        </CollapsibleContent>
      </Reasoning>
    );
  }
);
ThinkingGroup.displayName = "ThinkingGroup";
