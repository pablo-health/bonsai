import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

interface Fixture {
  projectId: string;
  agentId: string;
}

async function createFullFixture(): Promise<Fixture> {
  return await createProjectWithAgent();
}

describe('Scenario Conversation API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fix = await createFullFixture();
  });

  describe('list', () => {
    it('returns empty list', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/scenario-conversations`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array').that.is.empty;
      expect(res.body.total).to.equal(0);
    });

    it('respects pagination params', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/scenario-conversations?offset=0&limit=10`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
      expect(res.body.offset).to.equal(0);
    });

    it('accepts scenarioRunId filter param', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/scenario-conversations?scenarioRunId=some-run-id`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
    });
  });

  describe('get by id', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/scenario-conversations/nonexistent`);
      expect(res.status).to.equal(404);
    });
  });
});
