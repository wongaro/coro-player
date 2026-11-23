// Accesso a Google Drive: login (Google Identity Services), elenco cartelle, download file.
(function (root) {
  const CFG = root.CORO_CONFIG;
  const API = 'https://www.googleapis.com/drive/v3/files';
  const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const TOKEN_KEY = 'coro.token';
  const RK_KEY = 'coro.resourceKeys';
  const FOLDER = 'application/vnd.google-apps.folder';

  let token = null;
  try { token = JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch (e) { token = null; }

  // resourceKey dei file/cartelle (necessari per i vecchi link condivisi "0B...")
  let resourceKeys = {};
  try { resourceKeys = JSON.parse(localStorage.getItem(RK_KEY)) || {}; } catch (e) { resourceKeys = {}; }
  for (const src of CFG.DEFAULT_SOURCES || []) if (src.resourceKey) resourceKeys[src.folderId] = src.resourceKey;
  function saveKeys() {
    try { localStorage.setItem(RK_KEY, JSON.stringify(resourceKeys)); } catch (e) { /* quota */ }
  }

  function apiKeyMode() { return !CFG.GOOGLE_CLIENT_ID && !!CFG.GOOGLE_API_KEY; }
  function isSignedIn() { return apiKeyMode() || (token && Date.now() < token.exp - 60000); }
  function isConfigured() { return !!(CFG.GOOGLE_CLIENT_ID || CFG.GOOGLE_API_KEY); }

  let tokenClient = null;
  let pending = null;
  function initClient() {
    if (tokenClient || !CFG.GOOGLE_CLIENT_ID) return tokenClient;
    if (!(root.google && google.accounts && google.accounts.oauth2)) return null;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => { const p = pending; pending = null; if (p) p.onToken(resp); },
      error_callback: (err) => { const p = pending; pending = null; if (p) p.onError(err); }
    });
    return tokenClient;
  }

  // Va chiamata direttamente dentro un gesto dell'utente (tap), senza await prima.
  function signIn() {
    return new Promise((resolve, reject) => {
      const client = initClient();
      if (!client) { reject(new Error('Libreria Google non ancora caricata: riprova tra un istante.')); return; }
      pending = {
        onToken: (resp) => {
          if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
          token = { access_token: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
          localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
          resolve(token);
        },
        onError: (err) => reject(new Error(err && err.type === 'popup_closed' ? 'Accesso annullato.' : 'Accesso non riuscito (popup bloccato?).'))
      };
      client.requestAccessToken({ prompt: token ? '' : 'consent' });
    });
  }

  function signOut() {
    if (token && root.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token.access_token, () => {}); } catch (e) { /* ignore */ }
    }
    token = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  class NeedLogin extends Error {
    constructor() { super('Accesso a Google necessario'); this.needLogin = true; }
  }

  function authHeaders(ids) {
    const h = {};
    if (!apiKeyMode()) {
      if (!isSignedIn()) throw new NeedLogin();
      h.Authorization = 'Bearer ' + token.access_token;
    }
    const keys = (ids || []).filter(id => resourceKeys[id]).map(id => id + '/' + resourceKeys[id]);
    if (keys.length) h['X-Goog-Drive-Resource-Keys'] = keys.join(',');
    return h;
  }

  function withKey(url) {
    if (!apiKeyMode()) return url;
    return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(CFG.GOOGLE_API_KEY);
  }

  async function request(url, ids) {
    const res = await fetch(withKey(url), { headers: authHeaders(ids) });
    if (res.status === 401) { signOut(); throw new NeedLogin(); }
    if (!res.ok) {
      let msg = 'Errore Google Drive ' + res.status;
      try { const j = await res.json(); if (j.error && j.error.message) msg += ': ' + j.error.message; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res;
  }

  // Elenca i figli di più cartelle in poche richieste (OR sui parents, a blocchi).
  async function listChildren(parentIds, onProgress) {
    const out = [];
    const CHUNK = 25;
    for (let i = 0; i < parentIds.length; i += CHUNK) {
      const chunk = parentIds.slice(i, i + CHUNK);
      const q = '(' + chunk.map(id => `'${id}' in parents`).join(' or ') + ') and trashed = false';
      let pageToken = '';
      do {
        const params = new URLSearchParams({
          q,
          pageSize: '1000',
          fields: 'nextPageToken, files(id, name, mimeType, parents, modifiedTime, size, resourceKey)',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          corpora: 'allDrives'
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await request(API + '?' + params.toString(), chunk);
        const data = await res.json();
        for (const f of data.files || []) {
          if (f.resourceKey) resourceKeys[f.id] = f.resourceKey;
          out.push(f);
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      if (onProgress) onProgress(Math.min(i + CHUNK, parentIds.length), parentIds.length);
    }
    saveKeys();
    return out;
  }

  // Ricerca libera (es. "Condivisi con me")
  async function query(q) {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q, pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        fields: 'nextPageToken, files(id, name, mimeType, parents, modifiedTime, size, resourceKey)'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await request(API + '?' + params.toString(), [])).json();
      for (const f of data.files || []) { if (f.resourceKey) resourceKeys[f.id] = f.resourceKey; out.push(f); }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    saveKeys();
    return out;
  }

  async function sharedDrives() {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await request('https://www.googleapis.com/drive/v3/drives?' + params.toString(), [])).json();
      out.push(...(data.drives || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async function download(fileId) {
    const res = await request(`${API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, [fileId]);
    return await res.blob();
  }

  function viewUrl(fileId) {
    const rk = resourceKeys[fileId];
    return `https://drive.google.com/file/d/${fileId}/view` + (rk ? `?resourcekey=${encodeURIComponent(rk)}` : '');
  }

  function addResourceKey(id, key) { if (id && key) { resourceKeys[id] = key; saveKeys(); } }

  // Accetta un link di cartella Drive (anche con resourcekey) oppure il solo ID
  function parseFolderLink(text) {
    const t = String(text || '').trim();
    let id = (t.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || t.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || [])[1];
    if (!id && /^[A-Za-z0-9_-]{10,}$/.test(t)) id = t;
    const rk = (t.match(/[?&]resourcekey=([^&#\s]+)/i) || [])[1];
    return id ? { folderId: id, resourceKey: rk ? decodeURIComponent(rk) : '' } : null;
  }

  async function folderName(id) {
    const res = await request(`${API}/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`, [id]);
    return (await res.json()).name;
  }

  root.Drive = { query, sharedDrives, addResourceKey, parseFolderLink, folderName, isSignedIn, isConfigured, apiKeyMode, signIn, signOut, listChildren, download, viewUrl, FOLDER, NeedLogin, initClient };
})(window);
