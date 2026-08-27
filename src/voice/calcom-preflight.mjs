const EVENT_TYPES_VERSION = '2024-06-14';
const SLOTS_VERSION = '2024-09-04';

const SERVICE_REQUIREMENTS = [
  { key: 'coloring', name: 'Koloryzacja', durationMinutes: 120 },
  { key: 'haircut', name: 'Strzyżenie', durationMinutes: 60 },
  { key: 'consultation', name: 'Konsultacja', durationMinutes: 30 },
];

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
}

function configurationIssues(calcom) {
  const issues = [];
  if (!calcom.apiKey) issues.push('Uzupełnij CALCOM_API_KEY.');
  if (!/^https:\/\//.test(calcom.apiUrl || '')) issues.push('CALCOM_API_URL musi używać HTTPS.');
  if (!validEmail(calcom.defaultAttendeeEmail))
    issues.push('Uzupełnij prawidłowy CALCOM_DEFAULT_ATTENDEE_EMAIL.');
  if (!calcom.reserveSlots) issues.push('Ustaw CALCOM_RESERVE_SLOTS=true.');

  const ids = SERVICE_REQUIREMENTS.map((service) => calcom.eventTypes?.[service.key]);
  for (const [index, id] of ids.entries()) {
    if (!Number.isInteger(id) || id < 1)
      issues.push(`Uzupełnij ID Cal.com dla usługi ${SERVICE_REQUIREMENTS[index].name}.`);
  }
  const configuredIds = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (new Set(configuredIds).size !== configuredIds.length)
    issues.push('Każda usługa musi wskazywać inny typ wydarzenia Cal.com.');
  return issues;
}

function preflightError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function responsePayload(response) {
  return response.json().catch(() => ({}));
}

export async function checkCalcomConfiguration({
  calcom,
  timezone = 'Europe/Warsaw',
  fetchImpl = globalThis.fetch,
  now = new Date(),
  windowDays = 14,
}) {
  const issues = configurationIssues(calcom);
  const connectionBlocked = !calcom.apiKey || !/^https:\/\//.test(calcom.apiUrl || '');
  if (connectionBlocked) return { ready: false, issues, eventTypes: [], services: [] };

  async function request(path, version) {
    let response;
    try {
      response = await fetchImpl(`${calcom.apiUrl}${path}`, {
        signal: AbortSignal.timeout(calcom.timeoutMs || 8_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${calcom.apiKey}`,
          'cal-api-version': version,
        },
      });
    } catch (cause) {
      const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
      throw preflightError(
        timedOut
          ? 'Cal.com nie odpowiedział w dozwolonym czasie.'
          : 'Nie udało się połączyć z Cal.com.',
        timedOut ? 'CALCOM_TIMEOUT' : 'CALCOM_UNAVAILABLE',
        503,
      );
    }
    const payload = await responsePayload(response);
    if (!response.ok || payload.status === 'error') {
      const code =
        response.status === 401 || response.status === 403
          ? 'CALCOM_AUTH_FAILED'
          : response.status === 429
            ? 'CALCOM_RATE_LIMITED'
            : 'CALCOM_PREFLIGHT_FAILED';
      throw preflightError(
        response.status === 401 || response.status === 403
          ? 'Cal.com odrzucił klucz API.'
          : 'Cal.com odrzucił kontrolę konfiguracji.',
        code,
        response.status,
      );
    }
    return payload.data ?? payload;
  }

  const eventTypes = await request('/v2/event-types', EVENT_TYPES_VERSION);
  if (!Array.isArray(eventTypes))
    throw preflightError(
      'Cal.com zwrócił nieoczekiwany format listy typów wydarzeń.',
      'CALCOM_RESPONSE_INVALID',
      502,
    );

  const availableEventTypes = eventTypes.map((eventType) => ({
    id: Number(eventType.id),
    title: eventType.title || '',
    slug: eventType.slug || '',
    durationMinutes: Number(eventType.lengthInMinutes),
  }));
  const byId = new Map(eventTypes.map((eventType) => [Number(eventType.id), eventType]));
  const start = dateOnly(addDays(now, 1));
  const end = dateOnly(addDays(now, windowDays + 1));
  const services = await Promise.all(
    SERVICE_REQUIREMENTS.map(async (required) => {
      const id = calcom.eventTypes[required.key];
      const eventType = byId.get(id);
      if (!eventType)
        return {
          service: required.name,
          eventTypeId: id,
          found: false,
          durationMinutes: null,
          expectedDurationMinutes: required.durationMinutes,
          durationMatches: false,
          availableSlots: 0,
        };

      const params = new URLSearchParams({
        eventTypeId: String(id),
        start,
        end,
        timeZone: timezone,
        format: 'range',
      });
      const slots = await request(`/v2/slots?${params}`, SLOTS_VERSION);
      const availableSlots = Object.values(slots || {}).reduce(
        (total, daySlots) => total + (Array.isArray(daySlots) ? daySlots.length : 0),
        0,
      );
      return {
        service: required.name,
        eventTypeId: id,
        title: eventType.title || '',
        found: true,
        durationMinutes: Number(eventType.lengthInMinutes),
        expectedDurationMinutes: required.durationMinutes,
        durationMatches: Number(eventType.lengthInMinutes) === required.durationMinutes,
        availableSlots,
      };
    }),
  );

  for (const service of services) {
    if (Number.isInteger(service.eventTypeId) && service.eventTypeId > 0 && !service.found)
      issues.push(`${service.service}: skonfigurowane ID nie należy do tego konta Cal.com.`);
    else if (service.found && !service.durationMatches)
      issues.push(
        `${service.service}: czas w Cal.com (${service.durationMinutes} min) powinien wynosić ${service.expectedDurationMinutes} min.`,
      );
    if (service.found && service.availableSlots === 0)
      issues.push(`${service.service}: brak wolnych terminów w kolejnych ${windowDays} dniach.`);
  }

  return {
    ready: issues.length === 0,
    checkedAt: new Date().toISOString(),
    window: { start, end, timezone },
    issues,
    eventTypes: availableEventTypes,
    services,
  };
}
