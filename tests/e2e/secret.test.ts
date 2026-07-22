import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { authed, resetDatabase } from '../utils';

describe('Secret API', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  describe('list', () => {
    it('returns empty list', async () => {
      const res = await authed().get('/api/secrets');
      expect(res.status).to.equal(200);
      expect(res.body.items).to.be.an('array').that.is.empty;
      expect(res.body.orphans).to.be.an('array');
    });
  });

  describe('reveal', () => {
    it('returns 404 for non-existent secret', async () => {
      const res = await authed().get('/api/secrets/nonexistent/value');
      expect(res.status).to.equal(404);
    });
  });

  describe('delete', () => {
    it('returns 404 for non-existent secret', async () => {
      const res = await authed().delete('/api/secrets/nonexistent');
      expect(res.status).to.equal(404);
    });
  });
});
