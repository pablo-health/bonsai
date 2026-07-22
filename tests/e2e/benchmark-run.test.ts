import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';

describe('Benchmark Run API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('list', () => {
    it('returns empty list', async () => {
      const res = await authed().get('/api/benchmarks/runs');
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array').that.is.empty;
      expect(res.body.total).to.equal(0);
    });

    it('respects offset/limit', async () => {
      const res = await authed().get('/api/benchmarks/runs?offset=0&limit=10');
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
    });
  });

  describe('trigger run', () => {
    it('returns 400 for missing suiteId', async () => {
      const res = await authed().post('/api/benchmarks/runs').send({});
      expect(res.status).to.equal(400);
    });

    it('returns 400 for empty suiteId', async () => {
      const res = await authed().post('/api/benchmarks/runs').send({ suiteId: '' });
      expect(res.status).to.equal(400);
    });

    it('returns error for non-existent suite', async () => {
      const res = await authed().post('/api/benchmarks/runs').send({ suiteId: 'nonexistent' });
      expect(res.status).to.be.oneOf([400, 404, 500]);
    });
  });

  describe('get by id', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().get('/api/benchmarks/runs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });

  describe('delete', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().delete('/api/benchmarks/runs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });

  describe('get results', () => {
    it('returns empty results for non-existent execution', async () => {
      const res = await authed().get('/api/benchmarks/executions/nonexistent/results');
      expect(res.status).to.equal(200);
      expect(res.body).to.be.an('array');
    });
  });
});
