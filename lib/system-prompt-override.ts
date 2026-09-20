import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Live system-prompt override, read by the inline extension below.
 *
 * Pi 0.86 renders the prompt from `SystemMessage.sections` and only lets an extension replace it
 * wholesale (`BuildSystemPromptOptions.forceSystemPrompt`), so `agent.state.systemPrompt` is
 * read-only and a handler is the only supported route. The holder lives on the session wrapper so
 * it outlives reloads, which re-create the extension but not its value.
 *
 * `null` keeps Pi's own prompt, `""` is a chat-only session, anything else is an exact snapshot.
 */
export type SystemPromptOverride = { forced: string | null };

export const SYSTEM_PROMPT_OVERRIDE_EXTENSION = "pi-web-system-prompt-override";

export function createSystemPromptOverride(): SystemPromptOverride {
  return { forced: null };
}

export function createSystemPromptOverrideExtension(override: SystemPromptOverride): InlineExtension {
  return {
    name: SYSTEM_PROMPT_OVERRIDE_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => (
        override.forced === null ? undefined : { systemPrompt: override.forced }
      ));
    },
  };
}
