import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/auth.mjs';

function fakeDatabase() {
  let admin = null;
  return {
    async adminCount() {
      return admin ? 1 : 0;
    },
    async createFirstAdmin(input) {
      admin = { id: 'admin-1', email: input.email, role: 'owner' };
      return admin;
    },
    async createAdminSession() {},
    async findAdminSession() {
      return null;
    },
  };
}

function request(address = '127.0.0.1') {
  return { socket: { remoteAddress: address }, headers: {} };
}

function config({ production }) {
  return {
    production,
    auth: {
      cookieName: 'voice_session',
      sessionHours: 8,
      loginMaxAttempts: 5,
      loginWindowMinutes: 15,
      setupToken: 'production-setup-token-with-32-characters',
      secureCookies: production,
    },
  };
}

test('produkcja wymaga tokenu konfiguracji także za lokalnym reverse proxy', async () => {
  const auth = createAuthService({ database: fakeDatabase(), config: config({ production: true }) });
  const req = request();

  const status = await auth.status(req);
  assert.equal(status.localSetupAllowed, false);
  assert.equal(status.setupTokenRequired, true);

  await assert.rejects(
    auth.setup(req, { email: 'owner@example.com', password: 'Correct-Horse-2030!' }),
    { code: 'AUTH_SETUP_FORBIDDEN' },
  );

  const result = await auth.setup(req, {
    email: 'owner@example.com',
    password: 'Correct-Horse-2030!',
    setupToken: 'production-setup-token-with-32-characters',
  });
  assert.equal(result.user.email, 'owner@example.com');
});

test('lokalny development zachowuje konfigurację bez tokenu', async () => {
  const auth = createAuthService({ database: fakeDatabase(), config: config({ production: false }) });
  const req = request();

  const status = await auth.status(req);
  assert.equal(status.localSetupAllowed, true);
  assert.equal(status.setupTokenRequired, false);

  const result = await auth.setup(req, {
    email: 'owner@example.com',
    password: 'Correct-Horse-2030!',
  });
  assert.equal(result.user.email, 'owner@example.com');
});
