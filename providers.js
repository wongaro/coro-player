// Servizi cloud: Google Drive, OneDrive, Dropbox.
// Ogni servizio offre: accesso, cartelle iniziali (roots), elenco di una cartella, download di un file.
(function (root) {
  'use strict';
  const CFG = root.CORO_CONFIG;
  const FOLDER = 'application/vnd.google-apps.folder';
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const needLogin = (label) => Object.assign(new Error('Accesso a ' + label + ' necessario'), { needLogin: true });
  const redirectUri = () => new URL('auth.html', location.href.split('#')[0].split('?')[0]).href;

  // ---------- OAuth con PKCE in una finestra separata ----------
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randStr = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const challenge = async v => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

  // Va chiamata dentro il tap: la finestra si apre subito, l'indirizzo arriva un attimo dopo.
  function oauthPopup(buildUrl) {
    const w = window.open('', 'coro-auth', 'width=520,height=680');
    return new Promise((resolve, reject) => {
      if (!w) { reject(new Error('Finestra di accesso bloccata: consenti i popup e riprova.')); return; }
      const state = randStr(16), verifier = randStr(48);
      let finished = false, timer = null;
      const cleanup = () => {
        finished = true; clearInterval(timer);
        removeEventListener('message', onMsg); removeEventListener('storage', onStore);
        localStorage.removeItem('coro.oauth');
        try { w.close(); } catch (e) { /* ignore */ }
      };
      const done = (data) => {
        if (finished) return;
        cleanup();
        if (!data || data.state !== state) { reject(new Error('Risposta di accesso non valida, riprova.')); return; }
        if (data.error) { reject(new Error(data.error_description || data.error)); return; }
        resolve({ code: data.code, verifier });
      };
      const onMsg = e => { if (e.origin === location.origin && e.data && e.data.coroOAuth) done(e.data.coroOAuth); };
      const onStore = e => { if (e.key === 'coro.oauth' && e.newValue) done(JSON.parse(e.newValue)); };
      addEventListener('message', onMsg); addEventListener('storage', onStore);
      localStorage.removeItem('coro.oauth');
      challenge(verifier).then(ch => { w.location.href = buildUrl(state, ch); }).catch(err => { cleanup(); reject(err); });
      timer = setInterval(() => {
        const v = localStorage.getItem('coro.oauth');
        if (v) done(JSON.parse(v));
        else if (w.closed && !finished) { cleanup(); reject(new Error('Accesso annullato.')); }
      }, 600);
    });
  }

  async function postForm(url, params) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    let j = {};
    try { j = await r.json(); } catch (e) { /* risposta vuota */ }
    if (!r.ok) throw new Error(j.error_description || j.error_summary || j.error || ('Errore ' + r.status));
    return j;
  }

  // Gestione token con rinnovo automatico (refresh token)
  function oauthClient({ key, label, tokenUrl, clientId, scope }) {
    const store = { get: () => get(key, null), set: v => set(key, v), clear: () => localStorage.removeItem(key) };
    const save = (j, old) => store.set({ access: j.access_token, refresh: j.refresh_token || (old && old.refresh), exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
    return {
      store,
      isSignedIn() { const t = store.get(); return !!(t && (t.refresh || t.exp > Date.now() + 60000)); },
      async exchange(code, verifier) {
        save(await postForm(tokenUrl, Object.assign({ client_id: clientId(), grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }, scope ? { scope } : {})));
      },
      async token() {
        const t = store.get();
        if (!t) throw needLogin(label);
        if (t.exp > Date.now() + 60000) return t.access;
        if (!t.refresh) { store.clear(); throw needLogin(label); }
        try {
          const j = await postForm(tokenUrl, Object.assign({ client_id: clientId(), grant_type: 'refresh_token', refresh_token: t.refresh }, scope ? { scope } : {}));
          save(j, t);
          return j.access_token;
        } catch (e) { store.clear(); throw needLogin(label); }
      }
    };
  }

  const isMedia = (name, mime) => root.CoroParser.kindOf(root.CoroParser.splitExt(name).ext, mime);

  // ---------- Google Drive ----------
  const google = {
    id: 'google', label: 'Google Drive', icon: '🟢',
    configured: () => root.Drive.isConfigured(),
    isSignedIn: () => root.Drive.isSignedIn(),
    signIn: () => root.Drive.signIn(),
    signOut: () => root.Drive.signOut(),
    roots: () => [
      { id: 'root', name: 'Il mio Drive' },
      { id: '__shared', name: 'Condivisi con me', virtual: true },
      { id: '__drives', name: 'Drive condivisi', virtual: true }
    ],
    norm: (f) => ({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime, parents: f.parents }),
    async list(folderId) {
      if (folderId === '__shared') return (await root.Drive.query('sharedWithMe = true and trashed = false')).map(google.norm);
      if (folderId === '__drives') return (await root.Drive.sharedDrives()).map(d => ({ id: d.id, name: d.name, isFolder: true }));
      return (await root.Drive.listChildren([folderId])).map(google.norm);
    },
    // più cartelle in poche richieste (usato nella scansione)
    async listMany(ids) { return (await root.Drive.listChildren(ids)).map(google.norm); },
    download: (file) => root.Drive.download(file.id)
  };

  // ---------- OneDrive (Microsoft Graph) ----------
  const MS = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const msScope = 'Files.Read Files.Read.All User.Read offline_access';
  const msAuth = oauthClient({ key: 'coro.tok.onedrive', label: 'OneDrive', tokenUrl: MS + '/token', clientId: () => CFG.MICROSOFT_CLIENT_ID, scope: msScope });
  async function graph(pathOrUrl) {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : 'https://graph.microsoft.com/v1.0' + pathOrUrl;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + await msAuth.token() } });
    if (r.status === 401) { msAuth.store.clear(); throw needLogin('OneDrive'); }
    if (!r.ok) throw new Error('Errore OneDrive ' + r.status);
    return r.json();
  }
  const msItem = (it) => {
    const ri = it.remoteItem || it;
    const driveId = (ri.parentReference && ri.parentReference.driveId) || '';
    return { id: driveId + '|' + ri.id, name: it.name, isFolder: !!(ri.folder || it.folder), mimeType: (ri.file || it.file || {}).mimeType, size: ri.size, modifiedTime: ri.lastModifiedDateTime };
  };
  const onedrive = {
    id: 'onedrive', label: 'OneDrive', icon: '🔵',
    configured: () => !!CFG.MICROSOFT_CLIENT_ID,
    isSignedIn: () => msAuth.isSignedIn(),
    signIn() {
      return oauthPopup((state, ch) => MS + '/authorize?' + new URLSearchParams({
        client_id: CFG.MICROSOFT_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(), scope: msScope,
        state, code_challenge: ch, code_challenge_method: 'S256', prompt: 'select_account'
      })).then(({ code, verifier }) => msAuth.exchange(code, verifier));
    },
    signOut: () => msAuth.store.clear(),
    roots: () => [{ id: 'root', name: 'I miei file' }, { id: '__shared', name: 'Condivisi con me', virtual: true }],
    async list(folderId) {
      let url;
      if (folderId === '__shared') url = '/me/drive/sharedWithMe';
      else if (folderId === 'root') url = '/me/drive/root/children?$top=999';
      else { const [d, i] = folderId.split('|'); url = `/drives/${encodeURIComponent(d)}/items/${encodeURIComponent(i)}/children?$top=999`; }
      const out = [];
      while (url) { const j = await graph(url); out.push(...(j.value || []).map(msItem)); url = j['@odata.nextLink'] || ''; }
      return out;
    },
    async download(file) {
      const [d, i] = file.id.split('|');
      const meta = await graph(`/drives/${encodeURIComponent(d)}/items/${encodeURIComponent(i)}`);
      const link = meta['@microsoft.graph.downloadUrl'];
      if (!link) throw new Error('File OneDrive non scaricabile');
      const r = await fetch(link);
      if (!r.ok) throw new Error('Download OneDrive non riuscito');
      return r.blob();
    }
  };

  // ---------- Dropbox ----------
  const dbxAuth = oauthClient({ key: 'coro.tok.dropbox', label: 'Dropbox', tokenUrl: 'https://api.dropboxapi.com/oauth2/token', clientId: () => CFG.DROPBOX_APP_KEY });
  // Dropbox vuole l'argomento JSON nell'header con i caratteri non ASCII in forma \uXXXX
  const asciiJson = o => JSON.stringify(o).replace(/[^\x00-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  async function dbxApi(endpoint, body) {
    const r = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + await dbxAuth.token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (r.status === 401) { dbxAuth.store.clear(); throw needLogin('Dropbox'); }
    if (!r.ok) throw new Error('Errore Dropbox ' + r.status);
    return r.json();
  }
  const dropbox = {
    id: 'dropbox', label: 'Dropbox', icon: '🔷',
    configured: () => !!CFG.DROPBOX_APP_KEY,
    isSignedIn: () => dbxAuth.isSignedIn(),
    signIn() {
      return oauthPopup((state, ch) => 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
        client_id: CFG.DROPBOX_APP_KEY, response_type: 'code', redirect_uri: redirectUri(), state,
        code_challenge: ch, code_challenge_method: 'S256', token_access_type: 'offline'
      })).then(({ code, verifier }) => dbxAuth.exchange(code, verifier));
    },
    signOut: () => dbxAuth.store.clear(),
    roots: () => [{ id: '', name: 'Dropbox' }],
    async list(path) {
      let j = await dbxApi('files/list_folder', { path: path || '', limit: 2000 });
      const out = [];
      for (;;) {
        for (const e of j.entries || []) out.push({ id: e.path_lower, name: e.name, isFolder: e['.tag'] === 'folder', size: e.size, modifiedTime: e.client_modified });
        if (!j.has_more) break;
        j = await dbxApi('files/list_folder/continue', { cursor: j.cursor });
      }
      return out;
    },
    async download(file) {
      const r = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST', headers: { Authorization: 'Bearer ' + await dbxAuth.token(), 'Dropbox-API-Arg': asciiJson({ path: file.id }) }
      });
      if (r.status === 401) { dbxAuth.store.clear(); throw needLogin('Dropbox'); }
      if (!r.ok) throw new Error('Download Dropbox non riuscito');
      return r.blob();
    }
  };

  const all = [google, onedrive, dropbox];
  const byId = { google, gdrive: google, onedrive, dropbox };
  root.CoroProviders = { all, get: id => byId[id], isMedia, redirectUri };
})(window);
