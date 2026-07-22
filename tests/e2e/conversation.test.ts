import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

interface Fixture { projectId: string; agentId: string; }

describe('Conversation API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fix = await createProjectWithAgent();
  });

  describe('list', () => {
    it('returns empty list', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations`);
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array').that.is.empty;
    });
  });

  describe('get by id', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent`);
      expect(res.status).to.equal(404);
    });
  });

  describe('events', () => {
    it('returns 404 for non-existent conversation', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent/events`);
      expect(res.status).to.equal(404);
    });

    it('returns 404 for non-existent event', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent/events/nonexistent`);
      expect(res.status).to.equal(404);
    });
  });

  describe('artifacts', () => {
    it('returns 404 for non-existent conversation', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent/artifacts`);
      expect(res.status).to.equal(404);
    });

    it('returns 404 for non-existent artifact', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent/artifacts/nonexistent`);
      expect(res.status).to.equal(404);
    });
  });

  describe('audit logs', () => {
    it('returns empty array for non-existent conversation', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/conversations/nonexistent/audit-logs`);
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array').that.is.empty;
    });
  });

  describe('delete', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().delete(`/api/projects/${fix.projectId}/conversations/nonexistent`);
      expect(res.status).to.equal(404);
    });
  });
});
