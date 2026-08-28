import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createVoiceDatabase } from './database-factory.mjs';
import { createCalendar } from './calendar.mjs';
import { publicVoiceConfig } from '../config.mjs';
import { percentile95 } from '../operations.mjs';

function error(message, code, status = 400) {
  const value = new Error(message);
  value.code = code;
  value.status = status;
  return value;
}

function b64(value) {
  return Buffer.from(value).toString('base64url');
}

function unb64(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signSlot(payload, secret) {
  const encoded = b64(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySlot(token, secret) {
  const [encoded, provided] = String(token || '').split('.');
  if (!encoded || !provided)
    throw error('Nieprawidłowy identyfikator terminu.', 'SLOT_TOKEN_INVALID', 400);
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  const actual = Buffer.from(provided, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected))
    throw error('Podpis terminu jest nieprawidłowy.', 'SLOT_TOKEN_INVALID', 400);
  const payload = JSON.parse(unb64(encoded));
  if (payload.exp < Date.now())
    throw error('Lista terminów wygasła. Sprawdź dostępność ponownie.', 'SLOT_TOKEN_EXPIRED', 409);
  return payload;
}

function timeLabel(iso, timeZone) {
  return new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(iso),
  );
}

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function normalizePhoneNumber(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (/^\d{9}$/.test(digits)) return `+48${digits}`;
  if (/^48\d{9}$/.test(digits)) return `+${digits}`;
  if (raw.startsWith('+') && /^\d{8,15}$/.test(digits)) return `+${digits}`;
  if (/^00\d{8,15}$/.test(digits)) return `+${digits.slice(2)}`;
  return null;
}

function toolArguments(toolCall) {
  const raw =
    toolCall.arguments ??
    toolCall.parameters ??
    toolCall.function?.arguments ??
    toolCall.function?.parameters ??
    {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw || {};
}

function toolName(toolCall) {
  return toolCall.name || toolCall.function?.name;
}

export function verifyVapiWebhook(headers, webhookSecret) {
  if (!webhookSecret) return true;
  const authorization = headers.authorization || headers.Authorization;
  const custom = headers['x-voice-webhook-secret'];
  const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : custom;
  if (!provided) return false;
  const expectedBuffer = Buffer.from(webhookSecret);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export async function createVoiceService({ config, state, databasePath, operations }) {
  const voice = config.voice;
  const tenantId = voice.business.tenantId;
  const db = await createVoiceDatabase({
    config,
    path: databasePath || voice.databasePath,
    tenantId,
    seedCalls: state.calls || [],
  });
  await db.configureEventTypes(voice.calcom.eventTypes, tenantId);
  const calendar = createCalendar(voice);
  const retention = config.operations.retention;

  function dateBefore(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  }

  async function runRetention() {
    if (!retention.enabled) return null;
    try {
      const result = await db.applyRetention({
        now: new Date().toISOString(),
        callsBefore: dateBefore(retention.callsDays),
        bookingsBefore: dateBefore(retention.bookingsDays),
        eventsBefore: dateBefore(retention.eventsDays),
        holdsBefore: dateBefore(retention.holdsDays),
      });
      operations?.setRetentionResult(result);
      return result;
    } catch (caught) {
      operations?.notify({ severity: 'error', code: 'RETENTION_FAILED', component: 'database' });
      throw caught;
    }
  }

  let retentionTimer = null;
  if (retention.enabled) {
    await runRetention();
    retentionTimer = setInterval(
      () => runRetention().catch(() => {}),
      retention.intervalMinutes * 60_000,
    );
    retentionTimer.unref();
  }

  async function serviceBy(value) {
    const normalized = String(value || '')
      .trim()
      .toLocaleLowerCase('pl-PL');
    const service = (await db.listServices(tenantId)).find(
      (item) =>
        item.id === value ||
        item.slug === normalized ||
        item.name.toLocaleLowerCase('pl-PL') === normalized,
    );
    if (!service) throw error(`Nie obsługujemy usługi „${value}”.`, 'SERVICE_NOT_FOUND', 404);
    return service;
  }

  async function availability({ service: serviceValue, preferredDate, timeRange = 'any' }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate || ''))
      throw error('Data musi mieć format YYYY-MM-DD.', 'DATE_INVALID');
    if (preferredDate < dateInTimeZone(new Date(), voice.timezone))
      throw error('Nie można rezerwować terminu w przeszłości.', 'DATE_IN_PAST', 422);
    const service = await serviceBy(serviceValue);
    const calendarSlots = await calendar.availability({ date: preferredDate, service });
    const free = await Promise.all(
      calendarSlots.map((slot) =>
        db.slotIsFree({ tenantId, serviceId: service.id, startAt: slot.start, endAt: slot.end }),
      ),
    );
    const slots = calendarSlots
      .filter((slot, index) => free[index])
      .filter((slot) => {
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            hourCycle: 'h23',
            timeZone: voice.timezone,
          }).format(new Date(slot.start)),
        );
        return timeRange === 'morning' ? hour < 13 : timeRange === 'afternoon' ? hour >= 13 : true;
      })
      .slice(0, 8)
      .map((slot) => ({
        id: signSlot(
          {
            tenantId,
            serviceId: service.id,
            startAt: slot.start,
            endAt: slot.end,
            exp: Date.now() + 15 * 60_000,
          },
          voice.slotSecret,
        ),
        service: service.name,
        start: slot.start,
        end: slot.end,
        date: preferredDate,
        time: timeLabel(slot.start, voice.timezone),
        duration: service.durationMinutes,
        provider: calendar.name,
      }));
    await db.recordEvent({
      tenantId,
      type: 'availability.checked',
      detail: {
        service: service.name,
        preferredDate,
        results: slots.length,
        provider: calendar.name,
      },
    });
    return {
      slots,
      checkedAt: new Date().toISOString(),
      provider: calendar.name,
      timezone: voice.timezone,
    };
  }

  async function createHold({ slotId }) {
    const slot = verifySlot(slotId, voice.slotSecret);
    if (slot.tenantId !== tenantId)
      throw error('Termin należy do innej organizacji.', 'TENANT_MISMATCH', 403);
    const service = await serviceBy(slot.serviceId);
    if (
      !(await db.slotIsFree({
        tenantId,
        serviceId: service.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
      }))
    )
      throw error('Termin nie jest już dostępny.', 'SLOT_UNAVAILABLE', 409);
    let providerReservationUid = null;
    try {
      providerReservationUid = await calendar.reserve({
        service,
        startAt: slot.startAt,
        endAt: slot.endAt,
      });
      const hold = await db.createHold({
        tenantId,
        serviceId: service.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        expiresAt: new Date(Date.now() + voice.holdMinutes * 60_000).toISOString(),
        providerReservationUid,
      });
      await db.recordEvent({
        tenantId,
        type: 'hold.created',
        detail: { holdId: hold.id, service: service.name, startAt: hold.startAt },
      });
      return {
        hold,
        slot: {
          service: service.name,
          start: hold.startAt,
          end: hold.endAt,
          date: hold.startAt.slice(0, 10),
          time: timeLabel(hold.startAt, voice.timezone),
          duration: service.durationMinutes,
        },
      };
    } catch (caught) {
      if (providerReservationUid)
        await calendar.releaseReservation(providerReservationUid).catch(() => {});
      throw caught;
    }
  }

  async function confirmBooking({ holdId, customerName, phone, email, idempotencyKey }) {
    if (!idempotencyKey) throw error('Brak Idempotency-Key.', 'IDEMPOTENCY_REQUIRED');
    const existing = await db.findBookingByIdempotency(idempotencyKey);
    if (existing) return { confirmed: true, booking: existing, idempotentReplay: true };
    if (!customerName?.trim()) throw error('Imię klienta jest wymagane.', 'CUSTOMER_NAME_REQUIRED');
    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone)
      throw error('Numer telefonu ma nieprawidłowy format.', 'PHONE_INVALID');
    const hold = await db.claimHold(holdId, tenantId);
    const service = await serviceBy(hold.serviceId);
    let providerBooking = null;
    try {
      if (hold.providerReservationUid)
        await calendar.releaseReservation(hold.providerReservationUid);
      providerBooking = await calendar.book({
        hold,
        service,
        customer: { name: customerName.trim(), phone: normalizedPhone, email },
      });
      const booking = await db.confirmHold({
        hold,
        customerName: customerName.trim(),
        phone: normalizedPhone,
        email,
        providerUid: providerBooking.uid,
        idempotencyKey,
      });
      await db.recordEvent({
        tenantId,
        type: 'booking.confirmed',
        detail: {
          bookingId: booking.id,
          providerUid: booking.providerUid,
          service: service.name,
          startAt: booking.startAt,
        },
      });
      return { confirmed: true, booking };
    } catch (caught) {
      await db.releaseClaim(hold.id);
      if (providerBooking?.uid)
        await calendar
          .cancel(providerBooking.uid, 'Kompensacja po błędzie lokalnej transakcji')
          .catch(() => {});
      await db.recordEvent({
        tenantId,
        type: 'booking.failed',
        detail: { holdId, code: caught.code || 'UNKNOWN' },
      });
      if ((caught.status || 500) >= 500)
        operations?.notify({
          severity: 'critical',
          code: caught.code || 'BOOKING_FAILED',
          component: 'booking',
        });
      throw caught;
    }
  }

  async function cancelBooking({ bookingId, reason }) {
    const booking = (await db.listBookings(tenantId, 200)).find(
      (item) => item.id === bookingId || item.providerUid === bookingId,
    );
    if (!booking) throw error('Nie znaleziono rezerwacji.', 'BOOKING_NOT_FOUND', 404);
    if (booking.status !== 'confirmed')
      throw error('Rezerwacja nie jest aktywna.', 'BOOKING_NOT_ACTIVE', 409);
    await calendar.cancel(booking.providerUid, reason);
    const cancelled = await db.cancelBooking(booking.id, tenantId);
    await db.recordEvent({
      tenantId,
      type: 'booking.cancelled',
      detail: { bookingId: booking.id, reason },
    });
    return { cancelled: true, booking: cancelled };
  }

  async function operationalMetrics(windowHours = 24) {
    const sinceAt = new Date(Date.now() - windowHours * 60 * 60 * 1_000).toISOString();
    const [events, recentCalls] = await Promise.all([
      db.listEvents(tenantId, sinceAt, 5_000),
      db.listCalls(tenantId, 2_000),
    ]);
    const toolEvents = events.filter((event) =>
      ['tool.succeeded', 'tool.failed'].includes(event.type),
    );
    const latencies = toolEvents
      .map((event) => Number(event.detail?.durationMs))
      .filter(Number.isFinite);
    const callsInWindow = recentCalls.filter((call) => call.startedAt >= sinceAt);
    const succeeded = toolEvents.filter((event) => event.type === 'tool.succeeded').length;
    return {
      windowHours,
      sinceAt,
      toolCalls: toolEvents.length,
      toolFailures: toolEvents.length - succeeded,
      toolSuccessPercent: toolEvents.length
        ? Math.round((succeeded / toolEvents.length) * 100)
        : 100,
      p95ToolLatencyMs: percentile95(latencies),
      bookingFailures: events.filter((event) => event.type === 'booking.failed').length,
      callsEnded: callsInWindow.filter((call) => call.endedAt).length,
      transfers: callsInWindow.filter((call) => call.transferred).length,
      cost: Number(callsInWindow.reduce((sum, call) => sum + Number(call.cost || 0), 0).toFixed(4)),
      eventLimitReached: events.length === 5_000,
    };
  }

  async function dashboard() {
    const [calls, bookings, totals, services, operational] = await Promise.all([
      db.listCalls(tenantId),
      db.listBookings(tenantId),
      db.stats(tenantId),
      db.listServices(tenantId),
      operationalMetrics(),
    ]);
    const integration = publicVoiceConfig(config);
    return {
      calls,
      bookings,
      services,
      integration,
      metrics: {
        calls: Number(totals.calls),
        bookings:
          Number(totals.bookings) || calls.filter((call) => call.outcome === 'BOOKED').length,
        transfers: Number(totals.transfers || 0),
        averageDurationSeconds: Math.round(Number(totals.averageDuration || 0)),
        totalCost: Number(totals.cost || 0),
        toolSuccess: operational.toolSuccessPercent,
        aiDisclosure: totals.calls
          ? Math.round((Number(totals.disclosed || 0) / Number(totals.calls)) * 100)
          : 100,
        p95Latency:
          operational.p95ToolLatencyMs == null ? null : operational.p95ToolLatencyMs / 1_000,
      },
    };
  }

  async function handleToolCall(toolCall, callId) {
    const name = toolName(toolCall);
    const args = toolArguments(toolCall);
    const idempotencyKey = `vapi:${callId || 'unknown'}:${toolCall.id}`;
    if (name === 'check_availability') return availability(args);
    if (name === 'create_booking_hold') return createHold(args);
    if (name === 'confirm_booking')
      return confirmBooking({
        holdId: args.holdId,
        customerName: args.customerName,
        phone: args.phone,
        email: args.email,
        idempotencyKey,
      });
    if (name === 'cancel_booking') return cancelBooking(args);
    throw error(`Nieobsługiwane narzędzie: ${name}`, 'TOOL_NOT_SUPPORTED', 400);
  }

  async function handleVapiMessage(payload) {
    const message = payload?.message || payload;
    if (!message?.type) throw error('Brak typu wiadomości Vapi.', 'VAPI_MESSAGE_INVALID');
    const callId = message.call?.id || null;

    if (message.type === 'tool-calls') {
      const calls =
        message.toolCallList || message.toolWithToolCallList?.map((item) => item.toolCall) || [];
      const results = [];
      for (const toolCall of calls) {
        const name = toolName(toolCall);
        const started = performance.now();
        try {
          const result = await handleToolCall(toolCall, callId);
          results.push({
            name,
            toolCallId: toolCall.id,
            result: JSON.stringify({ success: true, ...result }),
          });
          await db.recordEvent({
            tenantId,
            callId,
            type: 'tool.succeeded',
            detail: {
              name,
              toolCallId: toolCall.id,
              durationMs: Math.round(performance.now() - started),
            },
          });
        } catch (caught) {
          results.push({
            name,
            toolCallId: toolCall.id,
            result: JSON.stringify({
              success: false,
              code: caught.code || 'TOOL_ERROR',
              message: caught.message,
            }),
          });
          await db.recordEvent({
            tenantId,
            callId,
            type: 'tool.failed',
            detail: {
              name,
              toolCallId: toolCall.id,
              code: caught.code || 'TOOL_ERROR',
              durationMs: Math.round(performance.now() - started),
            },
          });
          if ((caught.status || 500) >= 500)
            operations?.notify({
              severity: 'error',
              code: caught.code || 'TOOL_ERROR',
              component: `tool.${name}`,
            });
        }
      }
      return { results };
    }

    if (message.type === 'status-update') {
      const call = message.call || {};
      await db.upsertCall({
        externalId: call.id,
        tenantId,
        provider: 'vapi',
        startedAt: call.startedAt || new Date().toISOString(),
        caller: call.customer?.number || call.phoneNumber?.number,
        outcome: call.status === 'ended' ? 'UNRESOLVED' : 'IN_PROGRESS',
        endedReason: call.endedReason,
      });
      return {};
    }

    if (message.type === 'end-of-call-report') {
      const call = message.call || {};
      const analysis = message.analysis || call.analysis || {};
      const structured = analysis.structuredData || {};
      const startedAt = call.startedAt || message.startedAt || new Date().toISOString();
      const endedAt = call.endedAt || message.endedAt || new Date().toISOString();
      const durationSeconds =
        message.durationSeconds ||
        Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
      await db.upsertCall({
        externalId: call.id,
        tenantId,
        provider: 'vapi',
        startedAt,
        endedAt,
        durationSeconds,
        caller: call.customer?.number || call.phoneNumber?.number,
        intent: structured.intent || analysis.intent,
        outcome:
          structured.outcome ||
          (call.endedReason?.includes('transfer') ? 'TRANSFERRED' : 'UNRESOLVED'),
        bookingId: structured.bookingId,
        transferred: structured.outcome === 'TRANSFERRED' || call.endedReason?.includes('transfer'),
        cost: call.cost || message.cost || 0,
        aiDisclosure: structured.aiDisclosure !== false,
        summary: analysis.summary || structured.summary,
        endedReason: call.endedReason,
      });
      await db.recordEvent({
        tenantId,
        callId: call.id,
        type: 'call.ended',
        detail: { outcome: structured.outcome || 'UNRESOLVED', endedReason: call.endedReason },
      });
      return {};
    }

    await db.recordEvent({
      tenantId,
      callId,
      type: `vapi.${message.type}`,
      detail: { received: true },
    });
    return {};
  }

  return {
    dashboard,
    availability,
    createHold,
    confirmBooking,
    cancelBooking,
    handleVapiMessage,
    operationalMetrics,
    runRetention,
    config: () => publicVoiceConfig(config),
    close: async () => {
      if (retentionTimer) clearInterval(retentionTimer);
      await db.close();
    },
    ready: () => db.health(),
    database: db,
  };
}
