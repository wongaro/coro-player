// Sorgenti della libreria: cartelle Google Drive, link online, file importati dal dispositivo.
(function (root) {
  'use strict';
  const CFG = root.CORO_CONFIG;
  const P = root.CoroParser;
  const KEY = 'coro.sources';
  const LOCAL_KEY = 'coro.localFiles';
  const MAX_DEPTH = 6;
  const FOLDER = 'application/vnd.google-apps.folder';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const app = () => root.CoroApp;

  // ---------- elenco sorgenti ----------
  let sources = get(KEY, null);
  if (!sources) {
    sources = (CFG.DEFAULT_SOURCES || []).map(s => Object.assign({ id: uid(), enabled: true }, s));
    set(KEY, sources);
  }
  for (const s of sources) if (s.type === 'gdrive' && s.resourceKey) root.Drive.addResourceKey(s.folderId, s.resourceKey);
  const save = () => set(KEY, sources);
  const list = () => sources;
  const enabled = () => sources.filter(s => s.enabled !== false);
  const hasDrive = () => enabled().some(s => s.type === 'gdrive');

  // ---------- file locali (IndexedDB condiviso con l'app) ----------
  let localFiles = get(LOCAL_KEY, []);
  const saveLocal = () => set(LOCAL_KEY, localFiles);
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('coro-player', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbDo(mode, fn) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const t = db.transaction('files', mode);
      fn(t.objectStore('files'));
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  async function importLocal(sourceId, fileList) {
    const files = [...fileList];
    let n = 0;
    for (const f of files) {
      const { ext } = P.splitExt(f.name);
      if (!P.kindOf(ext, f.type)) continue;
      const id = 'local:' + uid();
      await idbDo('readwrite', st => st.put({ blob: f, name: f.name, savedAt: Date.now(), local: true }, id));
      localFiles.push({ id, name: f.name, mimeType: f.type, size: f.size, sourceId, modifiedTime: new Date(f.lastModified || Date.now()).toISOString() });
      n++;
    }
    saveLocal();
    return n;
  }
  async function removeLocalOf(sourceId) {
    const ids = localFiles.filter(f => f.sourceId === sourceId).map(f => f.id);
    if (ids.length) await idbDo('readwrite', st => ids.forEach(id => st.delete(id)));
    localFiles = localFiles.filter(f => f.sourceId !== sourceId);
    saveLocal();
  }

  // ---------- scansione ----------
  const isArchive = name => /^archivio$/i.test(String(name).trim());
  function collectionFor(src, path) {
    const first = path[0];
    if (!first || /^[A-Za-z]$/.test(first.trim())) return src.name;
    return first.replace(/^\s*-\s*/, '').trim();
  }
  function toSongs(src, parentId, folderName, files, path, origin, idPrefix) {
    return P.groupFiles(folderName, files).map(s => {
      s.id = idPrefix + (s.key ? ':' + s.key : '');
      s.sourceId = src.id;
      s.collection = collectionFor(src, path);
      for (const t of Object.values(s.tracks).concat(Object.values(s.videos), s.pdf ? [s.pdf] : [])) t.origin = origin;
      delete s.key;
      return s;
    });
  }

  async function scanDrive(src, progress) {
    let frontier = [{ id: src.folderId, name: src.name, path: [] }];
    const songs = [];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const kids = await root.Drive.listChildren(frontier.map(f => f.id), (d, t) => progress(`${src.name}: livello ${depth + 1}, ${d}/${t}`));
      const byParent = {};
      for (const k of kids) for (const p of k.parents || []) (byParent[p] = byParent[p] || []).push(k);
      const next = [];
      for (const f of frontier) {
        const items = byParent[f.id] || [];
        const files = items.filter(i => i.mimeType !== FOLDER);
        if (files.length) songs.push(...toSongs(src, f.id, depth === 0 ? '' : f.name, files, f.path, 'gdrive', f.id));
        for (const sub of items) {
          if (sub.mimeType === FOLDER && !isArchive(sub.name)) next.push({ id: sub.id, name: sub.name, path: f.path.concat(sub.name) });
        }
      }
      frontier = next;
    }
    return songs;
  }

  async function expandLinks(src) {
    const out = [];
    for (const raw of src.links || []) {
      const line = String(raw).trim();
      if (!line) continue;
      const m = line.match(/^(.*?)\s*\|\s*(https?:\/\/\S+)$/);
      const title = m ? m[1] : '';
      const url = m ? m[2] : line;
      if (/\.m3u8?(\?|$)/i.test(url)) {
        try {
          const text = await (await fetch(url)).text();
          let t = '';
          for (const l of text.split(/\r?\n/)) {
            if (l.startsWith('#EXTINF')) t = l.replace(/^#EXTINF:[^,]*,/, '').trim();
            else if (l.trim() && !l.startsWith('#')) { out.push({ url: new URL(l.trim(), url).href, title: t }); t = ''; }
          }
        } catch (e) { throw new Error('Playlist non leggibile: ' + url); }
      } else out.push({ url, title });
    }
    return out;
  }
  async function scanLinks(src) {
    const items = await expandLinks(src);
    const files = items.map((it, i) => {
      const file = decodeURIComponent(it.url.split('/').pop().split('?')[0]) || 'audio-' + (i + 1) + '.mp3';
      const name = it.title ? it.title + '.' + (P.splitExt(file).ext || 'mp3') : file;
      return { id: 'url:' + it.url, name, url: it.url, mimeType: '' };
    });
    return toSongs(src, src.id, '', files, [], 'url', 'url:' + src.id).map(s => {
      for (const t of Object.values(s.tracks).concat(Object.values(s.videos))) t.url = files.find(f => f.id === t.id).url;
      return s;
    });
  }
  function scanLocal(src) {
    return toSongs(src, src.id, '', localFiles.filter(f => f.sourceId === src.id), [], 'local', 'local:' + src.id);
  }

  // Ricostruisce il catalogo. Se una sorgente non è raggiungibile (es. login scaduto)
  // si tengono i brani letti l'ultima volta e si segnala il problema.
  async function scanAll(prevSongs, progress) {
    const all = [];
    const problems = [];
    for (const src of enabled()) {
      try {
        progress(`Lettura ${src.name}…`);
        if (src.type === 'gdrive') {
          if (!root.Drive.isSignedIn()) throw Object.assign(new Error('accesso Google necessario'), { needLogin: true });
          all.push(...await scanDrive(src, progress));
        } else if (src.type === 'links') all.push(...await scanLinks(src));
        else if (src.type === 'local') all.push(...scanLocal(src));
      } catch (e) {
        problems.push(`${src.name}: ${e.message}`);
        all.push(...(prevSongs || []).filter(s => s.sourceId === src.id));
      }
    }
    return { songs: all, problems };
  }

  // ---------- interfaccia (scheda in Impostazioni) ----------
  const TYPE_LABEL = { gdrive: 'Google Drive', links: 'Link online', local: 'File importati' };
  function card() {
    const rows = sources.map(s => {
      const extra = s.type === 'local' ? `${localFiles.filter(f => f.sourceId === s.id).length} file`
        : s.type === 'links' ? `${(s.links || []).length} link` : '';
      return `<li class="src-row">
        <button class="src-toggle ${s.enabled !== false ? 'on' : ''}" data-action="src-toggle" data-id="${esc(s.id)}" aria-label="Attiva/disattiva">${s.enabled !== false ? '✓' : ''}</button>
        <div class="src-main"><div class="src-name">${esc(s.name)}</div><div class="src-sub">${TYPE_LABEL[s.type]}${extra ? ' · ' + extra : ''}</div></div>
        ${s.type === 'local' ? `<button class="icon" data-action="src-import" data-id="${esc(s.id)}" aria-label="Aggiungi file">＋</button>` : ''}
        ${s.type === 'links' ? `<button class="icon" data-action="src-edit-links" data-id="${esc(s.id)}" aria-label="Modifica link">✎</button>` : ''}
        <button class="icon" data-action="src-rename" data-id="${esc(s.id)}" aria-label="Rinomina">Aa</button>
        <button class="icon" data-action="src-del" data-id="${esc(s.id)}" aria-label="Rimuovi">✕</button>
      </li>`;
    }).join('');
    return `<section class="card">
      <label class="lbl">Sorgenti della libreria</label>
      <ul class="src-list">${rows || '<li class="empty-row">Nessuna sorgente</li>'}</ul>
      <div class="chips wrap">
        <button class="chip" data-action="src-add-drive">+ Cartella Google Drive</button>
        <button class="chip" data-action="src-add-links">+ Link online</button>
        <button class="chip" data-action="src-add-local">+ File dal dispositivo</button>
      </div>
      <p class="hint">Dal dispositivo puoi scegliere anche file di iCloud Drive, OneDrive o Dropbox tramite l'app File. I file vengono copiati nell'app.</p>
      <input id="src-file" type="file" multiple accept="audio/*,video/*,application/pdf,.mp3,.m4a,.wav,.mov,.mp4,.pdf" hidden>
    </section>`;
  }

  let importTarget = null;
  function pickFiles(sourceId) {
    importTarget = sourceId;
    const input = document.getElementById('src-file');
    input.value = '';
    input.click();
  }
  function askLinks(current) {
    const txt = prompt('Un indirizzo per riga (https://…mp3 o playlist .m3u).\nPer dare un titolo: Titolo | https://…\nSepara più righe con ;',
      (current || []).join(' ; '));
    if (txt == null) return null;
    return txt.split(/\s*[;\n]\s*/).map(x => x.trim()).filter(Boolean);
  }
  function changed() { save(); app().render(); }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-action^="src-"]');
    if (!t) return;
    const a = t.dataset.action;
    const s = sources.find(x => x.id === t.dataset.id);
    try {
      if (a === 'src-toggle' && s) { s.enabled = s.enabled === false; changed(); app().refreshCatalog(); }
      else if (a === 'src-rename' && s) { const n = prompt('Nome della sorgente', s.name); if (n) { s.name = n.trim(); changed(); app().refreshCatalog(); } }
      else if (a === 'src-del' && s) {
        if (!confirm(`Togliere "${s.name}" dalla libreria?` + (s.type === 'local' ? '\nI file importati verranno eliminati dal dispositivo.' : ''))) return;
        if (s.type === 'local') await removeLocalOf(s.id);
        sources = sources.filter(x => x !== s); changed(); app().refreshCatalog();
      }
      else if (a === 'src-add-drive') {
        const link = prompt('Incolla il link della cartella Google Drive');
        if (!link) return;
        const parsed = root.Drive.parseFolderLink(link);
        if (!parsed) { app().toast('Link di cartella non riconosciuto'); return; }
        if (parsed.resourceKey) root.Drive.addResourceKey(parsed.folderId, parsed.resourceKey);
        let name = '';
        if (root.Drive.isSignedIn()) { try { name = await root.Drive.folderName(parsed.folderId); } catch (e) { /* nome non leggibile */ } }
        name = prompt('Nome da mostrare nell\'app', name || 'Cartella Drive') || name || 'Cartella Drive';
        sources.push(Object.assign({ id: uid(), type: 'gdrive', name, enabled: true }, parsed));
        changed(); app().refreshCatalog();
      }
      else if (a === 'src-add-links') {
        const links = askLinks([]);
        if (!links || !links.length) return;
        const name = prompt('Nome da mostrare nell\'app', 'Link online') || 'Link online';
        sources.push({ id: uid(), type: 'links', name, links, enabled: true });
        changed(); app().refreshCatalog();
      }
      else if (a === 'src-edit-links' && s) {
        const links = askLinks(s.links);
        if (links) { s.links = links; changed(); app().refreshCatalog(); }
      }
      else if (a === 'src-add-local') {
        let local = sources.find(x => x.type === 'local');
        if (!local) { local = { id: uid(), type: 'local', name: 'Sul dispositivo', enabled: true }; sources.push(local); save(); }
        pickFiles(local.id);
      }
      else if (a === 'src-import' && s) pickFiles(s.id);
    } catch (e) { app().toast(e.message || 'Errore'); }
  });

  document.addEventListener('change', async (ev) => {
    if (ev.target.id !== 'src-file' || !importTarget) return;
    const files = ev.target.files;
    if (!files || !files.length) return;
    app().toast('Importazione in corso…');
    try {
      const n = await importLocal(importTarget, files);
      app().toast(n ? `${n} file importati` : 'Nessun file audio, video o PDF selezionato');
      app().refreshCatalog();
    } catch (e) { app().toast('Importazione non riuscita: spazio esaurito?'); }
  });

  root.CoroSources = { list, enabled, hasDrive, scanAll, card, importLocal };
})(window);
