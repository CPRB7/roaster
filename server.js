import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import sharp from 'sharp';
import { OAuth2Client } from 'google-auth-library';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = parseInteger(process.env.PORT, 3000, 1, 65535);
const maxUploadBytes = parseInteger(process.env.MAX_UPLOAD_BYTES, 12 * 1024 * 1024, 1, 12 * 1024 * 1024);
const dataDir = resolveFromRoot(process.env.DATA_DIR || './data');
const uploadDir = resolveFromRoot(process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'));
const backupDir = process.env.BACKUP_DIR ? resolveFromRoot(process.env.BACKUP_DIR) : null;
const databasePath = path.join(dataDir, 'resume-roast.sqlite');
const reactions = new Set(['shit', 'mid', 'respect']);
const reportReasons = new Set(['not-resume', 'hate', 'private-info', 'other']);
const liveDurationMs = 6 * 60 * 60 * 1000;
const resultsWindowMs = 30 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
const requireLogin = parseBooleanFlag(process.env.REQUIRE_LOGIN, false, 'REQUIRE_LOGIN');
const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
  throw new Error('Configure both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in.');
}
const googleRedirectUri = `${publicOrigin || `http://localhost:${port}`}/api/auth/google/callback`;
const googleOAuth = googleClientId && googleClientSecret
  ? new OAuth2Client(googleClientId, googleClientSecret, googleRedirectUri)
  : null;
const sessionDurationMs = 30 * 24 * 60 * 60 * 1000;
const uploadCooldownMs = 30 * 24 * 60 * 60 * 1000;

if (isProduction && !publicOrigin) throw new Error('PUBLIC_ORIGIN must be configured in production.');
if (isProduction && !backupDir) throw new Error('BACKUP_DIR must be configured in production.');
if (isProduction && publicOrigin && new URL(publicOrigin).protocol !== 'https:') {
  throw new Error('PUBLIC_ORIGIN must use HTTPS in production.');
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer configuration: ${value}`);
  }
  return parsed;
}

function parseBooleanFlag(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be set to 1 or 0.`);
}

function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function pathIsWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

if (backupDir && (
  pathIsWithin(backupDir, dataDir)
  || pathIsWithin(dataDir, backupDir)
  || pathIsWithin(backupDir, uploadDir)
  || pathIsWithin(uploadDir, backupDir)
)) {
  throw new Error('BACKUP_DIR and DATA_DIR must be separate directories.');
}
ensurePrivateDirectory(dataDir);
ensurePrivateDirectory(uploadDir);
if (backupDir) ensurePrivateDirectory(backupDir);

const db = new Database(databasePath);
if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('secure_delete = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_salt TEXT,
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    last_upload_at INTEGER,
    CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    label TEXT NOT NULL DEFAULT '',
    image_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'live')),
    created_at INTEGER NOT NULL,
    live_at INTEGER,
    expires_at INTEGER,
    shit_count INTEGER NOT NULL DEFAULT 0 CHECK (shit_count >= 0),
    mid_count INTEGER NOT NULL DEFAULT 0 CHECK (mid_count >= 0),
    respect_count INTEGER NOT NULL DEFAULT 0 CHECK (respect_count >= 0),
    CHECK (
      (status = 'queued' AND live_at IS NULL AND expires_at IS NULL)
      OR (status = 'live' AND live_at IS NOT NULL AND expires_at IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_live_resume
    ON resumes(status) WHERE status = 'live';
  CREATE INDEX IF NOT EXISTS resume_queue_order
    ON resumes(status, created_at, id);
  CREATE TABLE IF NOT EXISTS votes (
    resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    reaction TEXT NOT NULL CHECK (reaction IN ('shit', 'mid', 'respect')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resume_id, voter_hash)
  );
  CREATE TABLE IF NOT EXISTS reports (
    resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('not-resume', 'hate', 'private-info', 'other')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resume_id, voter_hash)
  );
`);

const resumeColumns = new Set(db.pragma('table_info(resumes)').map((column) => column.name));
if (!resumeColumns.has('owner_id')) {
  db.exec('ALTER TABLE resumes ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL');
}

const getLiveResume = db.prepare("SELECT * FROM resumes WHERE status = 'live' LIMIT 1");
const selectNextQueued = db.prepare(`
  SELECT id FROM resumes WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1
`);
const deleteResume = db.prepare('DELETE FROM resumes WHERE id = ?');
const deleteExpired = db.prepare(`
  SELECT id, image_name FROM resumes WHERE status = 'live' AND expires_at <= ?
`);
const markLive = db.prepare(`
  UPDATE resumes SET status = 'live', live_at = ?, expires_at = ? WHERE id = ? AND status = 'queued'
`);
const advanceQueueTransaction = db.transaction((now) => {
  const expired = deleteExpired.all(now);
  for (const resume of expired) deleteResume.run(resume.id);

  if (!getLiveResume.get()) {
    const next = selectNextQueued.get();
    if (next) markLive.run(now, now + liveDurationMs, next.id);
  }
  return expired;
});

function logError(message, error) {
  console.error(message, error instanceof Error ? error.message : String(error));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function readCookie(req, name) {
  const prefix = `${name}=`;
  const value = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix))?.slice(prefix.length);
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function appendCookie(res, name, value, options = {}) {
  const secure = isProduction ? '; Secure' : '';
  const maxAge = options.maxAge === undefined ? '' : `; Max-Age=${options.maxAge}`;
  const pathValue = options.path || '/';
  const sameSite = options.sameSite || 'Strict';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=${pathValue}; HttpOnly; SameSite=${sameSite}${maxAge}${secure}`);
}

function clearCookie(res, name, pathValue = '/') {
  appendCookie(res, name, '', { path: pathValue, maxAge: 0 });
}

function loadOptionalSession(req, res, next) {
  const token = readCookie(req, 'rr_session');
  if (token && /^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    const tokenHash = hashToken(token);
    const session = db.prepare(`
      SELECT users.id, users.email, sessions.expires_at
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);
    if (session && session.expires_at > Date.now()) {
      req.user = { id: session.id, email: session.email };
      req.sessionTokenHash = tokenHash;
    } else if (session) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    }
  }
  next();
}

function requireAuthentication(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' });
  next();
}

function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash, userId, Date.now() + sessionDurationMs);
  appendCookie(res, 'rr_session', token, {
    path: '/',
    sameSite: 'Lax',
    maxAge: Math.floor(sessionDurationMs / 1000),
  });
  return tokenHash;
}

function publicUser(user) {
  return { id: user.id, email: user.email };
}

const scryptAsync = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
    if (error) reject(error);
    else resolve(derivedKey);
  });
});

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false });
const actionAuthentication = [requireSameOrigin, loadOptionalSession, ...(requireLogin ? [requireAuthentication] : [])];

function removeImage(imageName) {
  const imagePath = path.join(uploadDir, imageName);
  try {
    fs.unlinkSync(imagePath);
  } catch (error) {
    if (error.code !== 'ENOENT') logError('Could not remove expired image:', error);
  }
}

let backupGeneration = 0;
let backupPromise = null;
let backupScheduled = false;
let lastBackupAt = 0;
let lastSessionCleanupAt = 0;

function clearBackupSnapshot() {
  if (!backupDir) return;
  backupGeneration += 1;
  const latestPath = path.join(backupDir, 'latest');
  fs.rmSync(latestPath, { recursive: true, force: true });
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.(?:staging|previous)-[0-9a-f-]+$/.test(entry.name)) {
      fs.rmSync(path.join(backupDir, entry.name), { recursive: true, force: true });
    }
  }
}

async function createBackup() {
  if (!backupDir || backupPromise) return backupPromise;
  const generation = backupGeneration;
  const stagingPath = path.join(backupDir, `.staging-${crypto.randomUUID()}`);
  backupPromise = (async () => {
    ensurePrivateDirectory(stagingPath);
    try {
      const snapshotPath = path.join(stagingPath, 'resume-roast.sqlite');
      await db.backup(snapshotPath);
      if (generation !== backupGeneration) return;

      const snapshotDb = new Database(snapshotPath);
      try {
        const resumes = snapshotDb.prepare('SELECT id, image_name FROM resumes').all();
        const snapshotUploads = path.join(stagingPath, 'uploads');
        ensurePrivateDirectory(snapshotUploads);
        for (const resume of resumes) {
          const source = path.join(uploadDir, resume.image_name);
          const destination = path.join(snapshotUploads, resume.image_name);
          fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
          if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
        }
      } finally {
        snapshotDb.close();
      }

      if (generation !== backupGeneration) return;
      const latestPath = path.join(backupDir, 'latest');
      const previousPath = path.join(backupDir, `.previous-${crypto.randomUUID()}`);
      if (fs.existsSync(latestPath)) fs.renameSync(latestPath, previousPath);
      try {
        fs.renameSync(stagingPath, latestPath);
      } catch (error) {
        if (fs.existsSync(previousPath) && !fs.existsSync(latestPath)) fs.renameSync(previousPath, latestPath);
        throw error;
      }
      if (fs.existsSync(previousPath)) fs.rmSync(previousPath, { recursive: true, force: true });
      lastBackupAt = Date.now();
    } catch (error) {
      if (generation === backupGeneration) throw error;
    } finally {
      if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true });
    }
  })();
  try {
    await backupPromise;
  } finally {
    backupPromise = null;
  }
}

function scheduleBackup() {
  if (!backupDir || backupScheduled) return;
  backupScheduled = true;
  const startBackup = () => {
    backupScheduled = false;
    return createBackup();
  };
  const pending = backupPromise;
  const scheduled = pending ? pending.then(startBackup, startBackup) : startBackup();
  scheduled.catch((error) => logError('Could not create the daily backup:', error));
}

function advanceQueue() {
  const now = Date.now();
  const expiredBeforeDeletion = deleteExpired.all(now);
  if (expiredBeforeDeletion.length) clearBackupSnapshot();
  const expired = advanceQueueTransaction(now);
  for (const resume of expired) removeImage(resume.image_name);
  if (expired.length) {
    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)')[0];
    if (checkpoint?.busy) logError('The SQLite secure-delete checkpoint is waiting on an open reader:', checkpoint);
  }
  if (expired.length && backupDir) scheduleBackup();
}

function getVoterHash(req, res) {
  if (req.user) return hashToken(`account:${req.user.id}`);
  let token = readCookie(req, 'rr_voter');
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    token = crypto.randomBytes(32).toString('base64url');
    appendCookie(res, 'rr_voter', token, { maxAge: 2592000 });
  }
  return hashToken(token);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return res.status(403).json({ error: 'A same-origin request is required.' });
  try {
    if (new URL(origin).origin !== (publicOrigin || `${req.protocol}://${req.get('host')}`)) {
      return res.status(403).json({ error: 'A same-origin request is required.' });
    }
  } catch {
    return res.status(403).json({ error: 'A same-origin request is required.' });
  }
  next();
}

function publicResume(resume, voterHash) {
  const remainingMs = Math.max(0, resume.expires_at - Date.now());
  const resultsVisible = remainingMs <= resultsWindowMs;
  const vote = voterHash
    ? db.prepare('SELECT reaction FROM votes WHERE resume_id = ? AND voter_hash = ?').get(resume.id, voterHash)
    : null;
  const report = voterHash
    ? db.prepare('SELECT 1 FROM reports WHERE resume_id = ? AND voter_hash = ?').get(resume.id, voterHash)
    : null;
  const result = {
    id: resume.id,
    label: resume.label,
    liveAt: resume.live_at,
    expiresAt: resume.expires_at,
    remainingMs,
    resultsVisible,
    viewerReaction: vote?.reaction ?? null,
    reported: Boolean(report),
  };
  if (resultsVisible) {
    result.counts = {
      shit: resume.shit_count,
      mid: resume.mid_count,
      respect: resume.respect_count,
      total: resume.shit_count + resume.mid_count + resume.respect_count,
    };
  }
  return result;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1, fields: 1, fieldSize: 256 },
});
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const voteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const reportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (publicOrigin && `${req.protocol}://${req.get('host')}` !== publicOrigin) {
    return res.status(421).end();
  }
  next();
});
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '16kb', strict: true }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 200, standardHeaders: 'draft-8', legacyHeaders: false }));

app.get('/api/auth/status', loadOptionalSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({
    loginRequired: requireLogin,
    googleEnabled: Boolean(googleOAuth),
    user: req.user ? publicUser(req.user) : null,
  });
});

app.post('/api/auth/register', requireSameOrigin, registerLimiter, authLimiter, async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Choose a password between 12 and 128 characters.' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
  }

  try {
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('base64url');
    const passwordHash = (await scryptAsync(password, salt)).toString('base64url');
    db.prepare(`
      INSERT INTO users (id, email, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, email, salt, passwordHash, Date.now());
    createSession(id, res);
    return res.status(201).json({ user: { id, email } });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
    }
    return next(error);
  }
});

app.post('/api/auth/login', requireSameOrigin, authLimiter, async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validEmail(email) || typeof password !== 'string' || password.length > 128) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  try {
    const user = db.prepare(`
      SELECT id, email, password_salt, password_hash FROM users
      WHERE email = ? COLLATE NOCASE
    `).get(email);
    const salt = user?.password_salt || 'resume-roast-invalid-user';
    const calculated = await scryptAsync(password, salt);
    const expected = user?.password_hash
      ? Buffer.from(user.password_hash, 'base64url')
      : crypto.randomBytes(64);
    if (!user?.password_hash || !constantTimeEqual(calculated, expected)) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    createSession(user.id, res);
    return res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', requireSameOrigin, loadOptionalSession, (req, res) => {
  if (req.sessionTokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
  clearCookie(res, 'rr_session');
  return res.json({ ok: true });
});

app.get('/api/auth/google', authLimiter, async (_req, res, next) => {
  if (!googleOAuth) return res.status(503).type('text').send('Google sign-in is not configured.');
  try {
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const cookieOptions = { path: '/api/auth/google/callback', sameSite: 'Lax', maxAge: 600 };
    appendCookie(res, 'rr_oauth_state', state, cookieOptions);
    appendCookie(res, 'rr_oauth_nonce', nonce, cookieOptions);
    appendCookie(res, 'rr_oauth_verifier', codeVerifier, cookieOptions);
    const authorizationUrl = googleOAuth.generateAuthUrl({
      access_type: 'online',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      nonce,
      prompt: 'select_account',
      scope: ['openid', 'email', 'profile'],
      state,
    });
    return res.redirect(302, authorizationUrl);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/google/callback', authLimiter, async (req, res) => {
  const expectedState = readCookie(req, 'rr_oauth_state');
  const expectedNonce = readCookie(req, 'rr_oauth_nonce');
  const codeVerifier = readCookie(req, 'rr_oauth_verifier');
  clearCookie(res, 'rr_oauth_state', '/api/auth/google/callback');
  clearCookie(res, 'rr_oauth_nonce', '/api/auth/google/callback');
  clearCookie(res, 'rr_oauth_verifier', '/api/auth/google/callback');

  try {
    if (!googleOAuth || typeof req.query.state !== 'string' || typeof req.query.code !== 'string'
      || !expectedState || !expectedNonce || !codeVerifier
      || !constantTimeEqual(req.query.state, expectedState)) {
      return res.status(400).type('text').send('Google sign-in could not be verified. Return to the app and try again.');
    }
    const { tokens } = await googleOAuth.getToken({ code: req.query.code, codeVerifier });
    if (!tokens.id_token) throw new Error('Missing identity token.');
    const ticket = await googleOAuth.verifyIdToken({ idToken: tokens.id_token, audience: googleClientId });
    const identity = ticket.getPayload();
    if (!identity?.sub || !identity.email || identity.email_verified !== true
      || !identity.nonce || !constantTimeEqual(identity.nonce, expectedNonce)) {
      return res.status(401).type('text').send('Google sign-in could not be verified. Return to the app and try again.');
    }

    let user = db.prepare('SELECT id, email FROM users WHERE google_sub = ?').get(identity.sub);
    if (!user) {
      if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(identity.email)) {
        return res.status(409).type('text').send('An account already uses this email. Sign in with its existing method.');
      }
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, ?)')
        .run(id, identity.email, identity.sub, Date.now());
      user = { id, email: identity.email };
    }
    createSession(user.id, res);
    return res.redirect(303, '/');
  } catch {
    console.error('Google sign-in failed.');
    return res.status(401).type('text').send('Google sign-in failed. Return to the app and try again.');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/live', loadOptionalSession, (req, res) => {
  advanceQueue();
  res.set('Cache-Control', 'no-store');
  const voterHash = getVoterHash(req, res);
  const resume = getLiveResume.get();
  if (!resume) return res.json({ resume: null, queued: selectNextQueued.get() ? true : false });
  return res.json({ resume: publicResume(resume, voterHash), queued: Boolean(selectNextQueued.get()) });
});

app.get('/api/live/image', (req, res) => {
  advanceQueue();
  const resume = getLiveResume.get();
  if (!resume) return res.status(404).end();
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': 'image/jpeg',
    'Content-Disposition': 'inline; filename="resume.jpg"',
  });
  return res.sendFile(path.join(uploadDir, resume.image_name), (error) => {
    if (error && !res.headersSent) res.status(error.statusCode === 404 ? 404 : 500).end();
  });
});

app.post('/api/uploads', ...actionAuthentication, uploadLimiter, upload.single('resume'), async (req, res, next) => {
  let imageName;
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a resume image to upload.' });
    const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
    if (label.length > 40) return res.status(400).json({ error: 'The label must be 40 characters or fewer.' });
    if (/\S+@\S+\.\S+|(?:\+?\d[\d ()-]{7,}\d)/.test(label)) {
      return res.status(400).json({ error: 'Remove contact information from the label.' });
    }

    const image = sharp(req.file.buffer, { limitInputPixels: 40_000_000, failOn: 'error' });
    let metadata;
    try {
      metadata = await image.metadata();
    } catch {
      return res.status(400).json({ error: 'That image could not be decoded. Try exporting it as PNG, JPG or WebP.' });
    }
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
      return res.status(415).json({ error: 'Upload a PNG, JPG or WebP image.' });
    }
    const sanitized = await image.rotate()
      .resize({ width: 3000, height: 4000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    const id = crypto.randomUUID();
    imageName = `${id}.jpg`;
    fs.writeFileSync(path.join(uploadDir, imageName), sanitized, { flag: 'wx', mode: 0o600 });
    const now = Date.now();
    db.transaction(() => {
      if (req.user) {
        const account = db.prepare('SELECT last_upload_at FROM users WHERE id = ?').get(req.user.id);
        if (!account) {
          const error = new Error('Sign in again to upload.');
          error.code = 'AUTH_REQUIRED';
          throw error;
        }
        if (account.last_upload_at && now - account.last_upload_at < uploadCooldownMs) {
          const error = new Error('Each account can upload one resume every 30 days.');
          error.code = 'UPLOAD_COOLDOWN';
          error.nextUploadAt = account.last_upload_at + uploadCooldownMs;
          throw error;
        }
        db.prepare('UPDATE users SET last_upload_at = ? WHERE id = ?').run(now, req.user.id);
      }
      db.prepare(`
        INSERT INTO resumes (id, owner_id, label, image_name, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)
      `).run(id, req.user?.id ?? null, label, imageName, now);
    })();
    imageName = null;
    advanceQueue();
    return res.status(201).json({ ok: true, queued: !getLiveResume.get()?.id || getLiveResume.get().id !== id });
  } catch (error) {
    if (imageName) removeImage(imageName);
    if (error.code === 'UPLOAD_COOLDOWN') {
      return res.status(429).json({
        error: error.message,
        nextUploadAt: error.nextUploadAt,
        code: error.code,
      });
    }
    if (error.code === 'AUTH_REQUIRED') {
      return res.status(401).json({ error: error.message, code: error.code });
    }
    return next(error);
  }
});

app.post('/api/votes', ...actionAuthentication, voteLimiter, (req, res) => {
  advanceQueue();
  const { reaction } = req.body ?? {};
  if (!reactions.has(reaction)) return res.status(400).json({ error: 'Choose one of the available reactions.' });
  const resume = getLiveResume.get();
  if (!resume) return res.status(409).json({ error: 'There is no live resume to react to.' });
  if (resume.expires_at <= Date.now()) return res.status(409).json({ error: 'This voting window has ended.' });

  const voterHash = getVoterHash(req, res);
  try {
    const insert = db.prepare(`
      INSERT INTO votes (resume_id, voter_hash, reaction, created_at) VALUES (?, ?, ?, ?)
    `);
    const increment = db.prepare(`UPDATE resumes SET ${reaction}_count = ${reaction}_count + 1 WHERE id = ?`);
    db.transaction(() => {
      insert.run(resume.id, voterHash, reaction, Date.now());
      increment.run(resume.id);
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Your reaction has already been recorded for this resume.' });
    }
    throw error;
  }
  const updated = getLiveResume.get();
  return res.json({ ok: true, resume: publicResume(updated, voterHash) });
});

app.post('/api/reports', ...actionAuthentication, reportLimiter, (req, res) => {
  advanceQueue();
  const { reason } = req.body ?? {};
  if (!reportReasons.has(reason)) return res.status(400).json({ error: 'Choose a valid report reason.' });
  const resume = getLiveResume.get();
  if (!resume) return res.status(409).json({ error: 'There is no live resume to report.' });
  const voterHash = getVoterHash(req, res);
  try {
    db.prepare(`
      INSERT INTO reports (resume_id, voter_hash, reason, created_at) VALUES (?, ?, ?, ?)
    `).run(resume.id, voterHash, reason, Date.now());
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A report from this browser was already recorded.' });
    }
    throw error;
  }
  return res.json({ ok: true });
});

app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'index.html'));
});
app.get('/styles.css', (_req, res) => {
  res.set('Cache-Control', isProduction ? 'public, max-age=300' : 'no-store');
  res.sendFile(path.join(ROOT, 'styles.css'));
});
app.get('/app.js', (_req, res) => {
  res.set('Cache-Control', isProduction ? 'public, max-age=300' : 'no-store');
  res.sendFile(path.join(ROOT, 'app.js'));
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((_req, res) => res.status(404).type('text').send('Not found.'));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: status === 413 ? 'That image is over 12 MB.' : 'The upload could not be accepted.' });
  }
  if (error?.name === 'UnsupportedMediaTypeError') {
    return res.status(415).json({ error: 'Upload a PNG, JPG or WebP image.' });
  }
  logError('Request failed:', error);
  return res.status(500).json({ error: 'The request could not be completed. Please try again.' });
});

function cleanOrphanedImages() {
  const known = new Set(db.prepare('SELECT image_name FROM resumes').all().map((row) => row.image_name));
  for (const entry of fs.readdirSync(uploadDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jpg') && !known.has(entry.name)) removeImage(entry.name);
  }
}

function schedulerTick() {
  try {
    advanceQueue();
    cleanOrphanedImages();
    if (Date.now() - lastSessionCleanupAt >= 60 * 60 * 1000) {
      const now = Date.now();
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      db.prepare('UPDATE users SET last_upload_at = NULL WHERE last_upload_at <= ?')
        .run(now - uploadCooldownMs);
      lastSessionCleanupAt = now;
    }
    if (backupDir && Date.now() - lastBackupAt >= 24 * 60 * 60 * 1000) scheduleBackup();
  } catch (error) {
    logError('Queue scheduler failed:', error);
  }
}

if (backupDir) {
  for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.(?:staging|previous)-[0-9a-f-]+$/.test(entry.name)) {
      fs.rmSync(path.join(backupDir, entry.name), { recursive: true, force: true });
    }
  }
}
schedulerTick();
if (backupDir) await createBackup();
const scheduler = setInterval(schedulerTick, 15_000);
scheduler.unref();

const server = app.listen(port, () => {
  console.log(`Resume Roast listening on port ${port}`);
});

function shutdown() {
  clearInterval(scheduler);
  server.close(() => {
    try {
      db.close();
      process.exit(0);
    } catch (error) {
      logError('Could not close the database cleanly:', error);
      process.exit(1);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
