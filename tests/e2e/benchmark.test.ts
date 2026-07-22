import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';

describe('Benchmark Config API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('create', () => {
    it('returns 400 for missing suiteId', async () => {
      const res = await authed().post('/api/benchmarks/configs').send({
        name: 'Test Config',
        providerConfigId: 'nonexistent',
        inputType: 'text',
        inputData: { text: 'hello' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for missing providerConfigId', async () => {
      const res = await authed().post('/api/benchmarks/configs').send({
        suiteId: 'nonexistent',
        name: 'Test Config',
        inputType: 'text',
        inputData: { text: 'hello' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for missing inputType', async () => {
      const res = await authed().post('/api/benchmarks/configs').send({
        suiteId: 'nonexistent',
        name: 'Test Config',
        providerConfigId: 'nonexistent',
        inputData: { text: 'hello' },
      });
      expect(res.status).to.equal(400);
    });

    it('returns 400 for missing inputData', async () => {
      const res = await authed().post('/api/benchmarks/configs').send({
        suiteId: 'nonexistent',
        name: 'Test Config',
        providerConfigId: 'nonexistent',
        inputType: 'text',
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('get by id', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().get('/api/benchmarks/configs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });

  describe('update', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().put('/api/benchmarks/configs/nonexistent').send({ name: 'X', version: 1 });
      expect(res.status).to.equal(404);
    });
  });

  describe('delete', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().delete('/api/benchmarks/configs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });
});

describe('Benchmark Provider Config API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('list', () => {
    it('returns empty list', async () => {
      const res = await authed().get('/api/benchmarks/provider-configs');
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array');
    });
  });

  describe('create', () => {
    it('rejects missing name (400)', async () => {
      const res = await authed().post('/api/benchmarks/provider-configs').send({
        providerType: 'llm',
        providerId: 'nonexistent',
        settings: { model: 'gpt-4o' },
      });
      expect(res.status).to.equal(400);
    });

    it('rejects missing providerType (400)', async () => {
      const res = await authed().post('/api/benchmarks/provider-configs').send({
        name: 'Test',
        providerId: 'nonexistent',
        settings: { model: 'gpt-4o' },
      });
      expect(res.status).to.equal(400);
    });

    it('rejects missing settings (400)', async () => {
      const res = await authed().post('/api/benchmarks/provider-configs').send({
        name: 'Test',
        providerType: 'llm',
        providerId: 'nonexistent',
      });
      expect(res.status).to.equal(400);
    });

    it('rejects invalid providerType (400)', async () => {
      const res = await authed().post('/api/benchmarks/provider-configs').send({
        name: 'Test',
        providerType: 'invalid_type',
        providerId: 'nonexistent',
        settings: { model: 'gpt-4o' },
      });
      expect(res.status).to.equal(400);
    });
  });

  describe('get by id', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().get('/api/benchmarks/provider-configs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });

  describe('update', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().put('/api/benchmarks/provider-configs/nonexistent').send({ name: 'X', version: 1 });
      expect(res.status).to.equal(404);
    });
  });

  describe('delete', () => {
    it('returns 404 for non-existent', async () => {
      const res = await authed().delete('/api/benchmarks/provider-configs/nonexistent');
      expect(res.status).to.equal(404);
    });
  });
});
