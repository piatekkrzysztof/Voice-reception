import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresDatabase } from '../src/voice/postgres-database.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  'PostgreSQL zachowuje transakcję hold → booking i blokuje wyścig o termin',
  {
    skip: databaseUrl ? false : 'Ustaw TEST_DATABASE_URL, aby uruchomić test PostgreSQL.',
  },
  async () => {
    const tenantId = `contract-${crypto.randomBytes(5).toString('hex')}`;
    const database = await createPostgresDatabase({
      config: {
        url: databaseUrl,
        sslMode: 'disable',
        poolMax: 4,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        statementTimeoutMs: 10_000,
      },
      tenantId,
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
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
      const attempts = await Promise.allSettled([
        database.createHold(holdInput),
        database.createHold(holdInput),
      ]);
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
      assert.equal(
        attempts.find((result) => result.status === 'rejected').reason.code,
        'SLOT_UNAVAILABLE',
      );

      const hold = attempts.find((result) => result.status === 'fulfilled').value;
      const claimed = await database.claimHold(hold.id, tenantId);
      const idempotencyKey = `postgres-contract:${crypto.randomUUID()}`;
      const booking = await database.confirmHold({
        hold: claimed,
        customerName: 'Postgres Contract',
        phone: '+48600100200',
        email: 'postgres-contract@voice.test',
        providerUid: null,
        idempotencyKey,
      });
      assert.equal(booking.status, 'confirmed');
      assert.equal((await database.findBookingByIdempotency(idempotencyKey)).id, booking.id);
      assert.equal(await database.health(), true);

      await database.upsertCall({
        externalId: `old-call-${tenantId}`,
        tenantId,
        startedAt: '2020-01-01T10:00:00.000Z',
        endedAt: '2020-01-01T10:02:00.000Z',
        caller: '+48600100200',
        summary: 'Dane do usunięcia',
        outcome: 'BOOKED',
      });
      await database.recordEvent({ tenantId, type: 'old.event' });
      const retention = await database.applyRetention({
        now: '2040-01-01T00:00:00.000Z',
        callsBefore: '2039-01-01T00:00:00.000Z',
        bookingsBefore: '2039-01-01T00:00:00.000Z',
        eventsBefore: '2039-01-01T00:00:00.000Z',
        holdsBefore: '2039-01-01T00:00:00.000Z',
      });
      const retainedCall = (await database.listCalls(tenantId)).find(
        (item) => item.externalId === `old-call-${tenantId}`,
      );
      const retainedBooking = await database.findBookingByIdempotency(idempotencyKey);
      assert.equal(retainedCall.caller, null);
      assert.equal(retainedCall.summary, null);
      assert.equal(retainedBooking.customer, '[usunięto po retencji]');
      assert.equal(retainedBooking.phone, '');
      assert.ok(retention.deletedEvents >= 1);
      assert.equal(Number((await database.stats(tenantId)).bookings), 1);

      const otherTenantId = `contract-${crypto.randomBytes(5).toString('hex')}`;
      const otherTenantDatabase = await createPostgresDatabase({
        config: {
          url: databaseUrl,
          sslMode: 'disable',
          poolMax: 2,
          idleTimeoutMs: 5_000,
          connectionTimeoutMs: 5_000,
          statementTimeoutMs: 10_000,
        },
        tenantId: otherTenantId,
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
  },
);
