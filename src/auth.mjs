import crypto from 'node:crypto';

const KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const MAX_PASSWORD_LENGTH = 256;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authError(message, status, code, retryAfter = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (retryAfter) error.retryAfter = retryAfter;
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePassword(value) {
  return String(value || '').normalize('NFKC');
}

function validateCredentials({ email, password }) {
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw authError('Podaj prawidłowy adres e-mail.', 400, 'AUTH_EMAIL_INVALID');
  }
  if (password.length < 12) {
    throw authError('Hasło musi mieć co najmniej 12 znaków.', 400, 'AUTH_PASSWORD_TOO_SHORT');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw authError('Hasło jest zbyt długie.', 400, 'AUTH_PASSWORD_TOO_LONG');
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashPassword(value) {
  const password = normalizePassword(value);
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024
  }).toString('base64url');
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt}$${derived}`;
}

export function verifyPassword(value, encoded) {
  const [algorithm, cost, blockSize, parallelization, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  try {
    const derived = crypto.scryptSync(normalizePassword(value), salt, KEY_LENGTH, {
      N: Number(cost),
      r: Number(blockSize),
      p: Number(parallelization),
      maxmem: 64 * 1024 * 1024
    }).toString('base64url');
    return safeEqual(derived, expected);
  } catch {
    return false;
  }
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((cookies, pair) => {
    const separator = pair.indexOf('=');
    if (separator < 1) return cookies;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function isLoopback(address = '') {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function publicUser(session) {
  return session ? { id: session.adminId || session.id, email: session.email, role: session.role } : null;
}

export function createAuthService({ database, config }) {
  const cookieName = config.auth.cookieName;
  const sessionMilliseconds = config.auth.sessionHours * 60 * 60 * 1000;
  const attempts = new Map();
  const dummyPasswordHash = hashPassword(crypto.randomBytes(18).toString('base64url'));

  function cookie(value, { clear = false } = {}) {
    const attributes = [
      `${cookieName}=${clear ? '' : encodeURIComponent(value)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Strict',
      `Max-Age=${clear ? 0 : Math.floor(sessionMilliseconds / 1000)}`
    ];
    if (config.auth.secureCookies) attributes.push('Secure');
    return attributes.join('; ');
  }

  function getSessionToken(req) {
    return parseCookies(req.headers.cookie)[cookieName] || '';
  }

  async function currentUser(req) {
    const token = getSessionToken(req);
    if (!token) return null;
    return publicUser(await database.findAdminSession(sessionHash(token)));
  }

  async function requireUser(req) {
    const user = await currentUser(req);
    if (!user) throw authError('Zaloguj się, aby uzyskać dostęp do konsoli.', 401, 'AUTH_REQUIRED');
    return user;
  }

  function assertSafeMutation(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      throw authError('Żądanie z innej witryny zostało zablokowane.', 403, 'AUTH_ORIGIN_REJECTED');
    }
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      if (new URL(origin).host !== req.headers.host) throw new Error('origin mismatch');
    } catch {
      throw authError('Żądanie z nieprawidłowego źródła zostało zablokowane.', 403, 'AUTH_ORIGIN_REJECTED');
    }
  }

  function setupAllowed(req, input) {
    if (isLoopback(req.socket.remoteAddress)) return true;
    if (!config.auth.setupToken) return false;
    return safeEqual(req.headers['x-voice-setup-token'] || input.setupToken || '', config.auth.setupToken);
  }

  async function createSession(admin) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionMilliseconds).toISOString();
    await database.createAdminSession({ tokenHash: sessionHash(token), adminId: admin.id, expiresAt });
    return { user: publicUser({ ...admin, adminId: admin.id }), setCookie: cookie(token) };
  }

  async function setup(req, input = {}) {
    if (await database.adminCount() > 0) {
      throw authError('Konfiguracja właściciela została już zakończona.', 409, 'AUTH_SETUP_COMPLETE');
    }
    if (!setupAllowed(req, input)) {
      throw authError('Pierwszą konfigurację wykonaj lokalnie albo podaj token wdrożeniowy.', 403, 'AUTH_SETUP_FORBIDDEN');
    }
    const email = normalizeEmail(input.email);
    const password = normalizePassword(input.password);
    validateCredentials({ email, password });
    const admin = await database.createFirstAdmin({ email, passwordHash: hashPassword(password) });
    return createSession(admin);
  }

  function attemptKey(req, email) {
    return `${req.socket.remoteAddress || 'unknown'}:${email}`;
  }

  async function login(req, input = {}) {
    if (await database.adminCount() === 0) {
      throw authError('Najpierw utwórz konto właściciela.', 409, 'AUTH_SETUP_REQUIRED');
    }
    const email = normalizeEmail(input.email).slice(0, 255);
    const suppliedPassword = normalizePassword(input.password);
    const password = suppliedPassword.length <= MAX_PASSWORD_LENGTH ? suppliedPassword : '';
    const key = attemptKey(req, email);
    const now = Date.now();
    const windowMilliseconds = config.auth.loginWindowMinutes * 60 * 1000;
    for (const [storedKey, stored] of attempts) {
      if (now - stored.startedAt >= windowMilliseconds) attempts.delete(storedKey);
    }
    if (attempts.size > 5000) attempts.clear();
    const record = attempts.get(key);
    if (record && now - record.startedAt < windowMilliseconds && record.count >= config.auth.loginMaxAttempts) {
      const retryAfter = Math.max(1, Math.ceil((record.startedAt + windowMilliseconds - now) / 1000));
      throw authError('Zbyt wiele prób logowania. Spróbuj ponownie później.', 429, 'AUTH_RATE_LIMITED', retryAfter);
    }
    const admin = await database.findAdminByEmail(email);
    const valid = verifyPassword(password, admin?.passwordHash || dummyPasswordHash);
    if (!admin || !valid) {
      const current = attempts.get(key);
      attempts.set(key, current ? { ...current, count: current.count + 1 } : { count: 1, startedAt: now });
      throw authError('Nieprawidłowy e-mail lub hasło.', 401, 'AUTH_INVALID_CREDENTIALS');
    }
    attempts.delete(key);
    return createSession(admin);
  }

  async function logout(req) {
    const token = getSessionToken(req);
    if (token) await database.deleteAdminSession(sessionHash(token));
    return { setCookie: cookie('', { clear: true }) };
  }

  async function status(req) {
    const setupRequired = await database.adminCount() === 0;
    const user = await currentUser(req);
    return {
      setupRequired,
      authenticated: Boolean(user),
      user,
      localSetupAllowed: setupRequired && isLoopback(req.socket.remoteAddress),
      setupTokenRequired: setupRequired && !isLoopback(req.socket.remoteAddress)
    };
  }

  return { assertSafeMutation, currentUser, requireUser, setup, login, logout, status };
}
