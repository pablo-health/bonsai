import { inject, singleton } from "tsyringe";
import { Stage } from "../../types/models";
import { ConversationContext } from "./ConversationContextBuilder";
import { TemplatingEngine } from "./TemplatingEngine";
import { ILlmProvider, LlmMessage } from "../providers/llm/ILlmProvider";
import { truncateMessagesToTokenBudget, type TruncationInfo } from "../../utils/contextTruncation";

@singleton()
export class ResponseGenerator {

  constructor(@inject(TemplatingEngine) private templatingEngine: TemplatingEngine) { }

  /**
   * Generates streamed AI response for the given conversation context and stage.
   *
   * @param context - Execution context containing conversation and stage information
   * @param stage - The current stage of the conversation
   * @param renderedPrompt - The rendered system prompt
   * @param completionLlmProvider - The LLM provider to use for generating the response
   * @param assistantPrefix - Optional filler sentence already spoken; passed as an assistant prefill so the LLM continues naturally from it
   * @param maxTokens - Optional maximum output tokens (project cap applied as hard ceiling over entity defaultMaxTokens)
   * @param inputTokenCap - Optional maximum input context tokens; oldest non-system history messages are trimmed when exceeded
   * @param model - Model name used for token estimation during input truncation
   * @param onTruncation - Called synchronously with truncation metadata before streaming begins; use to capture info before the generation-completed callback fires
   */
  async generateResponse(context: ConversationContext, stage: Stage, renderedPrompt: string, completionLlmProvider: ILlmProvider, assistantPrefix?: string, maxTokens?: number, inputTokenCap?: number, model?: string, onTruncation?: (info: TruncationInfo) => void): Promise<void> {
    const history = context.history.map(msg => { return { role: msg.role, content: msg.content } as LlmMessage; });
    // The current user message is saved to the DB before context is built, so it ends up in
    // context.history. Remove it here to avoid sending it twice — it is appended explicitly below.
    if (context.userInput && history.at(-1)?.role === 'user') {
      history.pop();
    }
    let messages: LlmMessage[] = [
      { role: 'system', content: renderedPrompt },
      ...history,
      { role: 'user', content: context.userInput ?? '---' },
    ];
    if (assistantPrefix) {
      // Trailing sentence-enders are removed, because this is a prefill the model CONTINUES and
      // a finished sentence is a finished turn. Given "Sure." the model can legitimately decide
      // it has already spoken and add nothing at all - measured on claude-haiku-4.5 at roughly
      // one turn in three, and worse than that in practice because an empty assistant turn goes
      // into the history and reads as precedent for the next one. A real call degraded into
      // "ok", "sure", "okay" with no answer behind any of them.
      //
      // Without the full stop the same request continues normally every time. The guidance for
      // filler prompts is already "one sentence only, with no extra commentary or punctuation";
      // this stops a filler that ignores it from costing the caller the reply.
      const prefill = assistantPrefix.replace(/[.!?。！？]+\s*$/u, '');
      if (prefill.trim()) {
        messages.push({ role: 'assistant', content: prefill });
      }
    }
    const { messages: truncatedMessages, ...truncationInfo } = truncateMessagesToTokenBudget(messages, inputTokenCap, model);
    onTruncation?.(truncationInfo);
    await completionLlmProvider.generateStream(truncatedMessages, maxTokens !== undefined ? { maxTokens } : {});
  }
}