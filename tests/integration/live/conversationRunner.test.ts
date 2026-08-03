import 'reflect-metadata';
import { expect } from 'chai';
import { ConversationTestHarness } from './conversationTestHarness';

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
    // NOTE: Stage transition via go_to_stage requires the runner to reload stage data
    // from DB after prepareConversation(). The current harness caches stage data at
    // prepareConversation time, so dynamic updates are not reflected. This test is
    // deferred until the harness supports re-preparation mid-conversation.
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
  });
});
