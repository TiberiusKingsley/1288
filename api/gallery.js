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

const GITHUB_API = 'https://api.github.com';

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

function repoPath(path) {
  return `${GITHUB_API}/repos/${env('GITHUB_OWNER')}/${env('GITHUB_REPO')}/contents/${path}`;
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

function checkPassword(body) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error('ADMIN_PASSWORD ist auf dem Server nicht gesetzt.');
  if (!body || body.password !== expected) {
    const err = new Error('Falsches Passwort.');
    err.statusCode = 401;
    throw err;
  }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

    // Nur lesende Aktion (keine): oben schon behandelt.
    // Alle folgenden Aktionen verändern Daten -> Passwort nötig.
    checkPassword(body);

    const { manifest, sha } = await readManifest();

    if (action === 'upload') {
      const { album, filename, dataBase64, caption } = body;
      if (!album || !dataBase64) return res.status(400).json({ error: 'album und dataBase64 sind erforderlich.' });
      const id = newId();
      const path = `public/fotos/${id}.jpg`;
      // dataBase64 kann ein data:-URI-Präfix haben -> entfernen
      const raw = dataBase64.includes(',') ? dataBase64.split(',')[1] : dataBase64;
      await ghPutFile(path, raw, null, `Foto hinzugefügt: ${filename || id}`, true);
      manifest.photos.push({ id, album, caption: caption || '' });
      const newSha = await writeManifest(manifest, sha, `Galerie: Foto zu "${album}" hinzugefügt`);
      return res.status(200).json({ manifest, sha: newSha, id });
    }

    if (action === 'move') {
      const { photoId, album } = body;
      const p = manifest.photos.find((x) => x.id === photoId);
      if (!p) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      p.album = album;
      const newSha = await writeManifest(manifest, sha, `Galerie: Foto verschoben nach "${album}"`);
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'caption') {
      const { photoId, caption } = body;
      const p = manifest.photos.find((x) => x.id === photoId);
      if (!p) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      p.caption = caption || '';
      const newSha = await writeManifest(manifest, sha, 'Galerie: Bildunterschrift geändert');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'reorder') {
      const { order } = body; // Array von photoId in neuer Reihenfolge
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order muss ein Array sein.' });
      const byId = Object.fromEntries(manifest.photos.map((p) => [p.id, p]));
      const reordered = order.map((id) => byId[id]).filter(Boolean);
      // Fotos, die nicht in order vorkommen, hinten anhängen (Sicherheitsnetz)
      manifest.photos.forEach((p) => { if (!order.includes(p.id)) reordered.push(p); });
      manifest.photos = reordered;
      const newSha = await writeManifest(manifest, sha, 'Galerie: Reihenfolge geändert');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'delete') {
      const { photoId } = body;
      const idx = manifest.photos.findIndex((x) => x.id === photoId);
      if (idx === -1) return res.status(404).json({ error: 'Foto nicht gefunden.' });
      manifest.photos.splice(idx, 1);
      // Bilddatei löschen (best effort)
      try {
        const { sha: fileSha } = await ghGetFile(`public/fotos/${photoId}.jpg`);
        if (fileSha) await ghDeleteFile(`public/fotos/${photoId}.jpg`, fileSha, 'Foto gelöscht');
      } catch (e) { /* Datei evtl. schon weg - ignorieren */ }
      const newSha = await writeManifest(manifest, sha, 'Galerie: Foto gelöscht');
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'addAlbum') {
      const { label } = body;
      if (!label || !label.trim()) return res.status(400).json({ error: 'label ist erforderlich.' });
      let id = slug(label);
      while (manifest.albums.find((a) => a.id === id)) id += '-2';
      manifest.albums.push({ id, label: label.trim() });
      const newSha = await writeManifest(manifest, sha, `Galerie: Album "${label}" angelegt`);
      return res.status(200).json({ manifest, sha: newSha, id });
    }

    if (action === 'renameAlbum') {
      const { albumId, label } = body;
      const a = manifest.albums.find((x) => x.id === albumId);
      if (!a) return res.status(404).json({ error: 'Album nicht gefunden.' });
      a.label = label;
      const newSha = await writeManifest(manifest, sha, `Galerie: Album umbenannt in "${label}"`);
      return res.status(200).json({ manifest, sha: newSha });
    }

    if (action === 'deleteAlbum') {
      const { albumId } = body;
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
}

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '15mb' }, // Fotos kommen als Base64 im Body
  },
};
