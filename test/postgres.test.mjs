import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresDatabase } from '../src/voice/postgres-database.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL zachowuje transakcję hold → booking i blokuje wyścig o termin', {
  skip: databaseUrl ? false : 'Ustaw TEST_DATABASE_URL, aby uruchomić test PostgreSQL.'
}, async () => {
  const tenantId = `contract-${crypto.randomBytes(5).toString('hex')}`;
  const database = await createPostgresDatabase({
    config: {
      url: databaseUrl,
      sslMode: 'disable',
      poolMax: 4,
      idleTimeoutMs: 5_000,
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000
    },
    tenantId
  });

  try {
    const services = await database.listServices(tenantId);
    assert.equal(services.length, 3);
    const startAt = new Date(Date.UTC(2035, 0, 10, 10, 0, 0)).toISOString();
    const endAt = new Date(Date.UTC(2035, 0, 10, 10, 30, 0)).toISOString();
    const holdInput = {
      tenantId,
      serviceId: 'svc-consultation',
      startAt,
      endAt,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
    };
    const attempts = await Promise.allSettled([
      database.createHold(holdInput),
      database.createHold(holdInput)
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'SLOT_UNAVAILABLE');

    const hold = attempts.find((result) => result.status === 'fulfilled').value;
    const claimed = await database.claimHold(hold.id, tenantId);
    const idempotencyKey = `postgres-contract:${crypto.randomUUID()}`;
    const booking = await database.confirmHold({
      hold: claimed,
      customerName: 'Postgres Contract',
      phone: '+48600100200',
      email: 'postgres-contract@voice.test',
      providerUid: null,
      idempotencyKey
    });
    assert.equal(booking.status, 'confirmed');
    assert.equal((await database.findBookingByIdempotency(idempotencyKey)).id, booking.id);
    assert.equal(await database.health(), true);

    const otherTenantId = `contract-${crypto.randomBytes(5).toString('hex')}`;
    const otherTenantDatabase = await createPostgresDatabase({
      config: {
        url: databaseUrl,
        sslMode: 'disable',
        poolMax: 2,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 10_000
      },
      tenantId: otherTenantId
    });
    try {
      assert.equal((await otherTenantDatabase.listServices(otherTenantId)).length, 3);
      assert.equal((await otherTenantDatabase.listBookings(otherTenantId)).length, 0);
    } finally {
      await otherTenantDatabase.close();
    }
  } finally {
    await database.close();
  }
});
