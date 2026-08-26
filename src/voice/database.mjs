import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

export function createVoiceDatabase({ path, tenantId, seedCalls = [] }) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_services (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      external_event_type_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (tenant_id, slug)
    );

    CREATE TABLE IF NOT EXISTS voice_holds (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      service_id TEXT NOT NULL REFERENCES voice_services(id),
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','confirming','confirmed','expired','released')),
      provider_reservation_uid TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_bookings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      service_id TEXT NOT NULL REFERENCES voice_services(id),
      hold_id TEXT REFERENCES voice_holds(id),
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      status TEXT NOT NULL CHECK (status IN ('confirmed','cancelled','rescheduled','failed')),
      provider_uid TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS voice_booking_slot_unique
      ON voice_bookings(tenant_id, service_id, start_at)
      WHERE status = 'confirmed';

    CREATE INDEX IF NOT EXISTS voice_holds_lookup
      ON voice_holds(tenant_id, service_id, start_at, status, expires_at);

    CREATE TABLE IF NOT EXISTS voice_calls (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      tenant_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      caller TEXT,
      intent TEXT,
      outcome TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      booking_id TEXT,
      transferred INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      ai_disclosure INTEGER NOT NULL DEFAULT 1,
      summary TEXT,
      ended_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      call_id TEXT,
      type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_admins (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES voice_admins(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS voice_sessions_expiry
      ON voice_sessions(expires_at);
  `);

  const serviceRows = [
    ['svc-coloring', 'coloring', 'Koloryzacja', 120],
    ['svc-haircut', 'haircut', 'Strzyżenie', 60],
    ['svc-consultation', 'consultation', 'Konsultacja', 30],
  ];
  const insertService = db.prepare(`INSERT OR IGNORE INTO voice_services
    (id, tenant_id, slug, name, duration_minutes) VALUES (?, ?, ?, ?, ?)`);
  for (const row of serviceRows) insertService.run(row[0], tenantId, row[1], row[2], row[3]);

  const callCount = db
    .prepare('SELECT COUNT(*) AS count FROM voice_calls WHERE tenant_id = ?')
    .get(tenantId).count;
  if (callCount === 0 && seedCalls.length) {
    const insertCall = db.prepare(`INSERT OR IGNORE INTO voice_calls
      (id, external_id, tenant_id, provider, started_at, ended_at, duration_seconds, caller, intent, outcome, booking_id, transferred, cost, ai_disclosure, summary, ended_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const call of seedCalls) {
      const endedAt = new Date(
        new Date(call.startedAt).getTime() + call.durationSeconds * 1000,
      ).toISOString();
      insertCall.run(
        call.id,
        call.id,
        tenantId,
        'seed',
        call.startedAt,
        endedAt,
        call.durationSeconds,
        call.caller,
        call.intent,
        call.outcome,
        call.booking || null,
        call.transferred ? 1 : 0,
        call.cost || 0,
        call.aiDisclosure === false ? 0 : 1,
        call.booking || null,
        'seeded-demo-call',
        call.startedAt,
        endedAt,
      );
    }
  }

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function expireHolds(now = new Date().toISOString()) {
    return db
      .prepare(
        `UPDATE voice_holds SET status = 'expired'
      WHERE status IN ('active','confirming') AND expires_at <= ?`,
      )
      .run(now).changes;
  }

  function listServices(currentTenant = tenantId) {
    return db
      .prepare(
        `SELECT id, slug, name, duration_minutes AS durationMinutes,
      external_event_type_id AS externalEventTypeId, active
      FROM voice_services WHERE tenant_id = ? AND active = 1 ORDER BY duration_minutes`,
      )
      .all(currentTenant)
      .map((row) => ({ ...row, active: Boolean(row.active) }));
  }

  function configureEventTypes(eventTypes, currentTenant = tenantId) {
    const update = db.prepare(
      'UPDATE voice_services SET external_event_type_id = ? WHERE tenant_id = ? AND slug = ?',
    );
    for (const [slug, eventTypeId] of Object.entries(eventTypes || {})) {
      if (eventTypeId) update.run(eventTypeId, currentTenant, slug);
    }
  }

  function slotIsFree({ tenantId: currentTenant = tenantId, serviceId, startAt, endAt }) {
    expireHolds();
    const booking = db
      .prepare(
        `SELECT id FROM voice_bookings
      WHERE tenant_id = ? AND service_id = ? AND status = 'confirmed'
      AND start_at < ? AND end_at > ? LIMIT 1`,
      )
      .get(currentTenant, serviceId, endAt, startAt);
    if (booking) return false;
    const hold = db
      .prepare(
        `SELECT id FROM voice_holds
      WHERE tenant_id = ? AND service_id = ? AND status IN ('active','confirming') AND expires_at > ?
      AND start_at < ? AND end_at > ? LIMIT 1`,
      )
      .get(currentTenant, serviceId, new Date().toISOString(), endAt, startAt);
    return !hold;
  }

  function createHold({
    tenantId: currentTenant = tenantId,
    serviceId,
    startAt,
    endAt,
    expiresAt,
    providerReservationUid = null,
  }) {
    return transaction(() => {
      expireHolds();
      if (!slotIsFree({ tenantId: currentTenant, serviceId, startAt, endAt })) {
        const error = new Error('Termin nie jest już dostępny.');
        error.code = 'SLOT_UNAVAILABLE';
        throw error;
      }
      const hold = {
        id: id('HOLD'),
        tenantId: currentTenant,
        serviceId,
        startAt,
        endAt,
        status: 'active',
        providerReservationUid,
        expiresAt,
        createdAt: new Date().toISOString(),
      };
      db.prepare(
        `INSERT INTO voice_holds
        (id, tenant_id, service_id, start_at, end_at, status, provider_reservation_uid, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hold.id,
        hold.tenantId,
        hold.serviceId,
        hold.startAt,
        hold.endAt,
        hold.status,
        hold.providerReservationUid,
        hold.expiresAt,
        hold.createdAt,
      );
      return hold;
    });
  }

  function getHold(holdId, currentTenant = tenantId) {
    expireHolds();
    const row = db
      .prepare(
        `SELECT id, tenant_id AS tenantId, service_id AS serviceId, start_at AS startAt,
      end_at AS endAt, status, provider_reservation_uid AS providerReservationUid,
      expires_at AS expiresAt, created_at AS createdAt FROM voice_holds WHERE id = ? AND tenant_id = ?`,
      )
      .get(holdId, currentTenant);
    return row || null;
  }

  function claimHold(holdId, currentTenant = tenantId) {
    return transaction(() => {
      expireHolds();
      const hold = getHold(holdId, currentTenant);
      if (!hold || hold.status !== 'active') {
        const error = new Error('Rezerwacja tymczasowa wygasła lub została wykorzystana.');
        error.code = 'HOLD_INVALID';
        throw error;
      }
      db.prepare(
        `UPDATE voice_holds SET status = 'confirming' WHERE id = ? AND status = 'active'`,
      ).run(holdId);
      return { ...hold, status: 'confirming' };
    });
  }

  function releaseClaim(holdId) {
    db.prepare(
      `UPDATE voice_holds SET status = CASE WHEN expires_at > ? THEN 'active' ELSE 'expired' END
      WHERE id = ? AND status = 'confirming'`,
    ).run(new Date().toISOString(), holdId);
  }

  function findBookingByIdempotency(idempotencyKey) {
    const row = db
      .prepare(
        `SELECT b.*, s.name AS service_name, s.duration_minutes
      FROM voice_bookings b JOIN voice_services s ON s.id = b.service_id
      WHERE b.idempotency_key = ?`,
      )
      .get(idempotencyKey);
    return row ? mapBooking(row) : null;
  }

  function mapBooking(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      holdId: row.hold_id,
      serviceId: row.service_id,
      service: row.service_name,
      startAt: row.start_at,
      endAt: row.end_at,
      customer: row.customer_name,
      phone: row.phone,
      email: row.email,
      status: row.status,
      providerUid: row.provider_uid,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      slot: {
        service: row.service_name,
        start: row.start_at,
        end: row.end_at,
        date: row.start_at.slice(0, 10),
        time: new Intl.DateTimeFormat('pl-PL', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/Warsaw',
        }).format(new Date(row.start_at)),
        duration: row.duration_minutes,
      },
    };
  }

  function confirmHold({ hold, customerName, phone, email, providerUid, idempotencyKey }) {
    return transaction(() => {
      const existing = findBookingByIdempotency(idempotencyKey);
      if (existing) return existing;
      const current = getHold(hold.id, hold.tenantId);
      if (!current || current.status !== 'confirming') {
        const error = new Error('Nie można potwierdzić tej blokady terminu.');
        error.code = 'HOLD_INVALID';
        throw error;
      }
      const now = new Date().toISOString();
      const bookingId = id('BOOK');
      try {
        db.prepare(
          `INSERT INTO voice_bookings
          (id, tenant_id, service_id, hold_id, start_at, end_at, customer_name, phone, email, status, provider_uid, idempotency_key, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
        ).run(
          bookingId,
          hold.tenantId,
          hold.serviceId,
          hold.id,
          hold.startAt,
          hold.endAt,
          customerName,
          phone,
          email || null,
          providerUid || null,
          idempotencyKey,
          now,
          now,
        );
      } catch (cause) {
        const error = new Error('Termin został zajęty w trakcie potwierdzania.');
        error.code = 'BOOKING_CONFLICT';
        error.cause = cause;
        throw error;
      }
      db.prepare(`UPDATE voice_holds SET status = 'confirmed' WHERE id = ?`).run(hold.id);
      return findBookingByIdempotency(idempotencyKey);
    });
  }

  function listBookings(currentTenant = tenantId, limit = 50) {
    return db
      .prepare(
        `SELECT b.*, s.name AS service_name, s.duration_minutes
      FROM voice_bookings b JOIN voice_services s ON s.id = b.service_id
      WHERE b.tenant_id = ? ORDER BY b.start_at DESC LIMIT ?`,
      )
      .all(currentTenant, limit)
      .map(mapBooking);
  }

  function cancelBooking(bookingId, currentTenant = tenantId) {
    const booking = db
      .prepare(
        `SELECT b.*, s.name AS service_name, s.duration_minutes FROM voice_bookings b
      JOIN voice_services s ON s.id = b.service_id WHERE b.id = ? AND b.tenant_id = ?`,
      )
      .get(bookingId, currentTenant);
    if (!booking) return null;
    db.prepare(`UPDATE voice_bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      bookingId,
    );
    return mapBooking({ ...booking, status: 'cancelled' });
  }

  function upsertCall(call) {
    const now = new Date().toISOString();
    const existing = call.externalId
      ? db.prepare('SELECT id FROM voice_calls WHERE external_id = ?').get(call.externalId)
      : null;
    const callId = existing?.id || call.id || id('CALL');
    db.prepare(
      `INSERT INTO voice_calls
      (id, external_id, tenant_id, provider, started_at, ended_at, duration_seconds, caller, intent, outcome, booking_id, transferred, cost, ai_disclosure, summary, ended_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        ended_at = excluded.ended_at, duration_seconds = excluded.duration_seconds, caller = COALESCE(excluded.caller, voice_calls.caller),
        intent = COALESCE(excluded.intent, voice_calls.intent), outcome = excluded.outcome, booking_id = COALESCE(excluded.booking_id, voice_calls.booking_id),
        transferred = excluded.transferred, cost = excluded.cost, ai_disclosure = excluded.ai_disclosure,
        summary = COALESCE(excluded.summary, voice_calls.summary), ended_reason = COALESCE(excluded.ended_reason, voice_calls.ended_reason), updated_at = excluded.updated_at`,
    ).run(
      callId,
      call.externalId || callId,
      call.tenantId || tenantId,
      call.provider || 'vapi',
      call.startedAt || now,
      call.endedAt || null,
      call.durationSeconds || 0,
      call.caller || null,
      call.intent || null,
      call.outcome || 'IN_PROGRESS',
      call.bookingId || null,
      call.transferred ? 1 : 0,
      call.cost || 0,
      call.aiDisclosure === false ? 0 : 1,
      call.summary || null,
      call.endedReason || null,
      now,
      now,
    );
    return callId;
  }

  function listCalls(currentTenant = tenantId, limit = 50) {
    return db
      .prepare(
        `SELECT id, external_id AS externalId, tenant_id AS tenantId, provider,
      started_at AS startedAt, ended_at AS endedAt, duration_seconds AS durationSeconds,
      caller, intent, outcome, booking_id AS bookingId, transferred, cost,
      ai_disclosure AS aiDisclosure, summary, ended_reason AS endedReason
      FROM voice_calls WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(currentTenant, limit)
      .map((row) => ({
        ...row,
        transferred: Boolean(row.transferred),
        aiDisclosure: Boolean(row.aiDisclosure),
        booking: row.summary || row.bookingId || null,
      }));
  }

  function recordEvent({ tenantId: currentTenant = tenantId, callId = null, type, detail = null }) {
    const event = {
      id: id('VEVT'),
      tenantId: currentTenant,
      callId,
      type,
      detail,
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO voice_events (id, tenant_id, call_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.tenantId,
      event.callId,
      event.type,
      typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
      event.createdAt,
    );
    return event;
  }

  function stats(currentTenant = tenantId) {
    const calls = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost),0) AS cost,
      COALESCE(AVG(duration_seconds),0) AS averageDuration,
      SUM(CASE WHEN transferred = 1 THEN 1 ELSE 0 END) AS transfers,
      SUM(CASE WHEN ai_disclosure = 1 THEN 1 ELSE 0 END) AS disclosed
      FROM voice_calls WHERE tenant_id = ?`,
      )
      .get(currentTenant);
    const bookings = db
      .prepare(
        `SELECT COUNT(*) AS bookings FROM voice_bookings WHERE tenant_id = ? AND status = 'confirmed'`,
      )
      .get(currentTenant).bookings;
    return { ...calls, bookings };
  }

  function adminCount() {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM voice_admins').get().count);
  }

  function createFirstAdmin({ email, passwordHash }) {
    return transaction(() => {
      if (adminCount() > 0) {
        const error = new Error('Konfiguracja właściciela została już zakończona.');
        error.status = 409;
        error.code = 'AUTH_SETUP_COMPLETE';
        throw error;
      }
      const now = new Date().toISOString();
      const admin = { id: id('ADMIN'), email, role: 'owner', createdAt: now };
      db.prepare(
        `INSERT INTO voice_admins (id, email, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(admin.id, admin.email, passwordHash, admin.role, now, now);
      return admin;
    });
  }

  function findAdminByEmail(email) {
    return (
      db
        .prepare(
          `SELECT id, email, password_hash AS passwordHash, role,
      created_at AS createdAt FROM voice_admins WHERE email = ? COLLATE NOCASE`,
        )
        .get(email) || null
    );
  }

  function createAdminSession({ tokenHash, adminId, expiresAt }) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO voice_sessions (token_hash, admin_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)`,
    ).run(tokenHash, adminId, expiresAt, now, now);
  }

  function findAdminSession(tokenHash) {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM voice_sessions WHERE expires_at <= ?').run(now);
    const session = db
      .prepare(
        `SELECT s.token_hash AS tokenHash, s.expires_at AS expiresAt,
      a.id AS adminId, a.email, a.role
      FROM voice_sessions s JOIN voice_admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now);
    if (!session) return null;
    db.prepare('UPDATE voice_sessions SET last_seen_at = ? WHERE token_hash = ?').run(
      now,
      tokenHash,
    );
    return session;
  }

  function deleteAdminSession(tokenHash) {
    return db.prepare('DELETE FROM voice_sessions WHERE token_hash = ?').run(tokenHash).changes;
  }

  return {
    kind: 'sqlite',
    close: () => db.close(),
    health: () => Boolean(db.prepare('SELECT 1 AS ok').get().ok),
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
    raw: db,
  };
}
