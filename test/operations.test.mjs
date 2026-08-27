import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, createOperations } from '../src/operations.mjs';
import { createVoiceDatabase } from '../src/voice/database.mjs';

function operationsConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    operations: {
      maxInflight: 1,
      alerts: {
        webhookUrl: '',
        bearerToken: '',
        cooldownMinutes: 10,
        timeoutMs: 1_000,
        ...overrides,
      },
    },
  };
}

test('logi strukturalne usuwają dane klienta i sekrety', () => {
  const lines = [];
  const logger = createLogger({
    output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  logger.info('test.event', {
    phone: '+48600100200',
    nested: { email: 'anna@example.com', authorization: 'Bearer sekret', safeCode: 'OK' },
  });
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.phone, '[REDACTED]');
  assert.equal(entry.nested.email, '[REDACTED]');
  assert.equal(entry.nested.authorization, '[REDACTED]');
  assert.equal(entry.nested.safeCode, 'OK');
});

test('limit operacji odrzuca przeciążenie i zwalnia miejsce po odpowiedzi', async () => {
  const logger = createLogger({ output: { log() {}, error() {} } });
  const operations = createOperations({ config: operationsConfig(), logger });
  const first = operations.beginRequest({
    method: 'POST',
    route: '/api/webhooks/vapi',
    protectedRoute: true,
  });
  const second = operations.beginRequest({
    method: 'POST',
    route: '/api/webhooks/vapi',
    protectedRoute: true,
  });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  first.finish(200);
  const third = operations.beginRequest({
    method: 'POST',
    route: '/api/webhooks/vapi',
    protectedRoute: true,
  });
  assert.equal(third.accepted, true);
  third.finish(200);
  assert.equal(operations.snapshot().http.rejected, 1);
  await operations.close();
});

test('alert jest pozbawiony PII i ograniczony czasowo dla tego samego kodu', async () => {
  const sent = [];
  const logger = createLogger({ output: { log() {}, error() {} } });
  const operations = createOperations({
    config: operationsConfig({
      webhookUrl: 'https://alerts.example.test/hook',
      bearerToken: 'alert-secret',
    }),
    logger,
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(
    operations.notify({ severity: 'critical', code: 'CALCOM_TIMEOUT', component: 'booking' }),
    true,
  );
  assert.equal(
    operations.notify({ severity: 'critical', code: 'CALCOM_TIMEOUT', component: 'booking' }),
    false,
  );
  await operations.close();
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].options.body);
  assert.deepEqual(Object.keys(payload).sort(), [
    'code',
    'component',
    'environment',
    'requestId',
    'service',
    'severity',
    'time',
  ]);
  assert.equal(JSON.stringify(payload).includes('alert-secret'), false);
});

test('retencja anonimizuje dane osobowe, zachowując metryki rezerwacji', () => {
  const database = createVoiceDatabase({ path: ':memory:', tenantId: 'retention-test' });
  database.upsertCall({
    externalId: 'old-call',
    tenantId: 'retention-test',
    startedAt: '2020-01-01T10:00:00.000Z',
    endedAt: '2020-01-01T10:02:00.000Z',
    caller: '+48600100200',
    summary: 'Anna chce umówić wizytę',
    outcome: 'BOOKED',
  });
  database.raw
    .prepare(
      `INSERT INTO voice_bookings
      (id, tenant_id, service_id, hold_id, start_at, end_at, customer_name, phone, email,
       status, provider_uid, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'cancelled', ?, ?, ?, ?)`,
    )
    .run(
      'old-booking',
      'retention-test',
      'svc-haircut',
      '2020-01-02T10:00:00.000Z',
      '2020-01-02T11:00:00.000Z',
      'Anna Nowak',
      '+48600100200',
      'anna@example.com',
      'cal-old',
      'old-idempotency',
      '2020-01-01T10:00:00.000Z',
      '2020-01-01T10:00:00.000Z',
    );
  const event = database.recordEvent({ tenantId: 'retention-test', type: 'old.event' });
  database.raw
    .prepare('UPDATE voice_events SET created_at = ? WHERE id = ?')
    .run('2020-01-01T10:00:00.000Z', event.id);

  const result = database.applyRetention({
    now: '2030-01-01T00:00:00.000Z',
    callsBefore: '2029-01-01T00:00:00.000Z',
    bookingsBefore: '2029-01-01T00:00:00.000Z',
    eventsBefore: '2029-01-01T00:00:00.000Z',
    holdsBefore: '2029-01-01T00:00:00.000Z',
  });

  const call = database.listCalls('retention-test')[0];
  const booking = database.listBookings('retention-test')[0];
  assert.equal(call.caller, null);
  assert.equal(call.summary, null);
  assert.equal(booking.customer, '[usunięto po retencji]');
  assert.equal(booking.phone, '');
  assert.equal(booking.email, null);
  assert.equal(database.stats('retention-test').bookings, 0);
  assert.equal(result.deletedEvents, 1);
  database.close();
});
