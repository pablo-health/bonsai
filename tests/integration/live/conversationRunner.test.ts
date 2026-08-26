import 'reflect-metadata';
import { expect } from 'chai';
import { container } from 'tsyringe';
import { ConversationTestHarness } from './conversationTestHarness';
import { LlmProviderFactory } from '../../../src/services/providers/llm/LlmProviderFactory';
import { MockLlmProvider } from './mockLlmProvider';
import { EventCollectorClientConnection } from './eventCollectorClientConnection';
import { authed, resetDatabase } from '../../utils';
import { MINIMAL_PROJECT, MINIMAL_AGENT } from '../../fixtures';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

describe('ConversationRunner', () => {
  let harness: ConversationTestHarness;

  beforeEach(async () => {
    harness = new ConversationTestHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  describe('conversation lifecycle', () => {
    it('starts conversation and emits conversation_start event', async () => {
      await harness.setup({
        name: 'Welcome',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Welcome! How can I help you?');

      await harness.start();

      harness.assertEvent('conversation_start');
      expect(harness.events.aiResponses).to.include('Welcome! How can I help you?');
    });

    it('executes on_enter actions with variable modifications', async () => {
      await harness.setup({
        name: 'Welcome',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              {
                type: 'modify_variables',
                modifications: [
                  { variableName: 'greeted', operation: 'set', value: true },
                ],
              },
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Hello!');

      await harness.start();

      harness.assertEvent('conversation_start');
      expect(harness.events.aiResponses).to.include('Hello!');

      // Verify variable was persisted
      const greeted = await harness.getVariable('greeted');
      expect(greeted).to.equal(true);
    });

    it('emits message event with AI response', async () => {
      await harness.setup({
        name: 'Chat',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Hello there!');

      await harness.start();

      harness.assertEvent('conversation_start');
      harness.assertEvent('message');
      expect(harness.events.aiResponses).to.include('Hello there!');
    });

    it('transitions to awaiting_user_input after response', async () => {
      await harness.setup({
        name: 'Chat',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Ready!');

      await harness.start();

      await harness.assertConversationStatus('awaiting_user_input');
    });
  });

  describe('user input flow', () => {
    it('handles user text input and generates response', async () => {
      await harness.setup({
        name: 'Chat',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
          default: {
            name: 'Default',
            triggerOnUserInput: true,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Welcome!');
      await harness.start();

      harness.mockLlm.queueResponse('That\'s interesting!');
      const response = await harness.sendInput('Hello there');

      expect(response).to.equal('That\'s interesting!');
    });

    it('executes triggerOnUserInput action without classifier', async () => {
      await harness.setup({
        name: 'Chat',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
          default: {
            name: 'Default',
            triggerOnUserInput: true,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Welcome!');
      await harness.start();

      harness.mockLlm.queueResponse('Got it!');

      await harness.sendInput('test message');

      // Without a classifier, triggerOnUserInput actions execute directly
      // No classification event emitted, but execution_plan should be present
      harness.assertEvent('execution_plan');
      expect(harness.events.aiResponses).to.include('Got it!');
    });
  });

  describe('stage transitions', () => {
    it('transitions to another stage via go_to_stage effect', async () => {
      // Set up Stage A first to get project/agent/provider
      await harness.setup({
        name: 'Stage A',
        prompt: 'You are stage A.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter A',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      // Create Stage B (same DB session as Stage A)
      const stageBId = await harness.addStage({
        name: 'Stage B',
        prompt: 'You are stage B.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter B',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      // Now update Stage A to include goToB action referencing Stage B
      const stageA = await authed().get(`/api/projects/${harness.projectId}/stages/${harness.stageId}`);
      const putRes = await authed()
        .put(`/api/projects/${harness.projectId}/stages/${harness.stageId}`)
        .send({
          name: stageA.body.name,
          prompt: stageA.body.prompt,
          version: stageA.body.version,
          actions: {
            ...stageA.body.actions,
            goToB: {
              name: 'Go to B',
              triggerOnUserInput: true,
              triggerOnClientCommand: false,
              parameters: [],
              effects: [
                { type: 'go_to_stage', stageId: stageBId },
              ],
            },
          },
        });

      harness.mockLlm.queueResponse('Hello from A!');
      await harness.start();

      harness.assertEvent('conversation_start');
      expect(harness.events.aiResponses).to.include('Hello from A!');

      // Queue response for Stage B on_enter
      harness.mockLlm.queueResponse('Hello from B!');

      // Trigger transition via runAction
      await harness.runner!.runAction('goToB', {});

      harness.assertEvent('jump_to_stage');
      expect(harness.events.aiResponses).to.include('Hello from B!');
    });
  });

  describe('variable operations', () => {
    it('modifies variables via modify_variables effect', async () => {
      await harness.setup({
        name: 'Vars',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              {
                type: 'modify_variables',
                modifications: [
                  { variableName: 'counter', operation: 'set', value: 0 },
                  { variableName: 'name', operation: 'set', value: 'Alice' },
                ],
              },
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Variables set!');

      await harness.start();

      expect(await harness.getVariable('counter')).to.equal(0);
      expect(await harness.getVariable('name')).to.equal('Alice');
    });

    it('resets variables via modify_variables effect', async () => {
      await harness.setup({
        name: 'Vars',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              {
                type: 'modify_variables',
                modifications: [
                  { variableName: 'counter', operation: 'set', value: 42 },
                  { variableName: 'counter', operation: 'reset', value: null },
                ],
              },
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Reset done!');

      await harness.start();

      expect(await harness.getVariable('counter')).to.be.undefined;
    });

    it('adds to array variables via modify_variables effect', async () => {
      await harness.setup({
        name: 'Vars',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              {
                type: 'modify_variables',
                modifications: [
                  { variableName: 'tags', operation: 'set', value: [] },
                  { variableName: 'tags', operation: 'add', value: 'hello' },
                  { variableName: 'tags', operation: 'add', value: 'world' },
                ],
              },
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Tags added!');

      await harness.start();

      const tags = await harness.getVariable('tags');
      expect(tags).to.deep.equal(['hello', 'world']);
    });
  });

  describe('prescripted responses', () => {
    it('uses prescripted response without LLM call', async () => {
      await harness.setup({
        name: 'Prescripted',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              {
                type: 'generate_response',
                responseMode: 'prescripted',
                prescriptedResponses: ['Hello from prescripted!', 'Alternative!'],
                prescriptedSelectionStrategy: 'random',
              },
            ],
          },
        },
      });

      await harness.start();

      // No LLM calls should be made for prescripted responses
      expect(harness.mockLlm.calls.length).to.equal(0);
      // Response should be one of the prescripted options
      expect(harness.events.aiResponses.length).to.be.greaterThan(0);
      expect(harness.events.aiResponses[0]).to.be.oneOf(['Hello from prescripted!', 'Alternative!']);
    });
  });

  describe('mock LLM assertions', () => {
    it('captures LLM calls for prompt verification', async () => {
      await harness.setup({
        name: 'Prompt Check',
        prompt: 'You are a pirate.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Ahoy!');

      await harness.start();

      // Verify the system prompt was sent to the LLM
      expect(harness.mockLlm.calls.length).to.be.greaterThan(0);
      const lastCall = harness.mockLlm.calls[harness.mockLlm.calls.length - 1];
      const systemMsg = lastCall.find(m => m.role === 'system');
      expect(systemMsg).to.not.be.undefined;
      expect(systemMsg!.content).to.contain('pirate');
    });
  });

  describe('error handling', () => {
    it('handles missing stage gracefully', async () => {
      await harness.setup({
        name: 'Empty',
        prompt: 'You are empty.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {},
      });

      await harness.start();

      harness.assertEvent('conversation_start');
    });

    it('handles provider failure gracefully', async () => {
      // Set up with a mock that throws on generate
      harness.mockLlm = new MockLlmProvider();
      harness.mockLlm.queueResult({
        id: 'mock_fail',
        content: [],
        role: 'assistant',
        finishReason: 'error',
      });
      harness.events = new EventCollectorClientConnection();

      await harness.setup({
        name: 'Failing',
        prompt: 'You are failing.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      await harness.start();

      // Conversation should start regardless of provider behavior
      harness.assertEvent('conversation_start');
    });
  });

  describe('abort conversation', () => {
    it('ends conversation via abort_conversation effect', async () => {
      await harness.setup({
        name: 'Abort',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
          abortNow: {
            name: 'Abort Now',
            triggerOnUserInput: true,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'abort_conversation' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Welcome!');
      await harness.start();

      harness.assertEvent('conversation_start');

      // Trigger abort via regular action (abort_conversation restricted in __on_enter)
      await harness.runner!.runAction('abortNow', {});
      // Execute the deferred terminal action
      await harness.runner!.executePendingTerminalAction();

      harness.assertEvent('conversation_aborted');
    });
  });

  describe('multi-turn conversations', () => {
    it('handles multiple user inputs with default action', async () => {
      await harness.setup({
        name: 'MultiTurn',
        prompt: 'You are a helpful assistant.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
        actions: {
          __on_enter: {
            name: 'On Enter',
            triggerOnUserInput: false,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
          default: {
            name: 'Default',
            triggerOnUserInput: true,
            triggerOnClientCommand: false,
            parameters: [],
            effects: [
              { type: 'generate_response', responseMode: 'generated' },
            ],
          },
        },
      });

      harness.mockLlm.queueResponse('Welcome!');
      await harness.start();

      expect(harness.events.aiResponses).to.include('Welcome!');

      harness.mockLlm.queueResponse('Got your message!');
      const response = await harness.sendInput('hello');

      expect(response).to.equal('Got your message!');
      expect(harness.events.aiResponses).to.have.length(2);
    });
  });

  /**
   * The acknowledgement spoken while a tool call runs, driven through the real runner rather
   * than the executor alone - so what is asserted is what the caller's client actually received.
   *
   * A slow HTTP endpoint stands in for the availability lookup. It is the same shape as the one
   * the practice line will call, and the same shape as the mock the booking work is built
   * against: a real request, deliberately slow to answer.
   */
  describe('speaking while a tool call runs', () => {
    let server: Server;
    let baseUrl: string;
    /** How long the stand-in endpoint sits on a request before answering. */
    let delayMs: number;

    beforeEach(async () => {
      delayMs = 0;
      server = createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ slots: ['14:00', '15:30'] }));
        }, delayMs);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}/availability`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    /** Creates the lookup tool, a classifier that always picks it, and the stage that calls it. */
    async function setupBookingStage(acknowledgement: any): Promise<void> {
      await harness.setup({
        name: 'Booking',
        prompt: 'You are a receptionist.',
        llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
      });

      const toolRes = await authed()
        .post(`/api/projects/${harness.projectId}/tools`)
        .send({ type: 'webhook', name: 'Check availability', url: baseUrl });
      expect(toolRes.status).to.equal(201);

      const classifierRes = await authed()
        .post(`/api/projects/${harness.projectId}/classifiers`)
        .send({
          name: 'Booking classifier',
          prompt: 'Classify the caller intent.',
          llmProviderId: harness._providerId,
          llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0 },
        });
      expect(classifierRes.status).to.equal(201);

      const stageRes = await authed()
        .put(`/api/projects/${harness.projectId}/stages/${harness.stageId}`)
        .send({
          name: 'Booking',
          prompt: 'You are a receptionist.',
          llmProviderId: harness._providerId,
          llmSettings: { provider: 'openai', model: 'gpt-4', temperature: 0.7 },
          agentId: harness.agentId,
          defaultClassifierId: classifierRes.body.id,
          version: 1,
          actions: {
            check_availability: {
              name: 'check_availability',
              triggerOnUserInput: true,
              triggerOnClientCommand: false,
              parameters: [],
              effects: [
                { type: 'call_tool', toolId: toolRes.body.id, parameters: { day: 'Thursday' }, acknowledgement },
                { type: 'generate_response', responseMode: 'generated' },
              ],
            },
          },
        });
      expect(stageRes.status).to.equal(200);

      await harness.rePrepare();
      // The greeting takes a queue slot whether or not anything is queued for it - the mock
      // advances its index either way - so it gets one explicitly, and everything queued after
      // this line lines up with the turn that asks for it.
      harness.mockLlm.queueResponse('Pablo Bear\'s practice, how can I help?');
      await harness.start();
      // From here on the collector holds one turn's worth of messages, so an assertion about
      // what the caller heard first is about the booking turn rather than the greeting.
      harness.events.reset();
    }

    /** The classification the (mock) classifier returns, consumed before the reply. */
    function queueClassification(): void {
      harness.mockLlm.queueResponse(JSON.stringify({ actions: { check_availability: {} } }));
    }

    it('tells the caller which day it is checking, and the reply continues from it', async () => {
      delayMs = 150;
      await setupBookingStage({ text: 'let me check {{parameters.day}} for you' });

      queueClassification();
      harness.mockLlm.queueResponse('- yes, two o\'clock is free.');
      await harness.sendInput('can I come in on Thursday?');

      const spoken = harness.events.aiChunks.map((c) => c.chunkText).filter((t) => t.length > 0);
      expect(spoken[0]).to.equal('let me check Thursday for you');

      // The transcript records what was said out loud, in one piece. Without the acknowledgement
      // folded in, the stored assistant message would begin mid-sentence.
      const messages = harness.events.getEventsByType('message');
      const assistant = messages.filter((m: any) => m.eventData.role === 'assistant');
      expect(assistant[assistant.length - 1].eventData.text).to.equal(
        'let me check Thursday for you - yes, two o\'clock is free.',
      );
    });

    it('still names the day when the lookup answers immediately', async () => {
      delayMs = 0;
      await setupBookingStage({ text: 'let me check {{parameters.day}} for you' });

      queueClassification();
      harness.mockLlm.queueResponse(' - two o\'clock is free.');
      await harness.sendInput('can I come in on Thursday?');

      // The executor skips the acknowledgement when the tool has already returned, but that is
      // a tool resolving with no I/O at all. A real endpoint - even this one, on loopback, with
      // no delay asked of it - takes longer than rendering one line of Handlebars, so the line
      // is spoken. Which is fine: naming the day back is worth saying whether or not the wait
      // needed covering.
      const spoken = harness.events.aiChunks.map((c) => c.chunkText).filter((t) => t.length > 0);
      expect(spoken[0]).to.equal('let me check Thursday for you');
    });

    it('takes a message when the lookup passes its ceiling', async () => {
      delayMs = 2000;
      await setupBookingStage({
        text: 'let me check {{parameters.day}} for you',
        timeoutMs: 100,
        timeoutText: 'I am not getting an answer from our diary just now, so let me take a message.',
      });

      queueClassification();
      const callsBefore = harness.mockLlm.calls.length;
      await harness.sendInput('can I come in on Thursday?');

      const spoken = harness.events.aiChunks.map((c) => c.chunkText).filter((t) => t.length > 0);
      expect(spoken[0]).to.equal('let me check Thursday for you');
      expect(spoken).to.include('I am not getting an answer from our diary just now, so let me take a message.');
      // Answered without the reply model - there was nothing for it to work from. The only call
      // this turn made was the classifier's.
      expect(harness.mockLlm.calls.length - callsBefore).to.equal(1);
    });
  });
});
