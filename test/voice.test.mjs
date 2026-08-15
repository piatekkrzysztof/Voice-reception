import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

let app;
let baseUrl;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'voice-reception-test-'));
  app = await createApp({
    voiceDbPath: join(temporaryDirectory, 'voice.sqlite'),
    env: {
      VOICE_TENANT_ID: 'voice-test-tenant',
      VOICE_PROVIDER: 'local',
      CALENDAR_PROVIDER: 'local',
      VOICE_SLOT_SECRET: 'contract-test-slot-secret',
      VOICE_WEBHOOK_SECRET: 'contract-test-webhook-secret',
      PUBLIC_BASE_URL: 'http://127.0.0.1:4173'
    }
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return { response, body: await response.json() };
}

test('health endpoint identyfikuje samodzielny produkt Voice Reception', async () => {
  const { response, body } = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'voice-reception');
});

test('booking korzysta z podpisanego slotu, holdu i idempotentnego potwierdzenia', async () => {
  const availability = await request('/api/voice/availability', {
    method: 'POST',
    body: JSON.stringify({ service: 'svc-coloring', preferredDate: '2030-01-02' })
  });
  assert.equal(availability.response.status, 200);
  assert.ok(availability.body.slots.length > 1);
  assert.match(availability.body.slots[0].id, /\./);

  const hold = await request('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId: availability.body.slots[0].id })
  });
  assert.equal(hold.response.status, 201);
  assert.equal(hold.body.hold.status, 'active');

  const duplicateHold = await request('/api/voice/holds', {
    method: 'POST',
    body: JSON.stringify({ slotId: availability.body.slots[0].id })
  });
  assert.equal(duplicateHold.response.status, 409);
  assert.equal(duplicateHold.body.error.code, 'SLOT_UNAVAILABLE');

  const headers = { 'idempotency-key': 'booking-confirm-contract-test' };
  const payload = JSON.stringify({ holdId: hold.body.hold.id, customerName: 'Anna Nowak', phone: '+48600100200' });
  const first = await request('/api/voice/bookings', { method: 'POST', body: payload, headers });
  const repeated = await request('/api/voice/bookings', { method: 'POST', body: payload, headers });
  assert.equal(first.response.status, 201);
  assert.equal(repeated.response.status, 200);
  assert.equal(first.body.booking.id, repeated.body.booking.id);
  assert.equal(app.voiceService.database.listBookings('voice-test-tenant').length, 1);
});

test('Vapi Tool Gateway zwraca wymagany kontrakt result', async () => {
  const webhook = await request('/api/webhooks/vapi', {
    method: 'POST',
    headers: { authorization: 'Bearer contract-test-webhook-secret' },
    body: JSON.stringify({
      message: {
        type: 'tool-calls',
        call: { id: 'vapi-contract-call' },
        toolCallList: [{
          id: 'tool-call-availability',
          name: 'check_availability',
          arguments: { service: 'Strzyżenie', preferredDate: '2030-01-03', timeRange: 'morning' }
        }]
      }
    })
  });
  assert.equal(webhook.response.status, 200);
  assert.equal(webhook.body.results[0].toolCallId, 'tool-call-availability');
  const result = JSON.parse(webhook.body.results[0].result);
  assert.equal(result.success, true);
  assert.ok(result.slots.length > 0);
});

test('webhook Vapi wymaga sekretu i zapisuje wyłącznie raport końcowy', async () => {
  const unauthorized = await request('/api/webhooks/vapi', {
    method: 'POST',
    body: JSON.stringify({ message: { type: 'status-update' } })
  });
  assert.equal(unauthorized.response.status, 401);

  const report = await request('/api/webhooks/vapi', {
    method: 'POST',
    headers: { authorization: 'Bearer contract-test-webhook-secret' },
    body: JSON.stringify({
      message: {
        type: 'end-of-call-report',
        call: {
          id: 'vapi-call-finished-1',
          startedAt: '2030-01-03T10:00:00.000Z',
          endedAt: '2030-01-03T10:02:00.000Z',
          endedReason: 'assistant-ended-call',
          customer: { number: '+48600100200' },
          cost: 1.25
        },
        analysis: {
          summary: 'Klient otrzymał informację o dostępnych terminach.',
          structuredData: { intent: 'Nowa rezerwacja', outcome: 'RESOLVED', aiDisclosure: true }
        }
      }
    })
  });
  assert.equal(report.response.status, 200);
  const saved = app.voiceService.dashboard().calls.find((call) => call.externalId === 'vapi-call-finished-1');
  assert.equal(saved.durationSeconds, 120);
  assert.equal(saved.outcome, 'RESOLVED');
});
