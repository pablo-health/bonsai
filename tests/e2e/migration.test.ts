import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';
import { createProjectWithAgent } from '../fixtures';

interface Fixture { projectId: string; agentId: string; }

describe('Migration API', () => {
  let fix: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fix = await createProjectWithAgent();
  });

  describe('preview', () => {
    it('returns preview with all entity types', async () => {
      const res = await authed().get('/api/migration/preview');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('totalCount');
      expect(res.body).to.have.property('providers');
      expect(res.body).to.have.property('projects');
      expect(res.body).to.have.property('agents');
      expect(res.body).to.have.property('stages');
      expect(res.body.projects).to.be.an('array');
      expect(res.body.agents).to.be.an('array');
    });

    it('preview includes created project', async () => {
      const res = await authed().get('/api/migration/preview');
      expect(res.status).to.equal(200);
      expect(res.body.projects).to.have.length(1);
      expect(res.body.projects[0].id).to.equal(fix.projectId);
    });
  });

  describe('export', () => {
    it('returns export bundle', async () => {
      const res = await authed().get('/api/migration/export');
      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('exportedAt');
      expect(res.body).to.have.property('restSchemaHash');
      expect(res.body).to.have.property('providers');
      expect(res.body).to.have.property('projects');
      expect(res.body.projects).to.be.an('array');
    });

    it('export includes project and agents', async () => {
      const res = await authed().get('/api/migration/export');
      expect(res.status).to.equal(200);
      expect(res.body.projects).to.have.length(1);
      expect(res.body.agents).to.have.length(1);
    });

    it('export with projectIds filter', async () => {
      const res = await authed().get(`/api/migration/export?projectIds=${fix.projectId}`);
      expect(res.status).to.equal(200);
      expect(res.body.projects).to.have.length(1);
    });
  });
});
