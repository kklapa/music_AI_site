'use strict';

/* ============================================================================
 *  NEONWAVE — Self-hosted AI Music Streaming Platform
 *  Node.js + Express + better-sqlite3 + Socket.IO
 * ==========================================================================*/

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

/* ---------------------------------------------------------------------------
 *  КОНФІГУРАЦІЯ
 * -------------------------------------------------------------------------*/

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : crypto.randomBytes(48).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn(
    '[warn] JWT_SECRET не заданий у .env — згенеровано тимчасовий. ' +
      'Усі сесії буде скинуто після перезапуску.'
  );
}

const ROOT = __dirname;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(ROOT, process.env.UPLOAD_DIR || 'uploads');
const AUDIO_DIR = path.join(UPLOAD_DIR, 'audio');
const COVER_DIR = path.join(UPLOAD_DIR, 'covers');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '250', 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
const ALLOW_REGISTRATION =
  String(process.env.ALLOW_REGISTRATION || 'true') === 'true';

for (const dir of [DATA_DIR, UPLOAD_DIR, AUDIO_DIR, COVER_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ---------------------------------------------------------------------------
 *  БАЗА ДАНИХ
 * -------------------------------------------------------------------------*/

const db = new Database(path.join(DATA_DIR, 'neonwave.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    avatar_color  TEXT    NOT NULL DEFAULT '#7c4dff',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    artist      TEXT    NOT NULL DEFAULT 'AI',
    genre       TEXT    NOT NULL DEFAULT '',
    tags        TEXT    NOT NULL DEFAULT '',
    ai_prompt   TEXT    NOT NULL DEFAULT '',
    ai_model    TEXT    NOT NULL DEFAULT '',
    audio_file  TEXT    NOT NULL,
    cover_file  TEXT,
    duration    REAL    NOT NULL DEFAULT 0,
    plays       INTEGER NOT NULL DEFAULT 0,
    is_public   INTEGER NOT NULL DEFAULT 1,
    created_by  INTEGER,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    body       TEXT    NOT NULL,
    time_sec   REAL    NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL,
    track_id   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL,
    track_id  INTEGER NOT NULL,
    played_at INTEGER NOT NULL,
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_created  ON tracks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_track  ON comments(track_id, time_sec);
  CREATE INDEX IF NOT EXISTS idx_history_user    ON history(user_id, played_at DESC);
`);

/* ---------------------------------------------------------------------------
 *  НАЛАШТУВАННЯ (settings)
 * -------------------------------------------------------------------------*/

const DEFAULT_SETTINGS = {
  site_name: 'NEONWAVE',
  site_tagline: 'AI Music Streaming',
  webhook_enabled: 'false',
  webhook_url: '',
  allow_registration: ALLOW_REGISTRATION ? 'true' : 'false',
};

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/* ---------------------------------------------------------------------------
 *  SEED АДМІНА
 * -------------------------------------------------------------------------*/

(function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const username = process.env.ADMIN_USER || 'admin';
  let password = process.env.ADMIN_PASSWORD;

  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    console.log('──────────────────────────────────────────────');
    console.log('  Створено адміністратора:');
    console.log(`  Логін:  ${username}`);
    console.log(`  Пароль: ${password}`);
    console.log('  ЗБЕРЕЖІТЬ ЦЕЙ ПАРОЛЬ І ЗМІНІТЬ ЙОГО ПІСЛЯ ВХОДУ!');
    console.log('──────────────────────────────────────────────');
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, role, avatar_color, created_at) VALUES (?,?,?,?,?)'
  ).run(username, hash, 'admin', '#00e5ff', Date.now());
})();

/* ---------------------------------------------------------------------------
 *  MIME-ДОВІДНИК
 * -------------------------------------------------------------------------*/

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

function mimeForAudio(file) {
  return AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function mimeForImage(file) {
  return IMAGE_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/* ---------------------------------------------------------------------------
 *  ДИНАМІЧНИЙ ПАРСЕР ТРИВАЛОСТІ (music-metadata)
 * -------------------------------------------------------------------------*/

let _parseFile = null;
async function getAudioDuration(filePath) {
  try {
    if (!_parseFile) {
      const mod = await import('music-metadata');
      _parseFile = mod.parseFile || (mod.default && mod.default.parseFile);
    }
    if (!_parseFile) return 0;
    const meta = await _parseFile(filePath);
    const d = meta && meta.format && meta.format.duration;
    return Number.isFinite(d) ? Number(d) : 0;
  } catch (err) {
    console.warn('[audio-meta] не вдалося прочитати тривалість:', err.message);
    return 0;
  }
}

/* ---------------------------------------------------------------------------
 *  EXPRESS
 * -------------------------------------------------------------------------*/

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// Базові security-заголовки
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

/* ---------------------------------------------------------------------------
 *  RATE LIMITERS
 * -------------------------------------------------------------------------*/

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_uploads' },
});

/* ---------------------------------------------------------------------------
 *  JWT / AUTH ХЕЛПЕРИ
 * -------------------------------------------------------------------------*/

const TOKEN_TTL = '30d';
const COOKIE_NAME = 'nw_token';

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function readUserFromReq(req) {
  const raw =
    (req.cookies && req.cookies[COOKIE_NAME]) ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, JWT_SECRET);
    const user = db
      .prepare('SELECT id, username, role, avatar_color, created_at FROM users WHERE id = ?')
      .get(payload.uid);
    return user || null;
  } catch {
    return null;
  }
}

function optionalAuth(req, _res, next) {
  req.user = readUserFromReq(req);
  next();
}

function authRequired(req, res, next) {
  req.user = readUserFromReq(req);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function adminRequired(req, res, next) {
  req.user = readUserFromReq(req);
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

/* ---------------------------------------------------------------------------
 *  MULTER
 * -------------------------------------------------------------------------*/

const storage = multer.diskStorage({
  destination(_req, file, cb) {
    if (file.fieldname === 'audio') return cb(null, AUDIO_DIR);
    if (file.fieldname === 'cover') return cb(null, COVER_DIR);
    cb(new Error('unexpected_field'));
  },
  filename(_req, file, cb) {
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const ext = /^\.[a-z0-9]{1,6}$/.test(rawExt) ? rawExt : '';
    const stamp = Date.now().toString(36);
    const rand = crypto.randomBytes(8).toString('hex');
    cb(null, `${stamp}-${rand}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === 'audio') {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!AUDIO_MIME[ext]) return cb(new Error('unsupported_audio_format'));
      return cb(null, true);
    }
    if (file.fieldname === 'cover') {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!IMAGE_MIME[ext]) return cb(new Error('unsupported_image_format'));
      return cb(null, true);
    }
    return cb(new Error('unexpected_field'));
  },
});

/* ---------------------------------------------------------------------------
 *  WEBHOOK ДЛЯ IoT
 * -------------------------------------------------------------------------*/

async function forwardWebhook(event, payload) {
  if (getSetting('webhook_enabled', 'false') !== 'true') return;
  const url = getSetting('webhook_url', '');
  if (!url || !/^https?:\/\//i.test(url)) return;

  const body = JSON.stringify({
    event,
    timestamp: Date.now(),
    ...payload,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    console.warn(`[webhook] ${event} → помилка: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------------
 *  ДОПОМІЖНЕ
 * -------------------------------------------------------------------------*/

function safeDeleteFile(dir, filename) {
  if (!filename) return;
  const base = path.basename(filename);
  const full = path.join(dir, base);
  if (!full.startsWith(dir)) return;
  fs.promises.unlink(full).catch(() => {});
}

function trackPublicShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    genre: row.genre,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    ai_prompt: row.ai_prompt,
    ai_model: row.ai_model,
    audio_url: `/api/tracks/${row.id}/stream`,
    cover_url: row.cover_file ? `/uploads/covers/${row.cover_file}` : null,
    duration: row.duration,
    plays: row.plays,
    likes: row.likes != null ? row.likes : undefined,
    comments: row.comments != null ? row.comments : undefined,
    liked: row.liked != null ? !!row.liked : undefined,
    created_at: row.created_at,
  };
}

/* ===========================================================================
 *  REST API
 * =========================================================================*/

const api = express.Router();
app.use('/api', api);

/* --- Health ----------------------------------------------------------------*/

api.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), version: '1.0.0' });
});

/* --- Config (публічні налаштування) ---------------------------------------*/

api.get('/config', (_req, res) => {
  res.json({
    site_name: getSetting('site_name', 'NEONWAVE'),
    site_tagline: getSetting('site_tagline', 'AI Music Streaming'),
    allow_registration: getSetting('allow_registration', 'true') === 'true',
  });
});

/* --- AUTH ------------------------------------------------------------------*/

api.post('/auth/register', authLimiter, async (req, res) => {
  if (getSetting('allow_registration', 'true') !== 'true') {
    return res.status(403).json({ error: 'registration_disabled' });
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (username.length < 3 || username.length > 32 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'weak_password' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username_taken' });

  const hash = await bcrypt.hash(password, 12);
  const hue = Math.floor(Math.random() * 360);
  const color = `hsl(${hue} 90% 60%)`;

  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, avatar_color, created_at) VALUES (?,?,?,?,?)'
    )
    .run(username, hash, 'user', color, Date.now());

  const user = db
    .prepare('SELECT id, username, role, avatar_color, created_at FROM users WHERE id = ?')
    .get(info.lastInsertRowid);

  setAuthCookie(res, signToken(user));
  res.status(201).json({ user });
});

api.post('/auth/login', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const user = {
    id: row.id,
    username: row.username,
    role: row.role,
    avatar_color: row.avatar_color,
    created_at: row.created_at,
  };

  setAuthCookie(res, signToken(user));
  res.json({ user });
});

api.post('/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

api.get('/auth/me', optionalAuth, (req, res) => {
  res.json({ user: req.user || null });
});

api.post('/auth/password', authRequired, authLimiter, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');

  if (next.length < 8) return res.status(400).json({ error: 'weak_password' });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const ok = await bcrypt.compare(current, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const hash = await bcrypt.hash(next, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

/* --- TRACKS ----------------------------------------------------------------*/

api.get('/tracks', optionalAuth, (req, res) => {
  const uid = req.user ? req.user.id : 0;

  const rows = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
              (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments,
              EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.user_id = ?) AS liked
         FROM tracks t
        WHERE t.is_public = 1
        ORDER BY t.created_at DESC`
    )
    .all(uid);

  res.json({ tracks: rows.map(trackPublicShape) });
});

api.get('/tracks/:id', optionalAuth, (req, res) => {
  const uid = req.user ? req.user.id : 0;
  const row = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
              (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments,
              EXISTS(SELECT 1 FROM likes l WHERE l.track_id = t.id AND l.user_id = ?) AS liked
         FROM tracks t WHERE t.id = ?`
    )
    .get(uid, req.params.id);

  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ track: trackPublicShape(row) });
});

api.get('/tracks/:id/stream', (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'not_found' });

  const base = path.basename(track.audio_file);
  const filePath = path.join(AUDIO_DIR, base);

  if (!filePath.startsWith(AUDIO_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file_missing' });
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const mime = mimeForAudio(base);
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : total - 1;

  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= total) end = total - 1;

  if (start > end || start >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', chunkSize);

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

api.post('/tracks/:id/play', optionalAuth, (req, res) => {
  const id = Number(req.params.id);
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(id);
  if (!track) return res.status(404).json({ error: 'not_found' });

  db.prepare('UPDATE tracks SET plays = plays + 1 WHERE id = ?').run(id);

  if (req.user) {
    db.prepare('INSERT INTO history (user_id, track_id, played_at) VALUES (?,?,?)').run(
      req.user.id,
      id,
      Date.now()
    );
    db.prepare(
      `DELETE FROM history WHERE user_id = ? AND id NOT IN (
         SELECT id FROM history WHERE user_id = ? ORDER BY played_at DESC LIMIT 200
       )`
    ).run(req.user.id, req.user.id);
  }

  res.json({ ok: true });
});

api.post('/tracks/:id/like', authRequired, writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(id);
  if (!track) return res.status(404).json({ error: 'not_found' });

  db.prepare(
    'INSERT OR IGNORE INTO likes (user_id, track_id, created_at) VALUES (?,?,?)'
  ).run(req.user.id, id, Date.now());

  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE track_id = ?').get(id).c;
  res.json({ liked: true, likes: count });
});

api.delete('/tracks/:id/like', authRequired, writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(req.user.id, id);

  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE track_id = ?').get(id).c;
  res.json({ liked: false, likes: count });
});

/* --- COMMENTS (SoundCloud-style) ------------------------------------------*/

api.get('/tracks/:id/comments', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.track_id, c.user_id, c.body, c.time_sec, c.created_at,
              u.username, u.avatar_color
         FROM comments c
         JOIN users u ON u.id = c.user_id
        WHERE c.track_id = ?
        ORDER BY c.time_sec ASC, c.created_at ASC`
    )
    .all(req.params.id);

  res.json({
    comments: rows.map((r) => ({
      id: r.id,
      track_id: r.track_id,
      user_id: r.user_id,
      username: r.username,
      avatar_color: r.avatar_color,
      body: r.body,
      time_sec: r.time_sec,
      created_at: r.created_at,
    })),
  });
});

api.post('/tracks/:id/comments', authRequired, writeLimiter, (req, res) => {
  const trackId = Number(req.params.id);
  const track = db.prepare('SELECT id FROM tracks WHERE id = ?').get(trackId);
  if (!track) return res.status(404).json({ error: 'not_found' });

  const body = String(req.body.body || '').trim();
  const timeSec = Math.max(0, Number(req.body.time_sec) || 0);

  if (body.length < 1 || body.length > 500) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  const info = db
    .prepare(
      'INSERT INTO comments (track_id, user_id, body, time_sec, created_at) VALUES (?,?,?,?,?)'
    )
    .run(trackId, req.user.id, body, timeSec, Date.now());

  const comment = {
    id: info.lastInsertRowid,
    track_id: trackId,
    user_id: req.user.id,
    username: req.user.username,
    avatar_color: req.user.avatar_color,
    body,
    time_sec: timeSec,
    created_at: Date.now(),
  };

  io.emit('comment:new', comment);
  res.status(201).json({ comment });
});

api.delete('/comments/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  io.emit('comment:deleted', { id: row.id, track_id: row.track_id });
  res.json({ ok: true });
});

/* --- HISTORY ---------------------------------------------------------------*/

api.get('/me/history', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*, h.played_at,
              (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes
         FROM history h
         JOIN tracks t ON t.id = h.track_id
        WHERE h.user_id = ?
        ORDER BY h.played_at DESC
        LIMIT 100`
    )
    .all(req.user.id);

  res.json({ tracks: rows.map(trackPublicShape) });
});

api.get('/me/likes', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM likes l2 WHERE l2.track_id = t.id) AS likes
         FROM likes l
         JOIN tracks t ON t.id = l.track_id
        WHERE l.user_id = ?
        ORDER BY l.created_at DESC`
    )
    .all(req.user.id);

  res.json({ tracks: rows.map(trackPublicShape) });
});

/* --- PLAYER EVENT (webhook dispatcher) ------------------------------------*/

api.post('/player/event', optionalAuth, writeLimiter, (req, res) => {
  const event = String(req.body.event || '');
  const allowed = ['play', 'pause', 'track_change', 'seek', 'stop'];
  if (!allowed.includes(event)) return res.status(400).json({ error: 'invalid_event' });

  const trackId = req.body.track_id ? Number(req.body.track_id) : null;
  let track = null;

  if (trackId) {
    const row = db.prepare('SELECT id, title, artist, genre, duration FROM tracks WHERE id = ?').get(trackId);
    if (row) track = row;
  }

  forwardWebhook(event, {
    track,
    position: Number(req.body.position) || 0,
    user: req.user ? req.user.username : null,
  });

  res.json({ ok: true });
});

/* ===========================================================================
 *  ADMIN API
 * =========================================================================*/

const admin = express.Router();
api.use('/admin', admin);
admin.use(adminRequired);

/* --- Upload / Create track -------------------------------------------------*/

admin.post(
  '/tracks',
  uploadLimiter,
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
  ]),
  async (req, res) => {
    const audioFile = req.files && req.files.audio && req.files.audio[0];
    const coverFile = req.files && req.files.cover && req.files.cover[0];

    if (!audioFile) {
      if (coverFile) safeDeleteFile(COVER_DIR, coverFile.filename);
      return res.status(400).json({ error: 'audio_required' });
    }

    const title = String(req.body.title || '').trim() || path.parse(audioFile.originalname).name;
    const artist = String(req.body.artist || 'AI').trim() || 'AI';
    const genre = String(req.body.genre || '').trim();
    const tags = String(req.body.tags || '').trim();
    const aiPrompt = String(req.body.ai_prompt || '').trim();
    const aiModel = String(req.body.ai_model || '').trim();
    const isPublic = req.body.is_public === 'false' ? 0 : 1;

    let duration = 0;
    try {
      duration = await getAudioDuration(audioFile.path);
    } catch {
      duration = 0;
    }

    const info = db
      .prepare(
        `INSERT INTO tracks
          (title, artist, genre, tags, ai_prompt, ai_model,
           audio_file, cover_file, duration, plays, is_public, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`
      )
      .run(
        title,
        artist,
        genre,
        tags,
        aiPrompt,
        aiModel,
        audioFile.filename,
        coverFile ? coverFile.filename : null,
        duration,
        isPublic,
        req.user.id,
        Date.now()
      );

    const row = db
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
                (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments
           FROM tracks t WHERE t.id = ?`
      )
      .get(info.lastInsertRowid);

    const shaped = trackPublicShape(row);
    io.emit('track:new', shaped);
    res.status(201).json({ track: shaped });
  }
);

/* --- Update track ----------------------------------------------------------*/

admin.patch(
  '/tracks/:id',
  uploadLimiter,
  upload.fields([{ name: 'cover', maxCount: 1 }]),
  (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const coverFile = req.files && req.files.cover && req.files.cover[0];

    const fields = {
      title: req.body.title != null ? String(req.body.title).trim() : existing.title,
      artist: req.body.artist != null ? String(req.body.artist).trim() : existing.artist,
      genre: req.body.genre != null ? String(req.body.genre).trim() : existing.genre,
      tags: req.body.tags != null ? String(req.body.tags).trim() : existing.tags,
      ai_prompt: req.body.ai_prompt != null ? String(req.body.ai_prompt) : existing.ai_prompt,
      ai_model: req.body.ai_model != null ? String(req.body.ai_model) : existing.ai_model,
      is_public:
        req.body.is_public != null
          ? String(req.body.is_public) === 'false' || String(req.body.is_public) === '0'
            ? 0
            : 1
          : existing.is_public,
    };

    if (coverFile) {
      safeDeleteFile(COVER_DIR, existing.cover_file);
    }

    db.prepare(
      `UPDATE tracks SET
         title = ?, artist = ?, genre = ?, tags = ?, ai_prompt = ?,
         ai_model = ?, is_public = ?, cover_file = ?
       WHERE id = ?`
    ).run(
      fields.title || existing.title,
      fields.artist || 'AI',
      fields.genre,
      fields.tags,
      fields.ai_prompt,
      fields.ai_model,
      fields.is_public,
      coverFile ? coverFile.filename : existing.cover_file,
      id
    );

    const row = db
      .prepare(
        `SELECT t.*,
                (SELECT COUNT(*) FROM likes l WHERE l.track_id = t.id) AS likes,
                (SELECT COUNT(*) FROM comments c WHERE c.track_id = t.id) AS comments
           FROM tracks t WHERE t.id = ?`
      )
      .get(id);

    const shaped = trackPublicShape(row);
    io.emit('track:update', shaped);
    res.json({ track: shaped });
  }
);

/* --- Delete track (фізичне видалення файлів) ------------------------------*/

admin.delete('/tracks/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM tracks WHERE id = ?').run(id);

  safeDeleteFile(AUDIO_DIR, row.audio_file);
  safeDeleteFile(COVER_DIR, row.cover_file);

  io.emit('track:delete', { id });
  res.json({ ok: true });
});

/* --- Users management ------------------------------------------------------*/

admin.get('/users', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.avatar_color, u.created_at,
              (SELECT COUNT(*) FROM tracks t WHERE t.created_by = u.id) AS tracks_count
         FROM users u ORDER BY u.created_at DESC`
    )
    .all();
  res.json({ users: rows });
});

admin.post('/users', authLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (username.length < 3 || username.length > 32 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'weak_password' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'username_taken' });

  const hash = await bcrypt.hash(password, 12);
  const hue = Math.floor(Math.random() * 360);
  const color = `hsl(${hue} 90% 60%)`;

  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, role, avatar_color, created_at) VALUES (?,?,?,?,?)'
    )
    .run(username, hash, role, color, Date.now());

  const user = db
    .prepare('SELECT id, username, role, avatar_color, created_at FROM users WHERE id = ?')
    .get(info.lastInsertRowid);

  res.status(201).json({ user });
});

admin.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const role = req.body.role === 'admin' ? 'admin' : req.body.role === 'user' ? 'user' : row.role;

  if (row.role === 'admin' && role !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'last_admin' });
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  res.json({ ok: true });
});

admin.post('/users/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'weak_password' });

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  res.json({ ok: true });
});

admin.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'cannot_delete_self' });

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  if (row.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'last_admin' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* --- Settings --------------------------------------------------------------*/

admin.get('/settings', (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json({ settings: out });
});

admin.put('/settings', (req, res) => {
  const allowed = ['site_name', 'site_tagline', 'webhook_enabled', 'webhook_url', 'allow_registration'];
  const body = req.body || {};

  for (const key of allowed) {
    if (body[key] === undefined) continue;
    let value = body[key];

    if (key === 'webhook_url') {
      value = String(value).trim();
      if (value && !/^https?:\/\//i.test(value)) {
        return res.status(400).json({ error: 'invalid_webhook_url' });
      }
    } else if (key === 'webhook_enabled' || key === 'allow_registration') {
      value = String(value) === 'true' ? 'true' : 'false';
    } else {
      value = String(value).slice(0, 200);
    }

    setSetting(key, value);
  }

  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json({ settings: out });
});

admin.post('/webhook/test', async (_req, res) => {
  const url = getSetting('webhook_url', '');
  if (!url) return res.status(400).json({ error: 'webhook_url_empty' });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'test',
        timestamp: Date.now(),
        track: { id: 0, title: 'Test Track', artist: 'NEONWAVE' },
        position: 0,
        user: 'admin',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    res.json({ ok: true, status: response.status });
  } catch (err) {
    res.status(502).json({ error: 'webhook_failed', message: err.message });
  }
});

/* --- Stats -----------------------------------------------------------------*/

admin.get('/stats', (_req, res) => {
  const tracks = db.prepare('SELECT COUNT(*) AS c FROM tracks').get().c;
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const plays = db.prepare('SELECT COALESCE(SUM(plays),0) AS c FROM tracks').get().c;
  const comments = db.prepare('SELECT COUNT(*) AS c FROM comments').get().c;

  let storageBytes = 0;
  for (const dir of [AUDIO_DIR, COVER_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          storageBytes += fs.statSync(path.join(dir, f)).size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  res.json({ tracks, users, plays, comments, storageBytes });
});

/* ===========================================================================
 *  STATIC
 * =========================================================================*/

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      const mime = mimeForImage(filePath);
      if (mime) res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    },
  })
);

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('service-worker.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ===========================================================================
 *  ERROR HANDLER
 * =========================================================================*/

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'file_too_large', max_mb: MAX_UPLOAD_MB });
    }
    return res.status(400).json({ error: 'upload_error', message: err.message });
  }

  if (err && err.message === 'unsupported_audio_format') {
    return res.status(400).json({ error: 'unsupported_audio_format' });
  }
  if (err && err.message === 'unsupported_image_format') {
    return res.status(400).json({ error: 'unsupported_image_format' });
  }

  console.error('[error]', err);
  res.status(500).json({ error: 'internal_error' });
});

/* ===========================================================================
 *  SOCKET.IO — LIVE LISTEN ROOMS
 * =========================================================================*/

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 25000,
  cors: { origin: true, credentials: true },
});

/** rooms: Map<roomId, Room> */
const rooms = new Map();

function makeRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 6 }, () =>
      alphabet.charAt(crypto.randomInt(0, alphabet.length))
    ).join('');
  } while (rooms.has(id));
  return id;
}

function roomSnapshot(room) {
  let position = room.state.position;
  if (room.state.playing && room.state.updatedAt) {
    position += (Date.now() - room.state.updatedAt) / 1000;
  }
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostName: room.hostName,
    members: Array.from(room.members.values()).map((m) => ({
      id: m.id,
      username: m.username,
    })),
    state: {
      trackId: room.state.trackId,
      playing: room.state.playing,
      position: Math.max(0, position),
    },
    chat: room.chat.slice(-60),
  };
}

function broadcastRoom(room, event = 'room:update') {
  io.to(room.id).emit(event, roomSnapshot(room));
}

function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  socket.data.roomId = null;
  socket.leave(roomId);

  if (!room) return;

  room.members.delete(socket.id);

  if (room.members.size === 0) {
    rooms.delete(roomId);
    return;
  }

  if (room.hostId === socket.id) {
    const next = room.members.values().next().value;
    room.hostId = next.id;
    room.hostName = next.username;
    io.to(room.id).emit('room:system', {
      text: `${next.username} тепер ведучий кімнати`,
      ts: Date.now(),
    });
  }

  broadcastRoom(room);
}

io.on('connection', (socket) => {
  socket.data.roomId = null;

  socket.on('room:create', (payload, ack) => {
    try {
      const username = String((payload && payload.username) || 'Гість').slice(0, 32);
      const name = String((payload && payload.name) || 'Live Room').slice(0, 48);

      const id = makeRoomId();
      const room = {
        id,
        name,
        hostId: socket.id,
        hostName: username,
        members: new Map([[socket.id, { id: socket.id, username }]]),
        state: { trackId: null, playing: false, position: 0, updatedAt: Date.now() },
        chat: [],
      };

      rooms.set(id, room);

      if (socket.data.roomId) leaveRoom(socket);

      socket.join(id);
      socket.data.roomId = id;

      if (typeof ack === 'function') ack({ ok: true, room: roomSnapshot(room) });
      broadcastRoom(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('room:join', (payload, ack) => {
    try {
      const roomId = String((payload && payload.roomId) || '').toUpperCase();
      const username = String((payload && payload.username) || 'Гість').slice(0, 32);

      const room = rooms.get(roomId);
      if (!room) {
        if (typeof ack === 'function') ack({ ok: false, error: 'room_not_found' });
        return;
      }

      if (socket.data.roomId) leaveRoom(socket);

      socket.join(roomId);
      socket.data.roomId = roomId;
      room.members.set(socket.id, { id: socket.id, username });

      const snapshot = roomSnapshot(room);
      if (typeof ack === 'function') ack({ ok: true, room: snapshot });

      socket.to(roomId).emit('room:system', {
        text: `${username} приєднався`,
        ts: Date.now(),
      });

      broadcastRoom(room);
    } catch (err) {
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });

  socket.on('room:leave', () => {
    leaveRoom(socket);
  });

  socket.on('room:control', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit('room:error', { error: 'not_host' });
      return;
    }

    const action = String((payload && payload.action) || '');

    if (action === 'track') {
      room.state.trackId = payload.trackId != null ? Number(payload.trackId) : null;
      room.state.position = 0;
      room.state.playing = true;
      room.state.updatedAt = Date.now();
    } else if (action === 'play') {
      room.state.playing = true;
      room.state.updatedAt = Date.now();
    } else if (action === 'pause') {
      room.state.playing = false;
      room.state.position = Number(payload.position) || room.state.position;
      room.state.updatedAt = Date.now();
    } else if (action === 'seek') {
      room.state.position = Math.max(0, Number(payload.position) || 0);
      room.state.updatedAt = Date.now();
    } else {
      return;
    }

    broadcastRoom(room, 'room:sync');
  });

  socket.on('room:request-sync', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit('room:sync', roomSnapshot(room));
  });

  socket.on('room:chat', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const text = String((payload && payload.text) || '').trim().slice(0, 300);
    if (!text) return;

    const member = room.members.get(socket.id);
    const message = {
      id: crypto.randomUUID(),
      username: member ? member.username : 'Гість',
      text,
      ts: Date.now(),
    };

    room.chat.push(message);
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);

    io.to(roomId).emit('room:chat', message);
  });

  socket.on('room:reaction', (payload) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const emoji = String((payload && payload.emoji) || '').slice(0, 8);
    if (!emoji) return;

    const member = room.members.get(socket.id);
    io.to(roomId).emit('room:reaction', {
      emoji,
      username: member ? member.username : 'Гість',
      ts: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });
});

/* ===========================================================================
 *  START
 * =========================================================================*/

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ███╗   ██╗███████╗ ██████╗ ███╗   ██╗██╗    ██╗ █████╗ ██╗   ██╗███████╗');
  console.log('  ████╗  ██║██╔════╝██╔═══██╗████╗  ██║██║    ██║██╔══██╗██║   ██║██╔════╝');
  console.log('  ██╔██╗ ██║█████╗  ██║   ██║██╔██╗ ██║██║ █╗ ██║███████║██║   ██║█████╗  ');
  console.log('  ██║╚██╗██║██╔══╝  ██║   ██║██║╚██╗██║██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ');
  console.log('  ██║ ╚████║███████╗╚██████╔╝██║ ╚████║╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗');
  console.log('  ╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝');
  console.log('');
  console.log(`  ▶ Сервер запущено:  http://0.0.0.0:${PORT}`);
  console.log(`  ▶ Режим:            ${NODE_ENV}`);
  console.log(`  ▶ Дані:             ${DATA_DIR}`);
  console.log(`  ▶ Завантаження:     ${UPLOAD_DIR}`);
  console.log('');
});

/* --- Graceful shutdown -----------------------------------------------------*/

function shutdown(signal) {
  console.log(`\n[${signal}] Завершення роботи...`);
  io.close(() => {
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
