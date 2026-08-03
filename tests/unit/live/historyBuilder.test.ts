import 'reflect-metadata';
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { HistoryBuilder } from '../../../src/services/live/HistoryBuilder';
import type { ConversationContext, ScriptEvent } from '../../../src/services/live/ConversationContextBuilder';
import type { IsolatedScriptExecutor, ScriptExecutionResult } from '../../../src/services/live/IsolatedScriptExecutor';
import type { MessageEventData, MessageVisibility } from '../../../src/types/conversationEvents';

function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    conversationId: 'conv_test',
    projectId: 'proj_test',
    userId: 'user_test',
    vars: {},
    stageVars: {},
    userProfile: {},
    consts: {},
    history: [],
    events: [],
    actions: {},
    results: { tools: {} },
    stage: { id: 'stage_main', name: 'Main Stage', actions: {} },
    ...overrides,
  };
}

function makeEvent(
  type: string,
  data: any,
  timestamp: string = '2024-01-01T00:00:00.000Z',
  id: string = `evt_${type}_${Math.random()}`
): ScriptEvent {
  return { id, eventType: type, timestamp, eventData: data };
}

function makeMessageEvent(
  role: 'user' | 'assistant',
  text: string,
  visibility?: MessageVisibility,
  timestamp?: string
): ScriptEvent {
  const data: MessageEventData = { role, text, visibility };
  return makeEvent('message', data, timestamp);
}

describe('HistoryBuilder', () => {
  let builder: HistoryBuilder;
  let scriptExecutor: IsolatedScriptExecutor;

  beforeEach(() => {
    scriptExecutor = {
      executeScript: async (_code: string, _context: ConversationContext): Promise<ScriptExecutionResult> => ({
        value: true,
        flowControl: {},
        hasModifiedVars: false,
        hasModifiedUserInput: false,
        hasModifiedUserProfile: false,
      }),
    } as any;
    builder = new HistoryBuilder(scriptExecutor);
  });

  describe('basic history building', () => {
    it('returns empty array for no events', async () => {
      const context = makeContext();
      const history = await builder.buildHistory([], context);
      expect(history).to.deep.equal([]);
    });

    it('includes messages without visibility (default always)', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello'),
        makeMessageEvent('assistant', 'Hi there!'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(2);
      expect(history[0]).to.deep.equal({ role: 'user', content: 'Hello' });
      expect(history[1]).to.deep.equal({ role: 'assistant', content: 'Hi there!' });
    });

    it('excludes empty messages', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello'),
        makeMessageEvent('assistant', '   '),
        makeMessageEvent('user', 'World'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(2);
    });
  });

  describe('visibility: always', () => {
    it('includes messages with visibility always', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'always' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
    });
  });

  describe('visibility: never', () => {
    it('excludes messages with visibility never', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello'),
        makeMessageEvent('assistant', 'Secret', { visibility: 'never' }),
        makeMessageEvent('user', 'World'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(2);
      expect(history).to.not.include.satisfy((m) => m.content === 'Secret');
    });
  });

  describe('visibility: stage', () => {
    it('includes message when stage matches', async () => {
      const context = makeContext({ stage: { id: 'stage_main', name: 'Main', actions: {} } });
      const events = [
        makeEvent('conversation_start', { stageId: 'stage_main' }, '2024-01-01T00:00:00.000Z'),
        makeMessageEvent('user', 'Hello', { visibility: 'stage' }, '2024-01-01T00:00:01.000Z'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
      expect(history[0].content).to.equal('Hello');
    });

    it('excludes message when stage does not match', async () => {
      const context = makeContext({ stage: { id: 'stage_other', name: 'Other', actions: {} } });
      const events = [
        makeEvent('conversation_start', { stageId: 'stage_main' }, '2024-01-01T00:00:00.000Z'),
        makeMessageEvent('user', 'Hello', { visibility: 'stage' }, '2024-01-01T00:00:01.000Z'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(0);
    });

    it('updates stage on jump_to_stage event', async () => {
      const context = makeContext({ stage: { id: 'stage_two', name: 'Two', actions: {} } });
      const events = [
        makeEvent('conversation_start', { stageId: 'stage_one' }, '2024-01-01T00:00:00.000Z'),
        makeMessageEvent('user', 'Old stage', { visibility: 'stage' }, '2024-01-01T00:00:01.000Z'),
        makeEvent('jump_to_stage', { toStageId: 'stage_two' }, '2024-01-01T00:00:02.000Z'),
        makeMessageEvent('user', 'New stage', { visibility: 'stage' }, '2024-01-01T00:00:03.000Z'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
      expect(history[0].content).to.equal('New stage');
    });

    it('excludes message with stage visibility when no stage set yet', async () => {
      const context = makeContext({ stage: { id: 'stage_main', name: 'Main', actions: {} } });
      // No conversation_start event, so currentStageId is undefined
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'stage' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(0);
    });

    it('handles jump_to_stage with missing toStageId', async () => {
      const context = makeContext({ stage: { id: 'stage_main', name: 'Main', actions: {} } });
      const events = [
        makeEvent('conversation_start', { stageId: 'stage_main' }, '2024-01-01T00:00:00.000Z'),
        makeEvent('jump_to_stage', { toStageId: undefined }, '2024-01-01T00:00:01.000Z'),
        makeMessageEvent('user', 'Hello', { visibility: 'stage' }, '2024-01-01T00:00:02.000Z'),
      ];
      const history = await builder.buildHistory(events, context);

      // Stage stays as stage_main, so message is included
      expect(history).to.have.length(1);
    });
  });

  describe('visibility: conditional', () => {
    it('includes message when condition is truthy', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'conditional', condition: 'true' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
    });

    it('excludes message when condition is falsy', async () => {
      scriptExecutor = {
        executeScript: async (_code: string, _context: ConversationContext): Promise<ScriptExecutionResult> => ({
          value: false,
          flowControl: {},
          hasModifiedVars: false,
          hasModifiedUserInput: false,
          hasModifiedUserProfile: false,
        }),
      } as any;
      builder = new HistoryBuilder(scriptExecutor);

      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'conditional', condition: 'false' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(0);
    });

    it('defaults to visible when condition is missing', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'conditional', condition: undefined }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
    });

    it('defaults to visible when condition throws error', async () => {
      scriptExecutor = {
        executeScript: async (): Promise<ScriptExecutionResult> => {
          throw new Error('Script error');
        },
      } as any;
      builder = new HistoryBuilder(scriptExecutor);

      const context = makeContext();
      const events = [
        makeMessageEvent('user', 'Hello', { visibility: 'conditional', condition: 'throw new Error()' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
    });
  });

  describe('event ordering', () => {
    it('sorts events by timestamp before processing', async () => {
      const context = makeContext();
      const events = [
        makeMessageEvent('assistant', 'Second', undefined, '2024-01-01T00:00:02.000Z'),
        makeMessageEvent('user', 'First', undefined, '2024-01-01T00:00:01.000Z'),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history[0].content).to.equal('First');
      expect(history[1].content).to.equal('Second');
    });
  });

  describe('non-message events', () => {
    it('ignores non-message events in history', async () => {
      const context = makeContext();
      const events = [
        makeEvent('conversation_start', { stageId: 'stage_main' }),
        makeEvent('classification', { classifierId: 'clf_1' }),
        makeMessageEvent('user', 'Hello'),
        makeEvent('tool_call', { toolId: 'tool_1' }),
      ];
      const history = await builder.buildHistory(events, context);

      expect(history).to.have.length(1);
      expect(history[0].content).to.equal('Hello');
    });
  });
});
