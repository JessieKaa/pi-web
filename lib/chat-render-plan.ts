import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  CustomMessage,
  ThinkingContent,
} from "./types";
import {
  countToolCallBlocks,
  getAssistantErrorMessage,
  getDisplayableAssistantBlocks,
  splitFinalAssistantBlocks,
  splitThinkingBlocks,
} from "./message-display";

/** A pure description of the historical transcript; it deliberately has no React dependency. */
export type ChatRenderPlan = {
  items: ChatRenderPlanItem[];
  lastUserMessageIndex: number;
};

export type ChatRenderPlanItem = MessagePlanItem | ProcessPlanItem | ThinkingPlanItem;

export type MessagePlanItem = {
  kind: "message";
  sourceIndex: number;
  keyPrefix?: string;
  attachRef?: boolean;
  refIndex?: number;
  showTimestamp?: boolean;
  /** A display-only subset of an assistant entry's content. */
  assistantBlocks?: AssistantContentBlock[];
  omitUsage?: boolean;
  /** The complete turn content used by the renderer to derive written files. */
  turnContent?: AssistantContentBlock[];
};

export type ProcessPlanItem = {
  kind: "process";
  key: string;
  refIndex?: number;
  messageCount: number;
  toolCallCount: number;
  hasError: boolean;
  children: Array<MessagePlanItem | ThinkingPlanItem>;
};

export type ThinkingPlanItem = {
  kind: "thinking";
  key: string;
  refIndex?: number;
  segments: ThinkingSegmentPlan[];
};

export type ThinkingSegmentPlan = {
  block: ThinkingContent;
  blockIndex: number;
  entryId?: string;
  sessionId?: string;
  messageIndex: number;
  duration?: number;
};

export type BuildChatRenderPlanOptions = {
  messages: AgentMessage[];
  entryIds: string[];
  isStreaming: boolean;
  sessionId?: string;
};

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx]!)) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function isGroupAnchor(message: AgentMessage): boolean {
  return message.role === "user"
    || (message.role === "custom" && (message as CustomMessage).customType === "compaction");
}

function isConversationSegmentAnchor(messages: AgentMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  return isGroupAnchor(message)
    || (message.role === "custom" && index > 0 && hasFinalAssistantAnswer(messages[index - 1]!));
}

function shouldShowTimestamp(messages: AgentMessage[], index: number, isStreaming: boolean): boolean {
  if (messages[index]?.role !== "assistant") return false;
  for (let next = index + 1; next < messages.length; next++) {
    const role = messages[next]!.role;
    if (role === "user") break;
    if (role === "assistant") return false;
  }
  return !(isStreaming && index === messages.length - 1);
}

/**
 * Builds the historical grouping plan. Tool results intentionally do not enter
 * this function: their only transcript-level use is resolving written files
 * when the final-answer descriptor is rendered.
 */
export function buildChatRenderPlan({
  messages,
  entryIds,
  isStreaming,
  sessionId,
}: BuildChatRenderPlanOptions): ChatRenderPlan {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }

  // This is the ordinal consumed by ChatMinimap, not an item index in this
  // plan. Process and thinking wrappers retain the original source ordinal.
  const visibleRefIndexByMessage = new Map<number, number>();
  let refIndex = 0;
  messages.forEach((message, index) => {
    if (message.role === "user" || message.role === "assistant") {
      visibleRefIndexByMessage.set(index, refIndex++);
    }
  });

  const message = (
    sourceIndex: number,
    options: Omit<MessagePlanItem, "kind" | "sourceIndex" | "refIndex"> = {},
  ): MessagePlanItem => ({
    kind: "message",
    sourceIndex,
    refIndex: options.attachRef === false ? undefined : visibleRefIndexByMessage.get(sourceIndex),
    ...options,
    showTimestamp: options.showTimestamp ?? shouldShowTimestamp(messages, sourceIndex, isStreaming),
  });

  const rendered: ChatRenderPlanItem[] = [];
  for (let index = 0; index < messages.length;) {
    if (!isConversationSegmentAnchor(messages, index)) {
      rendered.push(message(index));
      index += 1;
      continue;
    }

    const anchorIndex = index;
    let endIndex = anchorIndex + 1;
    while (endIndex < messages.length && !isConversationSegmentAnchor(messages, endIndex)) endIndex += 1;

    const finalAssistantIndex = findFinalAssistantIndex(messages, anchorIndex, endIndex);
    if (finalAssistantIndex === -1) {
      for (let renderIndex = anchorIndex; renderIndex < endIndex; renderIndex++) rendered.push(message(renderIndex));
      index = endIndex;
      continue;
    }

    rendered.push(message(anchorIndex));
    const finalAssistant = messages[finalAssistantIndex] as AssistantMessage;
    const finalSplit = splitFinalAssistantBlocks(finalAssistant);
    const hasFinalAnswer = finalSplit.answerBlocks.length > 0 || Boolean(getAssistantErrorMessage(finalAssistant));

    let hasToolProcess = false;
    for (let processIndex = anchorIndex + 1; processIndex <= finalAssistantIndex; processIndex++) {
      const processMessage = messages[processIndex];
      if (processMessage?.role !== "assistant") continue;
      const blocks = processIndex === finalAssistantIndex
        ? finalSplit.processBlocks
        : getDisplayableAssistantBlocks(processMessage);
      if (countToolCallBlocks(blocks) > 0) {
        hasToolProcess = true;
        break;
      }
    }

    let processChildren: Array<MessagePlanItem | ThinkingPlanItem> = [];
    let processMessageCount = 0;
    let processToolCallCount = 0;
    let processRefIndex: number | undefined;
    let processKey = "";
    let processHasError = false;
    let thinkingSegments: ThinkingSegmentPlan[] = [];
    let thinkingRefIndex: number | undefined;
    let thinkingKey = "";

    const flushProcess = () => {
      if (processChildren.length === 0) return;
      rendered.push({
        kind: "process",
        key: processKey,
        refIndex: processRefIndex,
        messageCount: processMessageCount,
        toolCallCount: processToolCallCount,
        hasError: processHasError,
        children: processChildren,
      });
      processChildren = [];
      processMessageCount = 0;
      processToolCallCount = 0;
      processRefIndex = undefined;
      processHasError = false;
    };
    const flushThinking = () => {
      if (thinkingSegments.length === 0) return;
      const thinking: ThinkingPlanItem = {
        kind: "thinking",
        key: thinkingKey,
        refIndex: thinkingRefIndex,
        segments: thinkingSegments,
      };
      if (hasToolProcess) {
        if (processChildren.length === 0) processKey = `thinking-${thinkingKey}`;
        processRefIndex ??= thinkingRefIndex;
        processChildren.push(thinking);
      } else {
        rendered.push(thinking);
      }
      thinkingSegments = [];
      thinkingRefIndex = undefined;
      thinkingKey = "";
    };

    for (let processIndex = anchorIndex + 1; processIndex <= finalAssistantIndex; processIndex++) {
      const processMessage = messages[processIndex]!;
      const messageKey = entryIds[processIndex] ?? processIndex;
      if (processMessage.role === "custom") {
        flushThinking();
        if (processChildren.length === 0) processKey = String(messageKey);
        processMessageCount += 1;
        processChildren.push(message(processIndex, { attachRef: false, keyPrefix: "process" }));
        continue;
      }
      if (processMessage.role !== "assistant") {
        flushThinking();
        continue;
      }

      const blocks = processIndex === finalAssistantIndex
        ? finalSplit.processBlocks
        : getDisplayableAssistantBlocks(processMessage);
      const groups = splitThinkingBlocks(blocks);
      const lastProcessGroup = groups.findLast((group) => !group.thinking);
      processHasError ||= Boolean(getAssistantErrorMessage(processMessage));
      for (const group of groups) {
        const blockIndex = processMessage.content.indexOf(group.blocks[0]!);
        const key = `${messageKey}-${blockIndex}`;
        if (group.thinking) {
          if (!hasToolProcess) flushProcess();
          const previousTimestamp = (messages[processIndex - 1] as AgentMessage & { timestamp?: number })?.timestamp;
          const messageTimestamp = (processMessage as AssistantMessage & { timestamp?: number }).timestamp;
          const duration = messageTimestamp && previousTimestamp
            ? Math.round((messageTimestamp - previousTimestamp) / 1000)
            : 0;
          thinkingRefIndex ??= visibleRefIndexByMessage.get(processIndex);
          if (thinkingSegments.length === 0) thinkingKey = key;
          for (const block of group.blocks) {
            if (block.type !== "thinking") continue;
            thinkingSegments.push({
              block,
              blockIndex: processMessage.content.indexOf(block),
              entryId: entryIds[processIndex],
              sessionId,
              messageIndex: processIndex,
              duration: duration > 0 ? duration : undefined,
            });
          }
          continue;
        }

        flushThinking();
        if (processChildren.length === 0) processKey = key;
        processRefIndex ??= visibleRefIndexByMessage.get(processIndex);
        processMessageCount += 1;
        processToolCallCount += countToolCallBlocks(group.blocks);
        processChildren.push(message(processIndex, {
          attachRef: false,
          keyPrefix: `process-${blockIndex}`,
          assistantBlocks: group.blocks,
          omitUsage: processIndex === finalAssistantIndex || group !== lastProcessGroup,
          showTimestamp: false,
        }));
      }
    }
    flushThinking();
    flushProcess();

    if (hasFinalAnswer) {
      const turnContent: AssistantContentBlock[] = [];
      for (let turnIndex = anchorIndex + 1; turnIndex <= finalAssistantIndex; turnIndex++) {
        const turnMessage = messages[turnIndex];
        if (turnMessage?.role === "assistant") turnContent.push(...turnMessage.content);
      }
      rendered.push(message(finalAssistantIndex, {
        assistantBlocks: finalSplit.answerBlocks,
        turnContent,
      }));
    }
    for (let renderIndex = finalAssistantIndex + 1; renderIndex < endIndex; renderIndex++) rendered.push(message(renderIndex));
    index = endIndex;
  }

  return { items: rendered, lastUserMessageIndex };
}

// Filtered blocks are stable message data, but the arrays produced by split
// helpers are not. Cache the display message by source entry and block ordinal
// so a transcript rerender never defeats MessageView.memo with a fresh object.
const assistantOverrideCache = new WeakMap<AssistantMessage, Map<string, AssistantMessage>>();

export function getAssistantMessageOverride(
  message: AssistantMessage,
  blocks: AssistantContentBlock[] | undefined,
  omitUsage: boolean | undefined,
): AssistantMessage {
  if (!blocks && !omitUsage) return message;
  if (blocks === message.content && !omitUsage) return message;
  let searchFrom = 0;
  const blockKey = blocks ? blocks.map((block) => {
    const index = message.content.indexOf(block, searchFrom);
    searchFrom = index + 1;
    return index;
  }).join(",") : "all";
  const key = `${omitUsage ? "without-usage" : "with-usage"}:${blockKey}`;
  let overrides = assistantOverrideCache.get(message);
  if (!overrides) {
    overrides = new Map();
    assistantOverrideCache.set(message, overrides);
  }
  const cached = overrides.get(key);
  if (cached) return cached;
  const override: AssistantMessage = { ...message, content: blocks ?? message.content };
  if (omitUsage) override.usage = undefined;
  overrides.set(key, override);
  return override;
}
