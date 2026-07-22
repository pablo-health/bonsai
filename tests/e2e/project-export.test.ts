import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

interface Fixture { projectId: string; agentId: string; }

describe('Project Export API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fix = await createProjectWithAgent();
  });

  describe('export', () => {
    it('returns export bundle', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/export`);
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('formatVersion');
      expect(res.body).to.have.property('exportedAt');
      expect(res.body).to.have.property('project');
      expect(res.body).to.have.property('agents');
      expect(res.body).to.have.property('stages');
      expect(res.body.project.id).to.equal(fix.projectId);
    });

    it('export includes agents', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/export`);
      expect(res.status).to.equal(200);
      expect(res.body.agents).to.have.length(1);
    });

    it('export includes empty arrays for unused entities', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/export`);
      expect(res.status).to.equal(200);
      expect(res.body.classifiers).to.be.an('array');
      expect(res.body.tools).to.be.an('array');
      expect(res.body.globalActions).to.be.an('array');
      expect(res.body.guardrails).to.be.an('array');
    });

    it('returns 404 for non-existent project', async () => {
      const res = await authed().get('/api/projects/nonexistent/export');
      expect(res.status).to.equal(404);
    });
  });

  describe('import', () => {
    it('returns 400 for invalid bundle', async () => {
      const res = await authed().post('/api/projects/import').send({ invalid: 'bundle' });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for missing project field', async () => {
      const res = await authed().post('/api/projects/import').send({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        agents: [],
        stages: [],
        classifiers: [],
        contextTransformers: [],
        tools: [],
        globalActions: [],
        guardrails: [],
        knowledgeCategories: [],
        knowledgeItems: [],
      });
      expect(res.status).to.equal(400);
    });
  });
});
