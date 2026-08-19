// /api/gallery.js
// Eine einzige Vercel-Funktion für die ganze Galerie-Verwaltung.
// Speichert Fotos + Alben-Manifest direkt im GitHub-Repository der Website
// (also "unbegrenzter", kostenloser Speicher statt Browser-Speicher/jimcdn).
//
// Benötigte Umgebungsvariablen (in den Vercel-Projekteinstellungen anlegen):
//   GITHUB_TOKEN     Personal Access Token mit Schreibrecht auf das Repo
//   GITHUB_OWNER     z.B. "TiberiusKingsley"
//   GITHUB_REPO      z.B. "1288"
//   GITHUB_BRANCH    z.B. "main"
//   ADMIN_PASSWORD   das Bearbeiten-Passwort (serverseitige Prüfung)
//
// Ablagepfade im Repo:
//   public/fotos/<id>.jpg      -- die Bilddateien
//   content/gallery.json       -- Manifest: { albums:[...], photos:[...] }
//
// ── SICHERHEIT (siehe SICHERHEITSKONZEPT.md für das Gesamtbild) ──
// - Alle IDs (Foto/Album) werden auf ein festes Muster geprüft, bevor sie in
//   einen GitHub-Dateipfad eingesetzt werden -> verhindert Path Traversal.
// - Hochgeladene Dateien werden anhand ihrer Magic Bytes als echtes Bild
//   verifiziert, bevor sie gespeichert werden.
// - Text-Eingaben (Bildunterschrift, Album-Name) sind längenbegrenzt.
// - Fehlgeschlagene Passwort-Versuche werden künstlich verzögert und pro
//   warmer Funktionsinstanz grob gezählt (Basisschutz). Der eigentliche
//   Schutz vor automatisiertem Passwort-Raten läuft über die kostenlose
//   Vercel-Firewall (Rate-Limit-Regel auf /api/gallery) -- siehe
//   SICHERHEITSKONZEPT.md, Abschnitt "Einmalige Einrichtung in Vercel".

const GITHUB_API = 'https://api.github.com';

// Erlaubtes Format für alle IDs, die in einen Dateipfad eingehen.
// Passt zu newId() (z.B. "pmszrjkr3knkazb") und slug() (z.B. "sommerfest-2026").
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

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
    'User-Agent': 'klbg-sv-1288-gallery',
  };
}

// Jedes Pfadsegment einzeln URL-kodieren, Schrägstriche als Trenner erhalten.
// Verhindert, dass Sonderzeichen (z.B. "../") als Pfad-Steuerzeichen wirken.
function repoPath(path) {
  const safe = path.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_API}/repos/${env('GITHUB_OWNER')}/${env('GITHUB_REPO')}/contents/${safe}`;
}

// Wirft einen 400-Fehler, wenn der Wert nicht dem erlaubten ID-Muster entspricht.
function requireValidId(name, value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    const err = new Error(`Ungültiger Wert für "${name}".`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function requireString(name, value, maxLen) {
  if (typeof value !== 'string') {
    const err = new Error(`"${name}" muss Text sein.`);
    err.statusCode = 400;
    throw err;
  }
  if (value.length > maxLen) {
    const err = new Error(`"${name}" ist zu lang (max. ${maxLen} Zeichen).`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

// Prüft, ob die ersten Bytes zu einem echten Bildformat passen (JPEG/PNG/WEBP/GIF).
// Verhindert, dass beliebige Dateien (z.B. HTML mit Skript) als ".jpg" abgelegt werden.
function looksLikeImage(buf) {
  if (buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true; // WEBP
  return false;
}

// Datei aus dem Repo lesen. Gibt {content, sha} zurück, oder {content:null, sha:null} wenn nicht vorhanden.
async function ghGetFile(path) {
  const res = await fetch(repoPath(path) + `?ref=${env('GITHUB_BRANCH')}`, { headers: ghHeaders() });
  if (res.status === 404) return { content: null, sha: null };
  if (!res.ok) throw new Error('GitHub-Lesefehler (' + res.status + '): ' + (await res.text()));
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

// Datei im Repo anlegen/überschreiben.
async function ghPutFile(path, contentBase64OrUtf8, sha, message, isBase64) {
  const body = {
    message,
    content: isBase64 ? contentBase64OrUtf8 : Buffer.from(contentBase64OrUtf8, 'utf-8').toString('base64'),
    branch: env('GITHUB_BRANCH'),
  };
  if (sha) body.sha = sha;
  const res = await fetch(repoPath(path), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('GitHub-Schreibfehler (' + res.status + '): ' + (await res.text()));
  return res.json();
}

async function ghDeleteFile(path, sha, message) {
  const res = await fetch(repoPath(path), {
    method: 'DELETE',
    headers: ghHeaders(),
    body: JSON.stringify({ message, sha, branch: env('GITHUB_BRANCH') }),
  });
  if (!res.ok && res.status !== 404) throw new Error('GitHub-Löschfehler (' + res.status + '): ' + (await res.text()));
}

const MANIFEST_PATH = 'content/gallery.json';
const DEFAULT_MANIFEST = { albums: [], photos: [] };

async function readManifest() {
  const { content, sha } = await ghGetFile(MANIFEST_PATH);
  if (!content) return { manifest: DEFAULT_MANIFEST, sha: null };
  try {
    return { manifest: JSON.parse(content), sha };
  } catch (e) {
    return { manifest: DEFAULT_MANIFEST, sha };
  }
}

async function writeManifest(manifest, sha, message) {
  const res = await ghPutFile(MANIFEST_PATH, JSON.stringify(manifest, null, 0), sha, message, false);
  return res.content.sha;
}

// ── Grober Basisschutz gegen Passwort-Raten ─────────────────────────────
// Zählt Fehlversuche pro Absender-IP INNERHALB einer warmen Funktionsinstanz.
// Das ist kein vollständiger Schutz (Serverless-Instanzen sind vergänglich
// und mehrfach parallel aktiv) -- der robuste Schutz läuft über die
// Vercel-Firewall (siehe SICHERHEITSKONZEPT.md). Diese Zählung ist eine
// zusätzliche, kostenlose Verteidigungsebene ("defense in depth").
const failedAttempts = new Map(); // ip -> {count, firstAt}
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_LIMIT = 15;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    await sleep(400); // künstliche Verzögerung erschwert automatisiertes Durchprobieren
    if (!rec || now - rec.firstAt >= ATTEMPT_WINDOW_MS) {
      failedAttempts.set(ip, { count: 1, firstAt: now });
    } else {
      rec.count += 1;
    }
    const err = new Error('Falsches Passwort.');
    err.statusCode = 401;
    throw err;
  }
  failedAttempts.delete(ip);
}

function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function slug(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('album' + Date.now().toString(36));
}

module.exports = async function handler(req, res) {
  // Kein Cross-Origin-Zugriff nötig: das Frontend ruft diese API immer
  // von derselben Domain aus auf. Keine CORS-Freigabe für fremde Seiten.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const { manifest } = await readManifest();
      return res.status(200).json(manifest);
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Methode nicht erlaubt.' });
    }

    const body = req.body || {};
    const action = body.action;

    // Nur lesende Aktion (GET): oben schon behandelt.
    // Alle folgenden Aktionen verändern Daten -> Passwort nötig.
    await checkPassword(req, body);

    const { manifest, sha } = await readManifest();

    if (action === 'upload') {
      const { album, filename, dataBase64 } = body;
      requireValidId('album', album);
      if (!manifest.albums.find((a) => a.id === album)) {
        return res.status(400).json({ error: 'Unbekanntes Album.' });
      }
      if (typeof dataBase64 !== 'string' || !dataBase64.length) {
        return res.status(400).json({ error: 'dataBase64 ist erforderlich.' });
      }
      const caption = requireString('caption', body.caption || '', 500);
      const safeFilename = requireString('filename', (filename || 'foto').slice(0, 120), 120);

      const raw = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
      const buf = Buffer.from(raw, 'base64');
      if (buf.length > 12 * 1024 * 1024) {
        return res.status(400).json({ error: 'Foto ist zu groß (max. 12 MB).' });
      }
      if (!looksLikeImage(buf)) {
        return res.status(400).json({ error: 'Datei sieht nicht wie ein gültiges Bild aus.' });
      }

      const id = newId();
      const path = `public/fotos/${id}.jpg`;
      await ghPutFile(path, raw, null, `Foto hinzugefügt: ${safeFilename}`, true);
      manifest.photos.push({ id, album, caption });
      const newSha = await writeManifest(manifest, sha, `Galerie: Foto zu "${album}" hinzugefügt`);
      return res.status(200).json({ manifest, sha: newSha, id });
    }

    if (action === 'move') {
      const photoId = requireValidId('photoId', body.photoId);
      const album = requireValidId('album', body.album);
      if (!manifest.albums.find((a) => a.id === album)) {
        return res.status(400).json({ error: 'Unbekanntes Album.' });
      }
      const p = manifest.photos.find((x) => x.id === photoId);
      if (!p) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      p.album = album;
      const newSha = await writeManifest(manifest, sha, `Galerie: Foto verschoben nach "${album}"`);
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'caption') {
      const photoId = requireValidId('photoId', body.photoId);
      const caption = requireString('caption', body.caption || '', 500);
      const p = manifest.photos.find((x) => x.id === photoId);
      if (!p) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      p.caption = caption;
      const newSha = await writeManifest(manifest, sha, 'Galerie: Bildunterschrift geändert');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'reorder') {
      const { order } = body;
      if (!Array.isArray(order) || order.length > 5000) {
        return res.status(400).json({ error: 'order muss ein Array sein.' });
      }
      order.forEach((id) => requireValidId('order[]', id));
      const byId = Object.fromEntries(manifest.photos.map((p) => [p.id, p]));
      const reordered = order.map((id) => byId[id]).filter(Boolean);
      manifest.photos.forEach((p) => { if (!order.includes(p.id)) reordered.push(p); });
      manifest.photos = reordered;
      const newSha = await writeManifest(manifest, sha, 'Galerie: Reihenfolge geändert');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'delete') {
      const photoId = requireValidId('photoId', body.photoId);
      const idx = manifest.photos.findIndex((x) => x.id === photoId);
      if (idx === -1) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      manifest.photos.splice(idx, 1);
      try {
        const { sha: fileSha } = await ghGetFile(`public/fotos/${photoId}.jpg`);
        if (fileSha) await ghDeleteFile(`public/fotos/${photoId}.jpg`, fileSha, 'Foto gelöscht');
      } catch (e) { /* Datei evtl. schon weg - ignorieren */ }
      const newSha = await writeManifest(manifest, sha, 'Galerie: Foto gelöscht');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'addAlbum') {
      const label = requireString('label', (body.label || '').trim(), 100);
      if (!label) return res.status(400).json({ error: 'label ist erforderlich.' });
      if (manifest.albums.length >= 200) {
        return res.status(400).json({ error: 'Maximale Anzahl an Alben erreicht.' });
      }
      let id = slug(label);
      while (manifest.albums.find((a) => a.id === id)) id += '-2';
      manifest.albums.push({ id, label });
      const newSha = await writeManifest(manifest, sha, `Galerie: Album "${label}" angelegt`);
      return res.status(200).json({ manifest, sha: newSha, id });
    }

    if (action === 'renameAlbum') {
      const albumId = requireValidId('albumId', body.albumId);
      const label = requireString('label', (body.label || '').trim(), 100);
      if (!label) return res.status(400).json({ error: 'label ist erforderlich.' });
      const a = manifest.albums.find((x) => x.id === albumId);
      if (!a) return res.status(404).json({ error: 'Album nicht gefunden.' });
      a.label = label;
      const newSha = await writeManifest(manifest, sha, `Galerie: Album umbenannt in "${label}"`);
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'deleteAlbum') {
      const albumId = requireValidId('albumId', body.albumId);
      manifest.albums = manifest.albums.filter((a) => a.id !== albumId);
      const toDelete = manifest.photos.filter((p) => p.album === albumId);
      manifest.photos = manifest.photos.filter((p) => p.album !== albumId);
      for (const p of toDelete) {
        try {
          const { sha: fileSha } = await ghGetFile(`public/fotos/${p.id}.jpg`);
          if (fileSha) await ghDeleteFile(`public/fotos/${p.id}.jpg`, fileSha, 'Foto gelöscht (Album entfernt)');
        } catch (e) { /* ignorieren */ }
      }
      const newSha = await writeManifest(manifest, sha, 'Galerie: Album gelöscht');
      return res.status(200).json({ manifest, sha: newSha });
    }

    return res.status(400).json({ error: 'Unbekannte Aktion: ' + action });
  } catch (err) {
    const code = err.statusCode || 500;
    return res.status(code).json({ error: err.message || 'Serverfehler' });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '15mb' }, // Fotos kommen als Base64 im Body
  },
};
