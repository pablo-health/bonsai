import 'reflect-metadata';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { z } from 'zod';
import { LlmProviderBase } from '../../../src/services/providers/llm/LlmProviderBase';
import { StructuredOutputError, type LlmGenerationOptions, type LlmGenerationResult, type LlmMessage, type StructuredOutputSupport } from '../../../src/services/providers/llm/ILlmProvider';

const RESULT = z.object({ actions: z.record(z.string(), z.record(z.string(), z.any())).optional().default({}) });

const MESSAGES: LlmMessage[] = [
  { role: 'system', content: 'Classify the input' },
  { role: 'user', content: 'put me through to someone' },
];

/**
 * A provider with no network in it. `replies` is consumed one per call; an entry that
 * is an Error is thrown, which is how a provider rejecting a tool request is spelled.
 */
class FakeProvider extends LlmProviderBase<{}> {
  public readonly calls: Array<{ messages: LlmMessage[]; options?: LlmGenerationOptions }> = [];

  constructor(private support: StructuredOutputSupport, private replies: Array<string | Error>) {
    super({});
    this.initialized = true;
  }

  structuredOutput(): StructuredOutputSupport {
    return this.support;
  }

  async generate(messages: LlmMessage[], options?: LlmGenerationOptions): Promise<LlmGenerationResult> {
    this.calls.push({ messages, options });
    const reply = this.replies.shift();
    if (reply === undefined) {
      throw new Error('FakeProvider ran out of replies');
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return {
      id: 'gen_1',
      content: [{ contentType: 'text', text: reply }],
      role: 'assistant',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }

  async generateStream(): Promise<void> {}
  async enumerateModels() {
    return [];
  }
}

describe('generateStructured', () => {
  describe('tier 1 - the API enforces the shape', () => {
    it('passes the schema through and accepts the first answer', async () => {
      const provider = new FakeProvider('tool', ['{"actions":{"put_through":{}}}']);
      const schema = { type: 'object', properties: { actions: { type: 'object' } }, required: ['actions'] };

      const result = await provider.generateStructured(MESSAGES, RESULT, { schema, schemaName: 'classification' });

      expect(result.mode).to.equal('tool');
      expect(result.attempts).to.equal(1);
      expect(result.value.actions).to.have.property('put_through');
      expect(provider.calls).to.have.length(1);
      expect(provider.calls[0].options?.schema).to.deep.equal(schema);
    });

    it('derives a schema when the caller does not supply one', async () => {
      const provider = new FakeProvider('tool', ['{"actions":{}}']);

      await provider.generateStructured(MESSAGES, RESULT);

      expect(provider.calls[0].options?.schema).to.be.an('object');
      expect(provider.calls[0].options?.schema).to.have.property('type', 'object');
    });

    it('falls back to the JSON rung when the provider rejects the tool request', async () => {
      // A Bedrock model family without forced tool use rejects the request outright.
      // A live call should survive that, at the cost of one extra round trip.
      const provider = new FakeProvider('tool', [new Error('toolChoice is not supported for this model'), '{"actions":{}}']);

      const result = await provider.generateStructured(MESSAGES, RESULT, { schema: { type: 'object' } });

      expect(result.attempts).to.equal(1);
      expect(provider.calls).to.have.length(2);
      expect(provider.calls[1].options?.schema).to.equal(undefined);
    });
  });

  describe('tier 2 - valid JSON, unverified shape', () => {
    it('retries once when the shape is wrong, and accepts the correction', async () => {
      const provider = new FakeProvider('json', ['{"actions":[]}', '{"actions":{"put_through":{}}}']);

      const result = await provider.generateStructured(MESSAGES, RESULT);

      expect(result.mode).to.equal('json');
      expect(result.attempts).to.equal(2);
      expect(provider.calls[0].options?.outputFormat).to.equal('json');
    });
  });

  describe('tier 3 - prose', () => {
    it('recovers JSON a model wrapped in a sentence', async () => {
      const provider = new FakeProvider('none', ['Sure thing! {"actions":{"put_through":{}}} Hope that helps.']);

      const result = await provider.generateStructured(MESSAGES, RESULT);

      expect(result.attempts).to.equal(1);
      expect(result.value.actions).to.have.property('put_through');
    });

    it('retries once with the parse error handed back to the model', async () => {
      const provider = new FakeProvider('none', ['I am ready. Waiting for the caller to speak.', '{"actions":{}}']);

      const result = await provider.generateStructured(MESSAGES, RESULT);

      expect(result.attempts).to.equal(2);
      const retry = provider.calls[1].messages;
      expect(retry).to.have.length(4);
      expect(retry[2].role).to.equal('assistant');
      expect(retry[2].content).to.equal('I am ready. Waiting for the caller to speak.');
      expect(retry[3].role).to.equal('user');
      expect(String(retry[3].content)).to.contain('JSON object only');
    });

    it('throws rather than returning something a caller could read as "no action"', async () => {
      const provider = new FakeProvider('none', [
        'I am ready. Waiting for the caller to speak.',
        'Still waiting.',
      ]);

      let thrown: unknown;
      try {
        await provider.generateStructured(MESSAGES, RESULT);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(StructuredOutputError);
      expect((thrown as StructuredOutputError).rawOutput).to.equal('Still waiting.');
      expect(provider.calls).to.have.length(2);
    });
  });

  it('defaults to the unconstrained rung, so an untouched provider behaves as before', async () => {
    class Untouched extends FakeProvider {
      constructor() {
        super('none', ['{"actions":{}}']);
      }
    }
    const provider = new Untouched();
    expect(LlmProviderBase.prototype.structuredOutput.call(provider)).to.equal('none');

    const result = await provider.generateStructured(MESSAGES, RESULT);
    expect(result.mode).to.equal('none');
    expect(provider.calls[0].options?.outputFormat).to.equal(undefined);
  });
});
