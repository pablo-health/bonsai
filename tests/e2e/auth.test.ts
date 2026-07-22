import { describe, it } from 'mocha';
import { expect } from 'chai';
import { unauthed, authed, getAccessToken, getRefreshToken, resetDatabase } from '../utils';

describe('Auth API', () => {
  describe('POST /api/auth/login', () => {
    it('should login with valid credentials', async () => {
      const res = await unauthed()
        .post('/api/auth/login')
        .send({
          id: 'test@example.com',
          password: 'testpassword123',
        });
      expect(res.status).to.equal(200);
      expect(res.body.accessToken).to.be.a('string');
      expect(res.body.refreshToken).to.be.a('string');
      expect(res.body.expiresIn).to.be.a('number');
      expect(res.body.operatorId).to.equal('test@example.com');
      expect(res.body.displayName).to.equal('Test Admin');
      expect(res.body.roles).to.be.an('array');
      expect(res.body.permissions).to.be.an('array');
    });

    it('should reject with 401 for wrong password', async () => {
      const res = await unauthed()
        .post('/api/auth/login')
        .send({
          id: 'test@example.com',
          password: 'wrong-password',
        });
      expect(res.status).to.equal(401);
    });

    it('should reject with 401 for non-existent user', async () => {
      const res = await unauthed()
        .post('/api/auth/login')
        .send({
          id: 'nobody@example.com',
          password: 'does-not-matter',
        });
      expect(res.status).to.equal(401);
    });

    it('should reject with 400 for missing fields', async () => {
      const res = await unauthed()
        .post('/api/auth/login')
        .send({ id: 'test@example.com' });
      expect(res.status).to.equal(400);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('should refresh access token with valid refresh token', async () => {
      const res = await unauthed()
        .post('/api/auth/refresh')
        .send({ refreshToken: getRefreshToken() });
      expect(res.status).to.equal(200);
      expect(res.body.accessToken).to.be.a('string');
      expect(res.body.expiresIn).to.be.a('number');
      expect(res.body.roles).to.be.an('array');
      expect(res.body.permissions).to.be.an('array');
    });

    it('should reject with 401 for invalid refresh token', async () => {
      const res = await unauthed()
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-token-string' });
      expect(res.status).to.equal(401);
    });
  });

  describe('authenticated request flow', () => {
    it('should access a protected endpoint using the authed agent', async () => {
      const res = await authed().get('/api/profile');
      expect(res.status).to.equal(200);
      expect(res.body.id).to.equal('test@example.com');
      expect(res.body.name).to.equal('Test Admin');
    });
  });
});
