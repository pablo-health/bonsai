import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

interface Fixture { projectId: string; agentId: string; }

describe('Analytics API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fix = await createProjectWithAgent();
  });

  describe('latency stats', () => {
    it('returns empty stats', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/latency`);
      expect(res.status).to.equal(200);
      expect(res.body.totalTurns).to.equal(0);
    });
  });

  describe('latency percentiles', () => {
    it('returns empty percentiles', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/latency/percentiles`);
      expect(res.status).to.equal(200);
      expect(res.body.totalTurns).to.equal(0);
    });
  });

  describe('latency trend', () => {
    it('returns empty trend', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/latency/trend`);
      expect(res.status).to.equal(200);
      expect(res.body.points).to.be.an('array').that.is.empty;
    });

    it('respects interval param', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/latency/trend?interval=hour`);
      expect(res.status).to.equal(200);
      expect(res.body.interval).to.equal('hour');
    });
  });

  describe('token usage stats', () => {
    it('returns empty usage', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/usage`);
      expect(res.status).to.equal(200);
      expect(res.body.totalEvents).to.equal(0);
    });
  });

  describe('token usage trend', () => {
    it('returns empty trend', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/usage/trend`);
      expect(res.status).to.equal(200);
      expect(res.body.points).to.be.an('array').that.is.empty;
    });
  });

  describe('source catalog', () => {
    it('returns source catalog', async () => {
      const res = await authed().get(`/api/projects/${fix.projectId}/analytics/sources`);
      expect(res.status).to.equal(200);
    });
  });
});
