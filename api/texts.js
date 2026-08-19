// /api/texts.js
// Speichert Text-Änderungen (Überschriften, Absätze, Zahlen) genauso wie
// api/gallery.js die Fotos speichert: direkt im GitHub-Repository, damit
// Änderungen auf JEDEM Gerät sofort für ALLE Besucher sichtbar sind --
// nicht nur im Browser, in dem sie eingegeben wurden.
//
// Benötigt dieselben Umgebungsvariablen wie api/gallery.js:
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, ADMIN_PASSWORD
//
// Ablagepfad im Repo: content/texts.json  -- flaches { "schlüssel": "wert" }-Objekt

const GITHUB_API = 'https://api.github.com';
const KEY_RE = /^[A-Za-z0-9_:-]{1,100}$/;
const MAX_VALUE_LEN = 8000;

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error('Fehlende Umgebungsvariable: ' + name);
  return v;
}

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + env('GITHUB_TOKEN'),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'klbg-sv-1288-texts',
  };
}

function repoPath(path) {
  const safe = path.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_API}/repos/${env('GITHUB_OWNER')}/${env('GITHUB_REPO')}/contents/${safe}`;
}

async function ghGetFile(path) {
  const res = await fetch(repoPath(path) + `?ref=${env('GITHUB_BRANCH')}`, { headers: ghHeaders() });
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error('GitHub-Lesefehler (' + res.status + '): ' + (await res.text()));
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

async function ghPutFile(path, utf8Content, sha, message) {
  const body = {
    message,
    content: Buffer.from(utf8Content, 'utf-8').toString('base64'),
    branch: env('GITHUB_BRANCH'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(repoPath(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('GitHub-Schreibfehler (' + res.status + '): ' + (await res.text()));
  return res.json();
}

const TEXTS_PATH = 'content/texts.json';

async function readTexts() {
  const { content, sha } = await ghGetFile(TEXTS_PATH);
  if (!content) return { texts: {}, sha: null };
  try {
    return { texts: JSON.parse(content), sha };
  } catch (e) {
    return { texts: {}, sha };
  }
}

async function writeTexts(texts, sha, message) {
  const res = await ghPutFile(TEXTS_PATH, JSON.stringify(texts, null, 0), sha, message);
  return res.content.sha;
}

// ── derselbe Basisschutz gegen Passwort-Raten wie in api/gallery.js ──
const failedAttempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_LIMIT = 15;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function checkPassword(req, body) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error('ADMIN_PASSWORD ist auf dem Server nicht gesetzt.');
  const ip = clientIp(req);
  const now = Date.now();
  const rec = failedAttempts.get(ip);
  if (rec && now - rec.firstAt < ATTEMPT_WINDOW_MS && rec.count >= ATTEMPT_LIMIT) {
    const err = new Error('Zu viele Fehlversuche. Bitte später erneut versuchen.');
    err.statusCode = 429;
    throw err;
  }
  if (!body || typeof body.password !== 'string' || body.password !== expected) {
    await sleep(400);
    if (!rec || now - rec.firstAt >= ATTEMPT_WINDOW_MS) failedAttempts.set(ip, { count: 1, firstAt: now });
    else rec.count += 1;
    const err = new Error('Falsches Passwort.');
    err.statusCode = 401;
    throw err;
  }
  failedAttempts.delete(ip);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { texts } = await readTexts();
      return res.status(200).json(texts);
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Methode nicht erlaubt.' });
    }

    const body = req.body || {};
    await checkPassword(req, body);

    if (body.action === 'update') {
      const key = body.key;
      const value = body.value;
      if (typeof key !== 'string' || !KEY_RE.test(key)) {
        return res.status(400).json({ error: 'Ungültiger Schlüssel.' });
      }
      if (typeof value !== 'string' || value.length > MAX_VALUE_LEN) {
        return res.status(400).json({ error: 'Ungültiger oder zu langer Text (max. ' + MAX_VALUE_LEN + ' Zeichen).' });
      }
      const { texts, sha } = await readTexts();
      texts[key] = value;
      await writeTexts(texts, sha, `Text geändert: ${key}`);
      return res.status(200).json({ texts });
    }

    return res.status(400).json({ error: 'Unbekannte Aktion.' });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ error: err.message || 'Serverfehler' });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};
