import { inject, singleton } from "tsyringe";
import { Session, getEffectiveChannelType } from "../../channels/SessionManager";
import { ClassifierRuntimeData } from "./ConversationRunner";
import logger from "../../utils/logger";
import { ConversationContext, ConversationContextBuilder } from "./ConversationContextBuilder";
import { TemplatingEngine } from "./TemplatingEngine";
import { ConversationService } from "../ConversationService";
import { MAX_LIST_LIMIT } from "../../utils/pagination";
import { InvalidOperationError } from "../../errors";
import { KnowledgeService } from "../KnowledgeService";
import { ClassificationEventData, SampleCopySelectionEventData } from "../../types/conversationEvents";
import { classificationResultSchema, classificationOutputJsonSchema, ActionClassificationResult, ActionClassificationResultWithClassifier, SampleCopyClassificationResult, sampleCopyClassificationResultSchema, sampleCopyOutputJsonSchema } from "../../types/classification";
import { extractTextFromContent } from "../../utils/llm";
import type { KnowledgeCategoryResponse } from "../../http/contracts/knowledge";
import { ContextTransformerExecutor } from "./ContextTransformerExecutor";
import { buildLlmUsage, type LlmUsageMetadata } from '../../utils/llmUsage';
import { resolveProviderModelLimits, resolveOutputCap } from '../../utils/costManagement';
import { truncateMessagesToTokenBudget } from '../../utils/contextTruncation';

/** Result of processing user input, including actions and timing metadata */
export type ProcessTextInputResult = {
  actions: ActionClassificationResult[];
  /** Duration of the knowledge category retrieval in milliseconds; undefined when knowledge is not used */
  knowledgeRetrievalDurationMs?: number;
  /** Unix timestamp (ms) when knowledge retrieval started; undefined when knowledge is not used */
  knowledgeRetrievalStartMs?: number;
  /** Unix timestamp (ms) when knowledge retrieval completed; undefined when knowledge is not used */
  knowledgeRetrievalEndMs?: number;
  /** Result of the sample copy classification; undefined when sample copy is not configured for this stage */
  sampleCopyResult?: SampleCopyClassificationResult;
};

/**
 * Service responsible for processing user input during live sessions.
 */
@singleton()
export class UserInputProcessor {
  constructor(
    @inject(TemplatingEngine) private templatingEngine: TemplatingEngine,
    @inject(ConversationContextBuilder) private contextBuilder: ConversationContextBuilder,
    @inject(ConversationService) private conversationService: ConversationService,
    @inject(KnowledgeService) private knowledgeService: KnowledgeService,
    @inject(ContextTransformerExecutor) private transformerExecutor: ContextTransformerExecutor,
  ) { }

  /** Processes text input from the user within a session.
   * @param session - The session in which the input was received.
   * @param text - The text input from the user.
   * @returns A promise that resolves to the processing result with actions and timing metadata.
   */
  async processTextInput(session: Session, userInput: string, originalUserInput: string): Promise<ProcessTextInputResult> {
    // How to process:
    // - Get all classifiers for the current stage.
    // - For each classifier, run the text through it to determine actions with filtered actions based on overrideClassifierId. Do this in parallel.
    // - Collect and return all detected actions from classifiers.

    try {
      // Read ONCE, at the top, and hold it.
      //
      // This used to reach back into session.runner several more times further down, after the
      // classifiers had been awaited - and a caller who hangs up mid-turn tears the session down
      // in that window, so the late reads dereferenced null and the hang-up surfaced as an
      // unhandled TypeError rather than as an ordinary end of call. Nothing here needs a fresher
      // view than the one the turn started with; taking a second one was never deliberate.
      const runtime = session.runner.getRuntimeData();
      const classifiers = runtime.classifiers;
      const stage = runtime.stage;
      const conversation = runtime.conversation;
      // Filtered for enumeration to the classifier; the unfiltered list is kept because the
      // lookup map below has to be able to find a lifecycle action by name.
      const globalActions = runtime.globalActions.filter(ga => !ga.id.startsWith('__'));
      const allGlobalActions = runtime.globalActions;
      const guardrails = runtime.guardrails;
      const guardrailClassifier = runtime.guardrailClassifier;
      const sampleCopies = runtime.sampleCopies;
      const sampleCopyClassifier = runtime.sampleCopyClassifier;

      // Fetch knowledge categories for the default classifier when knowledge is enabled
      let knowledgeCategories: KnowledgeCategoryResponse[] = [];
      let knowledgeRetrievalDurationMs: number | undefined;
      let knowledgeRetrievalStartMs: number | undefined;
      let knowledgeRetrievalEndMs: number | undefined;
      if (stage.useKnowledge && stage.defaultClassifierId) {
        const knowledgeStartMs = Date.now();
        knowledgeCategories = stage.knowledgeTags.length > 0
          ? await this.knowledgeService.getCategoriesByTags(conversation.projectId, stage.knowledgeTags)
          : (await this.knowledgeService.listKnowledgeCategories(conversation.projectId, { offset: 0, limit: MAX_LIST_LIMIT })).items;
        const knowledgeEndMs = Date.now();
        knowledgeRetrievalDurationMs = knowledgeEndMs - knowledgeStartMs;
        knowledgeRetrievalStartMs = knowledgeStartMs;
        knowledgeRetrievalEndMs = knowledgeEndMs;
        logger.debug({ conversationId: conversation.id, categoryCount: knowledgeCategories.length, classifierId: stage.defaultClassifierId, knowledgeRetrievalDurationMs }, 'Fetched knowledge categories for default classifier');
      }

      const actionPromises = classifiers.map(async (classifier) => {
        // Inject knowledge categories only for the default classifier
        const classifierKnowledgeCategories = classifier.classifier.id === stage.defaultClassifierId ? knowledgeCategories : [];
        // Build context specific to this classifier with filtered actions
        const classifierContext = await this.contextBuilder.buildContextForClassifier(
          conversation,
          stage,
          globalActions,
          classifier.classifier.id,
          userInput,
          originalUserInput,
          classifierKnowledgeCategories,
          getEffectiveChannelType(session),
        );
        return this.classifyTextInput(session, classifier, classifierContext);
      });

      // Build guardrail classification promise if a guardrail classifier is configured and there are active guardrails
      const guardrailPromise = guardrailClassifier && guardrails.length > 0
        ? (async () => {
          const guardrailContext = await this.contextBuilder.buildContextForGuardrailClassifier(conversation, stage, guardrails, userInput, originalUserInput, getEffectiveChannelType(session));
          return this.classifyTextInput(session, guardrailClassifier, guardrailContext);
        })()
        : Promise.resolve(null);

      // Build sample copy classification promise if a classifier is configured and there are applicable sample copies for this stage
      const sampleCopyPromise = sampleCopyClassifier && sampleCopies.length > 0
        ? (async () => {
          const sampleCopyContext = await this.contextBuilder.buildContextForSampleCopyClassifier(conversation, stage, sampleCopies, userInput, originalUserInput, getEffectiveChannelType(session));
          return this.classifyCopyForInput(session, sampleCopyContext);
        })()
        : Promise.resolve(null);

      // Run all classifiers, guardrail classifier, sample copy classifier, and context transformers in parallel
      const [classificationResultsWithClassifiers, guardrailResult, sampleCopyResult, transformerTriggeredActions] = await Promise.all([
        Promise.all(actionPromises),
        guardrailPromise,
        sampleCopyPromise,
        this.transformerExecutor.executeTransformers(session, userInput, originalUserInput),
      ]);

      // Register classification events for stage classifiers
      for (const result of classificationResultsWithClassifiers) {
        const classifier = classifiers.find(c => c.classifier.id === result.classifierId);
        const eventData: ClassificationEventData = {
          classifierId: result.classifierId,
          input: userInput || '',
          actions: [result],
          metadata: {
            classifierName: result.classifierName,
            actionCount: result.actions.length,
            // Always present, so "this classifier fired nothing" and "this classifier
            // never answered" are distinguishable in a stored event, not just in a log
            // line that has since rotated away.
            classificationFailed: result.classificationFailed ?? false,
            ...(result.classificationError ? { classificationError: result.classificationError } : {}),
            systemPrompt: result.renderedPrompt,
            llmUsage: result.llmUsage,
            currentVariables: conversation?.stageVars[stage.id] || {},
            stageName: stage.name,
            durationMs: result.durationMs,
            startMs: result.startMs,
            endMs: result.endMs,
          },
        };
        await this.conversationService.saveConversationEvent(conversation.projectId, conversation.id, 'classification', eventData, stage.id);
        await session.clientConnection.sendMessage({ type: 'conversation_event', conversationId: conversation.id, eventType: 'classification', eventData });
      }

      // Register classification event for guardrail classifier
      if (guardrailResult) {
        const eventData: ClassificationEventData = {
          classifierId: guardrailResult.classifierId,
          input: userInput || '',
          actions: [guardrailResult],
          metadata: {
            classifierName: guardrailResult.classifierName,
            actionCount: guardrailResult.actions.length,
            classificationFailed: guardrailResult.classificationFailed ?? false,
            ...(guardrailResult.classificationError ? { classificationError: guardrailResult.classificationError } : {}),
            systemPrompt: guardrailResult.renderedPrompt,
            llmUsage: guardrailResult.llmUsage,
            currentVariables: conversation?.stageVars[stage.id] || {},
            stageName: stage.name,
            durationMs: guardrailResult.durationMs,
            startMs: guardrailResult.startMs,
            endMs: guardrailResult.endMs,
          },
        };
        await this.conversationService.saveConversationEvent(conversation.projectId, conversation.id, 'classification', eventData, stage.id);
        await session.clientConnection.sendMessage({ type: 'conversation_event', conversationId: conversation.id, eventType: 'classification', eventData });
      }

      // Register sample copy selection event
      if (sampleCopyResult && sampleCopyClassifier) {
        const eventData: SampleCopySelectionEventData = {
          classifierId: sampleCopyClassifier.classifier.id,
          input: userInput || '',
          sampleCopy: sampleCopyResult.sampleCopy,
          metadata: {
            classifierName: sampleCopyClassifier.classifier.name,
            systemPrompt: sampleCopyResult.renderedPrompt,
            result: sampleCopyResult.result,
            llmUsage: sampleCopyResult.llmUsage,
            currentVariables: conversation?.stageVars[stage.id] || {},
            stageName: stage.name,
            durationMs: sampleCopyResult.durationMs,
            startMs: sampleCopyResult.startMs,
            endMs: sampleCopyResult.endMs,
          },
        };
        await this.conversationService.saveConversationEvent(conversation.projectId, conversation.id, 'sample_copy_selection', eventData, stage.id);
        await session.clientConnection.sendMessage({ type: 'conversation_event', conversationId: conversation.id, eventType: 'sample_copy_selection', eventData });
      }

      const allActions = [
        ...classificationResultsWithClassifiers.map(x => x.actions).flat(),
        ...(guardrailResult?.actions ?? []),
        ...transformerTriggeredActions,
      ];
      // Indexed by `name` AND by `classificationTrigger`, because a classifier is told to emit
      // the trigger and had no way to be right.
      //
      // `classificationTrigger` is described everywhere as "the classification label that
      // triggers this action", is settable through the API, and was read by nothing at all -
      // every lookup here went through `name`, the human-facing label. So a classifier that did
      // exactly what its prompt asked returned "recording", the map held "Caller is a recording,
      // not a person", and the action was dropped with a warning that reads like the config is
      // wrong. Nothing errored, and the model narrated the action it could not fire as dialogue
      // instead - which is precisely how this went unnoticed on a real call.
      //
      // Name still wins on a collision: it is what already worked.
      const indexBy = <T extends { name: string; classificationTrigger?: string | null }>(defs: T[]): Map<string, T> => {
        const map = new Map<string, T>();
        for (const def of defs) {
          if (def.classificationTrigger) map.set(def.classificationTrigger, def);
        }
        for (const def of defs) map.set(def.name, def);
        return map;
      };

      const globalActionsMap = indexBy(allGlobalActions);
      const guardrailsMap = indexBy(guardrails);
      const knowledgeCategoryIds = new Set(knowledgeCategories.map(c => `__knowledge_${c.id}`));
      const stageActionsMap = indexBy(Object.values(stage.actions));
      const filteredActions = allActions.filter(action => {
        // Allow synthetic knowledge actions to pass through without looking them up in stage or global actions
        if (knowledgeCategoryIds.has(action.name)) {
          return true;
        }

        let actionDef = guardrailsMap.get(action.name)
          ?? globalActionsMap.get(action.name)
          ?? stageActionsMap.get(action.name);

        if (!actionDef) {
          logger.warn({ actions: stage.actions, conversationId: conversation.id, actionName: action.name }, `Received action ${action.name} from classifier which does not exist in global actions, guardrails, or stage actions. Ignoring.`);
          return false;
        }

        // Check if we have all required parameters for the action
        if ('parameters' in actionDef) {
          const missingRequiredParams = (actionDef.parameters || []).filter(p => p.required && action.parameters[p.name] == null).map(p => p.name);
          if (missingRequiredParams.length > 0) {
            logger.warn({ conversationId: conversation.id, actionName: action.name, missingParameters: missingRequiredParams }, `Received incomplete action ${action.name} from classifier. Missing required parameters: ${missingRequiredParams.join(', ')}. Ignoring.`);
            return false;
          }
        }

        return true;
      });

      return { actions: filteredActions, knowledgeRetrievalDurationMs, knowledgeRetrievalStartMs, knowledgeRetrievalEndMs, sampleCopyResult: sampleCopyResult ?? undefined };
    } catch (error) {
      logger.error({ error, sessionId: session.id }, 'Error processing text input using classifiers');
      throw error;
    }
  }

  private async classifyCopyForInput(session: Session, context: ConversationContext): Promise<SampleCopyClassificationResult & { renderedPrompt: string; result: string; llmUsage?: LlmUsageMetadata; durationMs: number; startMs: number; endMs: number }> {
    const classifyStartMs = Date.now();
    try {
      const classifierData = session.runner?.getRuntimeData()?.sampleCopyClassifier;
      if (!classifierData) {
        throw new InvalidOperationError('No sample copy classifier configured for this stage');
      }
      logger.debug({ sessionId: session.id, classifierId: classifierData.classifier.id }, 'Classifying sample copy for text input using sample copy classifier');
      const llmProvider = classifierData.llmProvider;
      const classifier = classifierData.classifier;
      const text = context.userInput || '';
      const renderedPrompt = await this.templatingEngine.render(classifier.prompt, context);

      const messages = [
        {
          role: 'system' as const,
          content: renderedPrompt
        },
        {
          role: 'user' as const,
          content: text
        }
      ];

      const copyModel = classifierData.classifier.llmSettings?.model;
      // Optional, because these run inside awaited promises and a caller who hangs up mid-turn
      // takes the session with them. Without the guard the hang-up is caught by the handler below
      // and recorded as `classificationFailed`, which is the signal for "the classifier could not
      // answer" - a torn-down session is not that, and conflating them makes the fault countable
      // in the database for the wrong reason.
      const copyLimits = resolveProviderModelLimits(session.runner?.getRuntimeData()?.costManagementConfig, classifierData.llmProviderInfo.id, copyModel);
      const copyMaxTokens = resolveOutputCap(classifierData.classifier.llmSettings?.defaultMaxTokens, copyLimits, 'classification');
      const copyInputCap = copyLimits?.inputTokensLimits?.classification;
      const { messages: truncatedCopyMessages, ...copyTruncation } = truncateMessagesToTokenBudget(messages, copyInputCap, copyModel);
      const structured = await llmProvider.generateStructured(truncatedCopyMessages, sampleCopyClassificationResultSchema, {
        ...(copyMaxTokens !== undefined ? { maxTokens: copyMaxTokens } : {}),
        schema: sampleCopyOutputJsonSchema,
        schemaName: 'sample_copy',
      });
      const result = structured.raw;
      const textContent = extractTextFromContent(result.content);

      logger.info({ sessionId: session.id, classifierId: classifier.id, structuredOutputMode: structured.mode, attempts: structured.attempts }, `Received sample copy classification result from LLM provider: ${textContent}`);

      const endMs = Date.now();
      return {
        ...structured.value,
        renderedPrompt,
        result: textContent,
        llmUsage: buildLlmUsage(result.usage, classifierData.llmProviderInfo, classifierData.classifier.llmSettings?.model, copyTruncation),
        durationMs: endMs - classifyStartMs,
        startMs: classifyStartMs,
        endMs,
      };
    } catch (error) {
      logger.error({ error, sessionId: session.id }, 'Error classifying sample copy for text input');
      const endMs = Date.now();
      return {
        sampleCopy: null,
        renderedPrompt: null,
        result: null,
        durationMs: endMs - classifyStartMs,
        startMs: classifyStartMs,
        endMs,
      };
    }
  }

  private async classifyTextInput(session: Session, classifierData: ClassifierRuntimeData, context: ConversationContext): Promise<ActionClassificationResultWithClassifier & { renderedPrompt: string | null; llmUsage?: LlmUsageMetadata; durationMs: number; startMs: number; endMs: number; classificationFailed?: boolean; classificationError?: string }> {
    const classifyStartMs = Date.now();
    try {
      logger.debug({ sessionId: session.id, classifierId: classifierData.classifier.id }, 'Classifying text input using classifier');
      const llmProvider = classifierData.llmProvider;
      const classifier = classifierData.classifier;
      const text = context.userInput || '';
      const renderedPrompt = await this.templatingEngine.render(classifier.prompt, context);

      const messages = [
        {
          role: 'system' as const,
          content: renderedPrompt
        },
        {
          role: 'user' as const,
          content: text
        }
      ];

      const classifyModel = classifierData.classifier.llmSettings?.model;
      const classifyLimits = resolveProviderModelLimits(session.runner?.getRuntimeData()?.costManagementConfig, classifierData.llmProviderInfo.id, classifyModel);
      const classifyMaxTokens = resolveOutputCap(classifierData.classifier.llmSettings?.defaultMaxTokens, classifyLimits, 'classification');
      const classifyInputCap = classifyLimits?.inputTokensLimits?.classification;
      const { messages: truncatedClassifyMessages, ...classifyTruncation } = truncateMessagesToTokenBudget(messages, classifyInputCap, classifyModel);
      // The classifier is asked for a shape, not for prose that happens to look like one.
      // Where the provider can enforce it, the API does; where it cannot, generateStructured
      // retries once and then throws rather than handing back something ambiguous.
      const structured = await llmProvider.generateStructured(truncatedClassifyMessages, classificationResultSchema, {
        ...(classifyMaxTokens !== undefined ? { maxTokens: classifyMaxTokens } : {}),
        schema: classificationOutputJsonSchema,
        schemaName: 'classification',
      });
      const result = structured.raw;
      const textContent = extractTextFromContent(result.content);

      logger.info({ sessionId: session.id, classifierId: classifier.id, structuredOutputMode: structured.mode, attempts: structured.attempts }, `Received classification result from LLM provider: ${textContent}`);

      // Convert actions object to array format
      const actions: ActionClassificationResult[] = Object.entries(structured.value.actions).map(([name, parameters]) => ({
        name,
        parameters,
      }));

      const endMs = Date.now();
      return {
        classifierId: classifier.id,
        classifierName: classifier.name,
        actions,
        renderedPrompt,
        llmUsage: buildLlmUsage(result.usage, classifierData.llmProviderInfo, classifierData.classifier.llmSettings?.model, classifyTruncation),
        durationMs: endMs - classifyStartMs,
        startMs: classifyStartMs,
        endMs,
      };
    } catch (error) {
      // A classifier that could not answer is NOT a classifier that chose no action.
      // Those were the same value here once, and on a phone line the classifier is the
      // only thing that can fire an action - so an hour of unreadable responses looked
      // exactly like an hour of the model deciding to sit still, and nobody's phone rang.
      //
      // The turn still proceeds with no action, because dropping a live caller over a
      // formatting failure would be worse. What changes is that the failure is now
      // stated: `classificationFailed` rides out on the classification event, so it is
      // countable in the database and a scenario run containing one is a run that failed
      // rather than a run to puzzle over.
      const classificationError = error instanceof Error ? error.message : String(error);
      logger.error({ error, sessionId: session.id, classifierId: classifierData.classifier.id, classificationFailed: true }, 'Classifier produced no usable result - recording a fault, NOT an empty action set');
      const endMs = Date.now();
      return {
        classifierId: classifierData.classifier.id,
        classifierName: classifierData.classifier.name,
        actions: [],
        renderedPrompt: null,
        classificationFailed: true,
        classificationError,
        durationMs: endMs - classifyStartMs,
        startMs: classifyStartMs,
        endMs,
      };
    }
  }
}
