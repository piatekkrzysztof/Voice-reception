import crypto from 'node:crypto';

function voiceError(message, code, status = 502, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.status = status;
  return error;
}

function nextDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function timeZoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - date.getTime();
}

export function zonedTimeToUtc(date, minutesFromMidnight, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const hours = Math.floor(minutesFromMidnight / 60);
  const minutes = minutesFromMidnight % 60;
  const wallClockUtc = Date.UTC(year, month - 1, day, hours, minutes, 0);
  let candidate = new Date(wallClockUtc);
  let offset = timeZoneOffset(candidate, timeZone);
  candidate = new Date(wallClockUtc - offset);
  const correctedOffset = timeZoneOffset(candidate, timeZone);
  if (correctedOffset !== offset) candidate = new Date(wallClockUtc - correctedOffset);
  return candidate.toISOString();
}

function localSlots({ date, durationMinutes, timeZone }) {
  const slots = [];
  const openingMinute = 9 * 60;
  const closingMinute = 18 * 60;
  for (let minute = openingMinute; minute + durationMinutes <= closingMinute; minute += 30) {
    const start = zonedTimeToUtc(date, minute, timeZone);
    const end = new Date(new Date(start).getTime() + durationMinutes * 60_000).toISOString();
    slots.push({ start, end });
  }
  return slots;
}

function createLocalCalendar(config) {
  return {
    name: 'local',
    live: false,
    async availability({ date, service }) {
      return localSlots({ date, durationMinutes: service.durationMinutes, timeZone: config.timezone });
    },
    async reserve() { return null; },
    async releaseReservation() {},
    async book({ hold }) { return { uid: `local-${crypto.randomUUID()}`, start: hold.startAt, end: hold.endAt }; },
    async cancel() { return { cancelled: true }; }
  };
}

function createCalComCalendar(config) {
  const cal = config.calcom;

  async function request(path, { method = 'GET', version = '2026-02-25', body, authenticated = true } = {}) {
    if (!cal.apiKey && authenticated) throw voiceError('Brak CALCOM_API_KEY.', 'CALCOM_NOT_CONFIGURED', 503);
    const response = await fetch(`${cal.apiUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'cal-api-version': version,
        ...(authenticated && cal.apiKey ? { authorization: `Bearer ${cal.apiKey}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status === 'error') {
      const detail = payload.error?.message || payload.message || `HTTP ${response.status}`;
      throw voiceError(`Cal.com odrzucił operację: ${detail}`, response.status === 409 ? 'CALENDAR_CONFLICT' : 'CALCOM_ERROR', response.status, payload);
    }
    return payload.data ?? payload;
  }

  return {
    name: 'calcom',
    live: true,
    async availability({ date, service }) {
      if (!service.externalEventTypeId) throw voiceError(`Usługa „${service.name}” nie ma CALCOM_EVENT_TYPE_ID.`, 'CALCOM_EVENT_TYPE_MISSING', 503);
      const params = new URLSearchParams({
        eventTypeId: String(service.externalEventTypeId),
        start: date,
        end: nextDate(date),
        timeZone: config.timezone,
        format: 'range'
      });
      const data = await request(`/v2/slots?${params}`, { version: '2024-09-04' });
      const values = Object.values(data || {}).flat();
      return values.map((slot) => {
        const start = typeof slot === 'string' ? slot : slot.start;
        const end = typeof slot === 'string'
          ? new Date(new Date(start).getTime() + service.durationMinutes * 60_000).toISOString()
          : slot.end || new Date(new Date(start).getTime() + service.durationMinutes * 60_000).toISOString();
        return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
      });
    },
    async reserve({ service, startAt }) {
      if (!cal.reserveSlots) return null;
      const data = await request('/v2/slots/reservations', {
        method: 'POST',
        version: '2024-09-04',
        body: {
          eventTypeId: service.externalEventTypeId,
          slotStart: startAt,
          slotDuration: service.durationMinutes,
          reservationDuration: config.holdMinutes
        }
      });
      return data.reservationUid || null;
    },
    async releaseReservation(uid) {
      if (!uid) return;
      await request(`/v2/slots/reservations/${encodeURIComponent(uid)}`, { method: 'DELETE', version: '2024-09-04' });
    },
    async book({ hold, service, customer }) {
      const email = customer.email || cal.defaultAttendeeEmail;
      if (!email) throw voiceError('Cal.com wymaga e-maila uczestnika albo CALCOM_DEFAULT_ATTENDEE_EMAIL.', 'ATTENDEE_EMAIL_REQUIRED', 422);
      const data = await request('/v2/bookings', {
        method: 'POST',
        body: {
          start: hold.startAt,
          eventTypeId: service.externalEventTypeId,
          attendee: {
            name: customer.name,
            email,
            phoneNumber: customer.phone,
            timeZone: config.timezone,
            language: 'pl'
          },
          metadata: { source: 'voice-reception', holdId: hold.id, customerPhone: customer.phone }
        }
      });
      return { uid: data.uid, start: data.start, end: data.end, raw: data };
    },
    async cancel(providerUid, reason = 'Odwołano przez recepcję AI') {
      if (!providerUid) return { cancelled: true };
      await request(`/v2/bookings/${encodeURIComponent(providerUid)}/cancel`, {
        method: 'POST',
        body: { cancellationReason: reason }
      });
      return { cancelled: true };
    }
  };
}

export function createCalendar(config) {
  if (config.calendarProvider === 'calcom') return createCalComCalendar(config);
  return createLocalCalendar(config);
}
