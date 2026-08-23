import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const migrationUrl = new URL('../../migrations/001_postgres_initial.sql', import.meta.url);

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function poolOptions(config) {
  const options = {
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'voice-reception'
  };
  if (config.sslMode === 'disable') options.ssl = false;
  if (config.sslMode === 'no-verify') options.ssl = { rejectUnauthorized: false };
  if (config.sslMode === 'verify-full') options.ssl = { rejectUnauthorized: true };
  return options;
}

async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('voice-reception:migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS voice_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query('SELECT 1 FROM voice_schema_migrations WHERE version = 1');
    if (!applied.rowCount) {
      const sql = await readFile(migrationUrl, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO voice_schema_migrations (version) VALUES (1)');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('voice-reception:migrations'))").catch(() => {});
    client.release();
  }
}

function mapService(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    durationMinutes: row.duration_minutes,
    externalEventTypeId: row.external_event_type_id,
    active: Boolean(row.active)
  };
}

function mapHold(row) {
  return row ? {
    id: row.id,
    tenantId: row.tenant_id,
    serviceId: row.service_id,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    status: row.status,
    providerReservationUid: row.provider_reservation_uid,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at)
  } : null;
}

function mapBooking(row) {
  return row ? {
    id: row.id,
    tenantId: row.tenant_id,
    holdId: row.hold_id,
    serviceId: row.service_id,
    service: row.service_name,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    customer: row.customer_name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    providerUid: row.provider_uid,
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
    slot: {
      service: row.service_name,
      start: iso(row.start_at),
      end: iso(row.end_at),
      date: iso(row.start_at).slice(0, 10),
      time: new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' }).format(new Date(row.start_at)),
      duration: row.duration_minutes
    }
  } : null;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createPostgresDatabase({ config, tenantId, seedCalls = [] }) {
  const pool = new Pool(poolOptions(config));
  pool.on('error', (error) => console.error('PostgreSQL pool error', error));
  await pool.query('SELECT 1');
  await migrate(pool);

  const serviceRows = [
    ['svc-coloring', 'coloring', 'Koloryzacja', 120],
    ['svc-haircut', 'haircut', 'Strzyżenie', 60],
    ['svc-consultation', 'consultation', 'Konsultacja', 30]
  ];
  for (const row of serviceRows) {
    await pool.query(`INSERT INTO voice_services (id, tenant_id, slug, name, duration_minutes)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, slug) DO NOTHING`,
    [row[0], tenantId, row[1], row[2], row[3]]);
  }

  async function expireHolds(now = new Date().toISOString(), client = pool) {
    const result = await client.query(`UPDATE voice_holds SET status = 'expired'
      WHERE status IN ('active','confirming') AND expires_at <= $1`, [now]);
    return result.rowCount;
  }

  async function listServices(currentTenant = tenantId) {
    const result = await pool.query(`SELECT id, slug, name, duration_minutes, external_event_type_id, active
      FROM voice_services WHERE tenant_id = $1 AND active = TRUE ORDER BY duration_minutes`, [currentTenant]);
    return result.rows.map(mapService);
  }

  async function configureEventTypes(eventTypes, currentTenant = tenantId) {
    for (const [slug, eventTypeId] of Object.entries(eventTypes || {})) {
      if (eventTypeId) await pool.query(`UPDATE voice_services SET external_event_type_id = $1
        WHERE tenant_id = $2 AND slug = $3`, [eventTypeId, currentTenant, slug]);
    }
  }

  async function slotIsFree({ tenantId: currentTenant = tenantId, serviceId, startAt, endAt }, client = pool) {
    await expireHolds(new Date().toISOString(), client);
    const result = await client.query(`SELECT EXISTS (
      SELECT 1 FROM voice_bookings WHERE tenant_id = $1 AND service_id = $2 AND status = 'confirmed'
        AND start_at < $4 AND end_at > $3
      UNION ALL
      SELECT 1 FROM voice_holds WHERE tenant_id = $1 AND service_id = $2
        AND status IN ('active','confirming') AND expires_at > NOW()
        AND start_at < $4 AND end_at > $3
    ) AS occupied`, [currentTenant, serviceId, startAt, endAt]);
    return !result.rows[0].occupied;
  }

  async function createHold({ tenantId: currentTenant = tenantId, serviceId, startAt, endAt, expiresAt, providerReservationUid = null }) {
    return transaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${currentTenant}:${serviceId}:${startAt.slice(0, 10)}`]);
      if (!await slotIsFree({ tenantId: currentTenant, serviceId, startAt, endAt }, client)) {
        const error = new Error('Termin nie jest już dostępny.');
        error.code = 'SLOT_UNAVAILABLE';
        error.status = 409;
        throw error;
      }
      const hold = { id: id('HOLD'), tenantId: currentTenant, serviceId, startAt, endAt, status: 'active', providerReservationUid, expiresAt, createdAt: new Date().toISOString() };
      await client.query(`INSERT INTO voice_holds
        (id, tenant_id, service_id, start_at, end_at, status, provider_reservation_uid, expires_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [hold.id, hold.tenantId, hold.serviceId, hold.startAt, hold.endAt, hold.status, hold.providerReservationUid, hold.expiresAt, hold.createdAt]);
      return hold;
    });
  }

  async function getHold(holdId, currentTenant = tenantId, client = pool) {
    await expireHolds(new Date().toISOString(), client);
    const result = await client.query('SELECT * FROM voice_holds WHERE id = $1 AND tenant_id = $2', [holdId, currentTenant]);
    return mapHold(result.rows[0]);
  }

  async function claimHold(holdId, currentTenant = tenantId) {
    return transaction(pool, async (client) => {
      await expireHolds(new Date().toISOString(), client);
      const result = await client.query(`UPDATE voice_holds SET status = 'confirming'
        WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND expires_at > NOW()
        RETURNING *`, [holdId, currentTenant]);
      if (!result.rowCount) {
        const error = new Error('Rezerwacja tymczasowa wygasła lub została wykorzystana.');
        error.code = 'HOLD_INVALID';
        error.status = 409;
        throw error;
      }
      return mapHold(result.rows[0]);
    });
  }

  async function releaseClaim(holdId) {
    await pool.query(`UPDATE voice_holds
      SET status = CASE WHEN expires_at > NOW() THEN 'active' ELSE 'expired' END
      WHERE id = $1 AND status = 'confirming'`, [holdId]);
  }

  async function findBookingByIdempotency(idempotencyKey, client = pool) {
    const result = await client.query(`SELECT b.*, s.name AS service_name, s.duration_minutes
      FROM voice_bookings b JOIN voice_services s ON s.id = b.service_id AND s.tenant_id = b.tenant_id
      WHERE b.idempotency_key = $1`, [idempotencyKey]);
    return mapBooking(result.rows[0]);
  }

  async function confirmHold({ hold, customerName, phone, email, providerUid, idempotencyKey }) {
    return transaction(pool, async (client) => {
      const existing = await findBookingByIdempotency(idempotencyKey, client);
      if (existing) return existing;
      const current = await client.query(`SELECT * FROM voice_holds
        WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [hold.id, hold.tenantId]);
      if (!current.rowCount || current.rows[0].status !== 'confirming') {
        const error = new Error('Nie można potwierdzić tej blokady terminu.');
        error.code = 'HOLD_INVALID';
        error.status = 409;
        throw error;
      }
      const bookingId = id('BOOK');
      const now = new Date().toISOString();
      try {
        await client.query(`INSERT INTO voice_bookings
          (id, tenant_id, service_id, hold_id, start_at, end_at, customer_name, phone, email, status, provider_uid, idempotency_key, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$12)`,
        [bookingId, hold.tenantId, hold.serviceId, hold.id, hold.startAt, hold.endAt, customerName, phone, email || null, providerUid || null, idempotencyKey, now]);
      } catch (cause) {
        if (cause.code === '23505') {
          const error = new Error('Termin został zajęty w trakcie potwierdzania.');
          error.code = 'BOOKING_CONFLICT';
          error.status = 409;
          error.cause = cause;
          throw error;
        }
        throw cause;
      }
      await client.query("UPDATE voice_holds SET status = 'confirmed' WHERE id = $1", [hold.id]);
      return findBookingByIdempotency(idempotencyKey, client);
    });
  }

  async function listBookings(currentTenant = tenantId, limit = 50) {
    const result = await pool.query(`SELECT b.*, s.name AS service_name, s.duration_minutes
      FROM voice_bookings b JOIN voice_services s ON s.id = b.service_id AND s.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1 ORDER BY b.start_at DESC LIMIT $2`, [currentTenant, limit]);
    return result.rows.map(mapBooking);
  }

  async function cancelBooking(bookingId, currentTenant = tenantId) {
    const result = await pool.query(`UPDATE voice_bookings b SET status = 'cancelled', updated_at = NOW()
      FROM voice_services s WHERE b.service_id = s.id AND b.tenant_id = s.tenant_id AND b.id = $1 AND b.tenant_id = $2
      RETURNING b.*, s.name AS service_name, s.duration_minutes`, [bookingId, currentTenant]);
    return mapBooking(result.rows[0]);
  }

  async function upsertCall(call) {
    const now = new Date().toISOString();
    const callId = call.id || id('CALL');
    const result = await pool.query(`INSERT INTO voice_calls
      (id, external_id, tenant_id, provider, started_at, ended_at, duration_seconds, caller, intent, outcome, booking_id, transferred, cost, ai_disclosure, summary, ended_reason, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
      ON CONFLICT(external_id) DO UPDATE SET
        ended_at = EXCLUDED.ended_at, duration_seconds = EXCLUDED.duration_seconds,
        caller = COALESCE(EXCLUDED.caller, voice_calls.caller), intent = COALESCE(EXCLUDED.intent, voice_calls.intent),
        outcome = EXCLUDED.outcome, booking_id = COALESCE(EXCLUDED.booking_id, voice_calls.booking_id),
        transferred = EXCLUDED.transferred, cost = EXCLUDED.cost, ai_disclosure = EXCLUDED.ai_disclosure,
        summary = COALESCE(EXCLUDED.summary, voice_calls.summary), ended_reason = COALESCE(EXCLUDED.ended_reason, voice_calls.ended_reason),
        updated_at = EXCLUDED.updated_at RETURNING id`,
    [callId, call.externalId || callId, call.tenantId || tenantId, call.provider || 'vapi', call.startedAt || now, call.endedAt || null,
      call.durationSeconds || 0, call.caller || null, call.intent || null, call.outcome || 'IN_PROGRESS', call.bookingId || null,
      Boolean(call.transferred), call.cost || 0, call.aiDisclosure !== false, call.summary || null, call.endedReason || null, now]);
    return result.rows[0].id;
  }

  async function listCalls(currentTenant = tenantId, limit = 50) {
    const result = await pool.query(`SELECT id, external_id, tenant_id, provider, started_at, ended_at,
      duration_seconds, caller, intent, outcome, booking_id, transferred, cost, ai_disclosure, summary, ended_reason
      FROM voice_calls WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`, [currentTenant, limit]);
    return result.rows.map((row) => ({
      id: row.id,
      externalId: row.external_id,
      tenantId: row.tenant_id,
      provider: row.provider,
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
      durationSeconds: row.duration_seconds,
      caller: row.caller,
      intent: row.intent,
      outcome: row.outcome,
      bookingId: row.booking_id,
      transferred: Boolean(row.transferred),
      cost: Number(row.cost),
      aiDisclosure: Boolean(row.ai_disclosure),
      summary: row.summary,
      endedReason: row.ended_reason,
      booking: row.summary || row.booking_id || null
    }));
  }

  async function recordEvent({ tenantId: currentTenant = tenantId, callId = null, type, detail = null }) {
    const event = { id: id('VEVT'), tenantId: currentTenant, callId, type, detail, createdAt: new Date().toISOString() };
    await pool.query(`INSERT INTO voice_events (id, tenant_id, call_id, type, detail, created_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [event.id, event.tenantId, event.callId, event.type, event.detail || {}, event.createdAt]);
    return event;
  }

  async function stats(currentTenant = tenantId) {
    const callsResult = await pool.query(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost),0) AS cost,
      COALESCE(AVG(duration_seconds),0) AS average_duration,
      COUNT(*) FILTER (WHERE transferred = TRUE) AS transfers,
      COUNT(*) FILTER (WHERE ai_disclosure = TRUE) AS disclosed
      FROM voice_calls WHERE tenant_id = $1`, [currentTenant]);
    const bookingsResult = await pool.query(`SELECT COUNT(*) AS bookings FROM voice_bookings
      WHERE tenant_id = $1 AND status = 'confirmed'`, [currentTenant]);
    const row = callsResult.rows[0];
    return { calls: row.calls, cost: row.cost, averageDuration: row.average_duration, transfers: row.transfers, disclosed: row.disclosed, bookings: bookingsResult.rows[0].bookings };
  }

  async function adminCount() {
    const result = await pool.query('SELECT COUNT(*) AS count FROM voice_admins');
    return Number(result.rows[0].count);
  }

  async function createFirstAdmin({ email, passwordHash }) {
    return transaction(pool, async (client) => {
      await client.query('LOCK TABLE voice_admins IN EXCLUSIVE MODE');
      const count = await client.query('SELECT COUNT(*) AS count FROM voice_admins');
      if (Number(count.rows[0].count) > 0) {
        const error = new Error('Konfiguracja właściciela została już zakończona.');
        error.status = 409;
        error.code = 'AUTH_SETUP_COMPLETE';
        throw error;
      }
      const admin = { id: id('ADMIN'), email, role: 'owner', createdAt: new Date().toISOString() };
      await client.query(`INSERT INTO voice_admins (id, email, password_hash, role, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$5)`, [admin.id, admin.email, passwordHash, admin.role, admin.createdAt]);
      return admin;
    });
  }

  async function findAdminByEmail(email) {
    const result = await pool.query(`SELECT id, email, password_hash, role, created_at
      FROM voice_admins WHERE LOWER(email) = LOWER($1)`, [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role, createdAt: iso(row.created_at) } : null;
  }

  async function createAdminSession({ tokenHash, adminId, expiresAt }) {
    await pool.query(`INSERT INTO voice_sessions (token_hash, admin_id, expires_at, created_at, last_seen_at)
      VALUES ($1,$2,$3,NOW(),NOW())`, [tokenHash, adminId, expiresAt]);
  }

  async function findAdminSession(tokenHash) {
    await pool.query('DELETE FROM voice_sessions WHERE expires_at <= NOW()');
    const result = await pool.query(`UPDATE voice_sessions s SET last_seen_at = NOW()
      FROM voice_admins a WHERE s.admin_id = a.id AND s.token_hash = $1 AND s.expires_at > NOW()
      RETURNING s.token_hash, s.expires_at, a.id AS admin_id, a.email, a.role`, [tokenHash]);
    const row = result.rows[0];
    return row ? { tokenHash: row.token_hash, expiresAt: iso(row.expires_at), adminId: row.admin_id, email: row.email, role: row.role } : null;
  }

  async function deleteAdminSession(tokenHash) {
    const result = await pool.query('DELETE FROM voice_sessions WHERE token_hash = $1', [tokenHash]);
    return result.rowCount;
  }

  if (seedCalls.length) {
    for (const call of seedCalls) await upsertCall(call);
  }

  return {
    kind: 'postgres',
    close: () => pool.end(),
    health: async () => { await pool.query('SELECT 1'); return true; },
    listServices,
    configureEventTypes,
    slotIsFree,
    createHold,
    getHold,
    claimHold,
    releaseClaim,
    findBookingByIdempotency,
    confirmHold,
    listBookings,
    cancelBooking,
    upsertCall,
    listCalls,
    recordEvent,
    stats,
    expireHolds,
    adminCount,
    createFirstAdmin,
    findAdminByEmail,
    createAdminSession,
    findAdminSession,
    deleteAdminSession,
    pool
  };
}
