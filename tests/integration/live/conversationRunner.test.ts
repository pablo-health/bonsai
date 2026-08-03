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
