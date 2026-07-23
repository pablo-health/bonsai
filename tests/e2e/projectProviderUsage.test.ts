import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, unauthed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

// ── Minimal provider payloads ────────────────────────────────────────
function minimalLlmProvider() {
  return {
    name: 'Test LLM Provider',
    providerType: 'llm',
    apiType: 'openai',
    config: {
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com',
    },
  };
}

function minimalTtsProvider() {
  return {
    name: 'Test TTS Provider',
    providerType: 'tts',
    apiType: 'elevenlabs',
    config: {
      apiKey: 'sk-test-key',
    },
  };
}

// ── Test state ───────────────────────────────────────────────────────
interface Fixture {
  projectId: string;
  agentId: string;
  llmProviderId: string;
  llmProviderId2: string;
  ttsProviderId: string;
}

describe('Project Provider Usage API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    const { projectId, agentId } = await createProjectWithAgent();

    // Create providers
    const llmRes = await authed().post('/api/providers').send(minimalLlmProvider());
    const llmRes2 = await authed().post('/api/providers').send({ ...minimalLlmProvider(), name: 'Test LLM Provider 2' });
    const ttsRes = await authed().post('/api/providers').send(minimalTtsProvider());

    fix = {
      projectId,
      agentId,
      llmProviderId: llmRes.body.id,
      llmProviderId2: llmRes2.body.id,
      ttsProviderId: ttsRes.body.id,
    };
  });

  describe('GET /api/projects/:projectId/providers/used', () => {
    it('returns empty report when no entities reference providers', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.be.an('array').that.is.empty;
      expect(res.body.summary.totalProviders).to.equal(0);
      expect(res.body.summary.byType.llm).to.equal(0);
      expect(res.body.summary.byType.tts).to.equal(0);
    });

    it('returns 404 for non-existent project', async () => {
      const res = await authed().get('/api/projects/nonexistent/providers/used');
      expect(res.status).to.equal(404);
    });

    it('returns 401 for unauthenticated request', async () => {
      const res = await unauthed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(401);
    });

    it('reports agent with TTS provider', async () => {
      // Fetch agent to get version for optimistic locking
      const agentRes = await authed().get(`/api/projects/${fix.projectId}/agents/${fix.agentId}`);
      const agent = agentRes.body;
      await authed()
        .put(`/api/projects/${fix.projectId}/agents/${fix.agentId}`)
        .send({
          name: agent.name,
          prompt: agent.prompt,
          version: agent.version,
          ttsProviderId: fix.ttsProviderId,
          ttsSettings: {
            provider: 'elevenlabs',
            voiceId: 'test-voice',
            model: 'eleven_flash_v2_5',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.id).to.equal(fix.ttsProviderId);
      expect(provider.providerType).to.equal('tts');
      expect(provider.usage).to.have.length(1);
      expect(provider.usage[0].entityType).to.equal('agent');
      expect(provider.usage[0].entityId).to.equal(fix.agentId);
      expect(provider.usage[0].modelName).to.equal('eleven_flash_v2_5');

      expect(res.body.summary.totalProviders).to.equal(1);
      expect(res.body.summary.byType.tts).to.equal(1);
    });

    it('reports stage with LLM provider', async () => {
      await authed()
        .post(`/api/projects/${fix.projectId}/stages`)
        .send({
          name: 'Test Stage',
          prompt: 'Test prompt',
          agentId: fix.agentId,
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.id).to.equal(fix.llmProviderId);
      expect(provider.providerType).to.equal('llm');
      expect(provider.usage).to.have.length(1);
      expect(provider.usage[0].entityType).to.equal('stage');
      expect(provider.usage[0].modelName).to.equal('gpt-4');

      expect(res.body.summary.totalProviders).to.equal(1);
      expect(res.body.summary.byType.llm).to.equal(1);
    });

    it('reports multiple entities using the same provider', async () => {
      // Create a classifier and a stage using the same LLM provider
      await authed()
        .post(`/api/projects/${fix.projectId}/classifiers`)
        .send({
          name: 'Test Classifier',
          prompt: 'Classify this',
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-3.5-turbo',
          },
        });

      await authed()
        .post(`/api/projects/${fix.projectId}/stages`)
        .send({
          name: 'Test Stage',
          prompt: 'Test prompt',
          agentId: fix.agentId,
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.usage).to.have.length(2);
      expect(provider.usage.map((u: any) => u.entityType)).to.include('classifier');
      expect(provider.usage.map((u: any) => u.entityType)).to.include('stage');
      expect(res.body.summary.totalProviders).to.equal(1);
    });

    it('reports multiple distinct providers across entity types', async () => {
      // Agent with TTS
      const agentRes = await authed().get(`/api/projects/${fix.projectId}/agents/${fix.agentId}`);
      const agent = agentRes.body;
      await authed()
        .put(`/api/projects/${fix.projectId}/agents/${fix.agentId}`)
        .send({
          name: agent.name,
          prompt: agent.prompt,
          version: agent.version,
          ttsProviderId: fix.ttsProviderId,
          ttsSettings: {
            provider: 'elevenlabs',
            voiceId: 'test-voice',
          },
        });

      // Stage with LLM provider 1
      await authed()
        .post(`/api/projects/${fix.projectId}/stages`)
        .send({
          name: 'Test Stage',
          prompt: 'Test prompt',
          agentId: fix.agentId,
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
        });

      // Classifier with LLM provider 2
      await authed()
        .post(`/api/projects/${fix.projectId}/classifiers`)
        .send({
          name: 'Test Classifier',
          prompt: 'Classify this',
          llmProviderId: fix.llmProviderId2,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-3.5-turbo',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(3);
      expect(res.body.summary.totalProviders).to.equal(3);
      expect(res.body.summary.byType.llm).to.equal(2);
      expect(res.body.summary.byType.tts).to.equal(1);
    });

    it('reports tester with LLM provider', async () => {
      await authed()
        .post(`/api/projects/${fix.projectId}/testers`)
        .send({
          name: 'Test Tester',
          prompt: 'You are a test user.',
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.usage).to.have.length(1);
      expect(provider.usage[0].entityType).to.equal('tester');
    });

    it('reports tool with LLM provider', async () => {
      await authed()
        .post(`/api/projects/${fix.projectId}/tools`)
        .send({
          type: 'smart_function',
          name: 'Test Tool',
          prompt: 'Execute this tool',
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
          inputType: 'text',
          outputType: 'text',
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.usage).to.have.length(1);
      expect(provider.usage[0].entityType).to.equal('tool');
    });

    it('reports context transformer with LLM provider', async () => {
      await authed()
        .post(`/api/projects/${fix.projectId}/context-transformers`)
        .send({
          name: 'Test Transformer',
          prompt: 'Transform this',
          llmProviderId: fix.llmProviderId,
          llmSettings: {
            provider: 'openai',
            model: 'gpt-4',
          },
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.have.length(1);

      const provider = res.body.providers[0];
      expect(provider.usage).to.have.length(1);
      expect(provider.usage[0].entityType).to.equal('contextTransformer');
    });

    it('excludes entities that do not reference a provider', async () => {
      // Create a tester without LLM provider (tester has optional llmProviderId)
      await authed()
        .post(`/api/projects/${fix.projectId}/testers`)
        .send({
          name: 'Tester Without LLM',
          prompt: 'You are a test user.',
        });

      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.be.an('array').that.is.empty;
      expect(res.body.summary.totalProviders).to.equal(0);
    });

    it('excludes providers that exist but are not referenced by any entity', async () => {
      // Providers were created in beforeEach but nothing references them
      const res = await authed().get(`/api/projects/${fix.projectId}/providers/used`);
      expect(res.status).to.equal(200);
      expect(res.body.providers).to.be.an('array').that.is.empty;
      expect(res.body.summary.totalProviders).to.equal(0);
    });
  });
});
