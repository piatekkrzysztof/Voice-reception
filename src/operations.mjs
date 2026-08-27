import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SENSITIVE_KEY =
  /(authorization|cookie|password|secret|token|phone|email|caller|customer|name|summary|transcript)/i;
const KNOWN_ROUTES = new Set([
  '/api/health',
  '/api/ready',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/ops/metrics',
  '/api/ops/retention',
  '/api/voice',
  '/api/voice/config',
  '/api/voice/availability',
  '/api/voice/holds',
  '/api/voice/bookings',
  '/api/webhooks/vapi',
]);

function safeValue(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth > 4) return '[TRUNCATED]';
  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code || 'ERROR',
      status: value.status || 500,
    };
  }
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => safeValue(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        safeValue(childValue, childKey, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

export function createLogger({ output = console } = {}) {
  function write(level, event, detail = {}) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      ...safeValue(detail),
    });
    const method = level === 'error' ? 'error' : 'log';
    output[method](line);
  }

  return {
    info: (event, detail) => write('info', event, detail),
    warn: (event, detail) => write('warn', event, detail),
    error: (event, detail) => write('error', event, detail),
  };
}

function validRequestId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function routeLabel(route) {
  if (/^\/api\/voice\/bookings\/[^/]+\/cancel$/.test(route))
    return '/api/voice/bookings/:id/cancel';
  if (KNOWN_ROUTES.has(route)) return route;
  return route.startsWith('/api/') ? '/api/:unknown' : 'static';
}

export function createOperations({ config, logger, fetchImpl = fetch, now = () => Date.now() }) {
  const startedAt = now();
  const state = {
    requests: 0,
    errors: 0,
    rejected: 0,
    inflight: 0,
    protectedInflight: 0,
    byStatus: {},
    byRoute: {},
    lastRetention: null,
  };
  const lastAlertAt = new Map();
  const pendingAlerts = new Set();

  function beginRequest({ method, route, suppliedRequestId, protectedRoute = false }) {
    const requestId = validRequestId(suppliedRequestId) || crypto.randomUUID();
    if (protectedRoute && state.protectedInflight >= config.operations.maxInflight) {
      state.requests += 1;
      state.rejected += 1;
      state.byStatus[503] = (state.byStatus[503] || 0) + 1;
      return { accepted: false, requestId };
    }

    const label = `${method} ${routeLabel(route)}`;
    const started = performance.now();
    state.requests += 1;
    state.inflight += 1;
    if (protectedRoute) state.protectedInflight += 1;

    let finished = false;
    return {
      accepted: true,
      requestId,
      finish(status) {
        if (finished) return;
        finished = true;
        state.inflight -= 1;
        if (protectedRoute) state.protectedInflight -= 1;
        state.byStatus[status] = (state.byStatus[status] || 0) + 1;
        const current = state.byRoute[label] || { requests: 0, errors: 0, totalDurationMs: 0 };
        current.requests += 1;
        current.totalDurationMs += performance.now() - started;
        if (status >= 500) {
          current.errors += 1;
          state.errors += 1;
        }
        state.byRoute[label] = current;
      },
    };
  }

  function notify({ severity = 'error', code, component, requestId }) {
    const alerts = config.operations.alerts;
    if (!alerts.webhookUrl) return false;
    const timestamp = now();
    const previous = lastAlertAt.get(code) || 0;
    if (timestamp - previous < alerts.cooldownMinutes * 60_000) return false;
    lastAlertAt.set(code, timestamp);

    const task = fetchImpl(alerts.webhookUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(alerts.timeoutMs),
      headers: {
        'content-type': 'application/json',
        ...(alerts.bearerToken ? { authorization: `Bearer ${alerts.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        service: 'voice-reception',
        environment: config.nodeEnv,
        severity,
        code,
        component,
        requestId: requestId || null,
        time: new Date(timestamp).toISOString(),
      }),
    })
      .then((response) => {
        if (!response.ok)
          throw Object.assign(new Error('Alert endpoint rejected request'), {
            code: 'ALERT_REJECTED',
          });
      })
      .catch((error) => logger.error('alert.delivery_failed', { code, error }))
      .finally(() => pendingAlerts.delete(task));
    pendingAlerts.add(task);
    return true;
  }

  function snapshot(persistent = {}) {
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
      http: {
        requests: state.requests,
        errors: state.errors,
        rejected: state.rejected,
        inflight: state.inflight,
        protectedInflight: state.protectedInflight,
        maxInflight: config.operations.maxInflight,
        byStatus: { ...state.byStatus },
        byRoute: Object.fromEntries(
          Object.entries(state.byRoute).map(([route, value]) => [
            route,
            {
              requests: value.requests,
              errors: value.errors,
              averageDurationMs: Math.round(value.totalDurationMs / value.requests),
            },
          ]),
        ),
      },
      persistent,
      retention: state.lastRetention,
      alertsConfigured: Boolean(config.operations.alerts.webhookUrl),
    };
  }

  return {
    beginRequest,
    notify,
    snapshot,
    setRetentionResult(result) {
      state.lastRetention = result;
    },
    async close() {
      await Promise.allSettled([...pendingAlerts]);
    },
  };
}

export function percentile95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function redactForLog(value) {
  return safeValue(value);
}
