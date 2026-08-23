import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { assertValidConfig, loadConfig } from './src/config.mjs';
import { createAuthService } from './src/auth.mjs';
import { createVoiceService, verifyVapiWebhook } from './src/voice/service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, 'public');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function requestError(res, status, message, code = 'REQUEST_ERROR', headers = {}) {
  json(res, status, { error: { code, message } }, headers);
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error('Payload jest zbyt duży.');
      error.status = 413;
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function applySecurityHeaders(res, config) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if (config.production) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

export async function createApp(options = {}) {
  const config = options.config || loadConfig(options.env || {});
  assertValidConfig(config);
  const voiceDatabasePath = options.voiceDbPath || config.voice.databasePath;
  const voiceService = await createVoiceService({ config, state: { calls: [] }, databasePath: voiceDatabasePath });
  const authService = createAuthService({ database: voiceService.database, config });

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res, config);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = url.pathname;

      if (route === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          status: 'ok',
          service: 'voice-reception',
          version: '1.1.0',
          time: new Date().toISOString()
        });
      }
      if (route === '/api/ready' && req.method === 'GET') {
        try {
          await voiceService.ready();
          return json(res, 200, { status: 'ready', database: config.database.provider, time: new Date().toISOString() });
        } catch (error) {
          console.error('Readiness check failed', error);
          return json(res, 503, { status: 'not-ready', database: config.database.provider });
        }
      }
      if (route === '/api/auth/status' && req.method === 'GET') {
        return json(res, 200, await authService.status(req));
      }
      if (route === '/api/auth/setup' && req.method === 'POST') {
        authService.assertSafeMutation(req);
        const result = await authService.setup(req, await parseBody(req));
        return json(res, 201, { authenticated: true, user: result.user }, { 'set-cookie': result.setCookie });
      }
      if (route === '/api/auth/login' && req.method === 'POST') {
        authService.assertSafeMutation(req);
        const result = await authService.login(req, await parseBody(req));
        return json(res, 200, { authenticated: true, user: result.user }, { 'set-cookie': result.setCookie });
      }
      if (route === '/api/auth/logout' && req.method === 'POST') {
        authService.assertSafeMutation(req);
        const result = await authService.logout(req);
        return json(res, 200, { authenticated: false }, { 'set-cookie': result.setCookie });
      }
      if (route === '/api/auth/me' && req.method === 'GET') {
        return json(res, 200, { user: await authService.requireUser(req) });
      }
      if (route === '/api/voice' && req.method === 'GET') {
        await authService.requireUser(req);
        return json(res, 200, await voiceService.dashboard());
      }
      if (route === '/api/voice/config' && req.method === 'GET') {
        await authService.requireUser(req);
        return json(res, 200, voiceService.config());
      }
      if (route === '/api/voice/availability' && req.method === 'POST') {
        await authService.requireUser(req);
        authService.assertSafeMutation(req);
        return json(res, 200, await voiceService.availability(await parseBody(req)));
      }
      if (route === '/api/voice/holds' && req.method === 'POST') {
        await authService.requireUser(req);
        authService.assertSafeMutation(req);
        return json(res, 201, await voiceService.createHold(await parseBody(req)));
      }
      if (route === '/api/voice/bookings' && req.method === 'POST') {
        await authService.requireUser(req);
        authService.assertSafeMutation(req);
        const body = await parseBody(req);
        const result = await voiceService.confirmBooking({
          holdId: body.holdId,
          customerName: body.customerName,
          phone: body.phone,
          email: body.email,
          idempotencyKey: req.headers['idempotency-key']
        });
        return json(res, result.idempotentReplay ? 200 : 201, result);
      }
      const cancellation = route.match(/^\/api\/voice\/bookings\/([^/]+)\/cancel$/);
      if (cancellation && req.method === 'POST') {
        await authService.requireUser(req);
        authService.assertSafeMutation(req);
        const body = await parseBody(req);
        return json(res, 200, await voiceService.cancelBooking({ bookingId: cancellation[1], reason: body.reason }));
      }
      if (route === '/api/webhooks/vapi' && req.method === 'POST') {
        if (!verifyVapiWebhook(req.headers, config.voice.webhookSecret)) {
          return requestError(res, 401, 'Nieprawidłowe uwierzytelnienie webhooka.', 'WEBHOOK_UNAUTHORIZED');
        }
        return json(res, 200, await voiceService.handleVapiMessage(await parseBody(req)));
      }
      if (route.startsWith('/api/')) return requestError(res, 404, 'Nie znaleziono endpointu.', 'NOT_FOUND');

      if (!['GET', 'HEAD'].includes(req.method)) return requestError(res, 405, 'Metoda jest niedozwolona.', 'METHOD_NOT_ALLOWED');
      const requested = route === '/' ? '/index.html' : route;
      let filePath = resolve(publicDir, `.${requested}`);
      if (!filePath.startsWith(`${publicDir}\\`) && filePath !== join(publicDir, 'index.html')) {
        return requestError(res, 403, 'Niedozwolona ścieżka.', 'FORBIDDEN');
      }
      if (!existsSync(filePath)) filePath = join(publicDir, 'index.html');
      const extension = extname(filePath);
      res.writeHead(200, {
        'content-type': mimeTypes[extension] || 'application/octet-stream',
        'cache-control': 'no-cache'
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).pipe(res);
    } catch (caught) {
      const status = caught.status || (caught instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.error(caught);
      const headers = caught.retryAfter ? { 'retry-after': String(caught.retryAfter) } : {};
      const message = status >= 500 ? 'Wystąpił nieoczekiwany błąd serwera.' : (caught.message || 'Błąd żądania.');
      if (!res.headersSent) return requestError(res, status, message, caught.code || 'SERVER_ERROR', headers);
      res.end();
    }
  });

  let closePromise;
  function closeResources() {
    closePromise ||= Promise.resolve(voiceService.close());
    return closePromise;
  }
  server.on('close', () => { closeResources().catch((error) => console.error('Database shutdown failed', error)); });
  async function close() {
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
    await closeResources();
  }
  return { server, voiceDatabasePath, voiceService, authService, close, config };
}

async function start() {
  const config = loadConfig();
  const app = await createApp({ config });
  const { server, voiceDatabasePath } = app;
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  console.log(`Voice Reception działa: http://${config.host}:${config.port}`);
  console.log(`Voice DB: ${config.database.provider === 'postgres' ? 'PostgreSQL' : voiceDatabasePath}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Odebrano ${signal}. Zamykanie połączeń…`);
    const timeout = setTimeout(() => {
      console.error('Przekroczono czas łagodnego zamknięcia.');
      process.exitCode = 1;
    }, 10_000);
    timeout.unref();
    try {
      await app.close();
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch(console.error); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(console.error); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch((caught) => {
    console.error(caught);
    process.exitCode = 1;
  });
}
