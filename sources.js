// Sorgenti della libreria: cartelle cloud (Google Drive, OneDrive, Dropbox), link online,
// cartelle e file importati dal dispositivo. Include il selettore "Aggiungi sorgente"
// con accesso al servizio e navigazione tra le cartelle.
(function (root) {
  'use strict';
  const CFG = root.CORO_CONFIG;
  const P = root.CoroParser;
  const PR = root.CoroProviders;
  const KEY = 'coro.sources';
  const LOCAL_KEY = 'coro.localFiles';
  const MAX_DEPTH = 6;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const app = () => root.CoroApp;
  const isArchive = name => /^archivio$/i.test(String(name).trim());

  // ---------- elenco sorgenti ----------
  let sources = get(KEY, null);
  if (!sources) sources = (CFG.DEFAULT_SOURCES || []).map(s => Object.assign({ id: uid(), enabled: true }, s));
  // le sorgenti "gdrive" delle versioni precedenti diventano cartelle cloud Google
  for (const s of sources) if (s.type === 'gdrive') { s.type = 'cloud'; s.provider = 'google'; }
  set(KEY, sources);
  for (const s of sources) if (s.provider === 'google' && s.resourceKey) root.Drive.addResourceKey(s.folderId, s.resourceKey);
  const save = () => set(KEY, sources);
  const enabled = () => sources.filter(s => s.enabled !== false);
  const cloudProviders = () => [...new Set(enabled().filter(s => s.type === 'cloud').map(s => s.provider))].map(PR.get).filter(Boolean);
  const hasDrive = () => cloudProviders().length > 0;

  // ---------- file importati (IndexedDB condiviso con l'app) ----------
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
  // entries: [{ file, path: ['sottocartella', ...] }]
  async function importLocal(sourceId, entries) {
    let n = 0;
    for (const { file, path } of entries) {
      if (!PR.isMedia(file.name, file.type)) continue;
      const id = 'local:' + uid();
      await idbDo('readwrite', st => st.put({ blob: file, name: file.name, savedAt: Date.now(), local: true }, id));
      localFiles.push({ id, name: file.name, mimeType: file.type, size: file.size, sourceId, path: path || [], modifiedTime: new Date(file.lastModified || Date.now()).toISOString() });
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
  function collectionFor(src, path) {
    const first = path[0];
    if (!first || /^[A-Za-z]$/.test(first.trim())) return src.name;
    return first.replace(/^\s*-\s*/, '').trim();
  }
  function toSongs(src, folderName, files, path, origin, idPrefix) {
    return P.groupFiles(folderName, files).map(s => {
      s.id = idPrefix + (s.key ? ':' + s.key : '');
      s.sourceId = src.id;
      // se il brano è una cartella, la raccolta è la cartella che la contiene
      s.collection = collectionFor(src, !s.key && folderName ? path.slice(0, -1) : path);
      for (const t of Object.values(s.tracks).concat(Object.values(s.videos), s.pdf ? [s.pdf] : [])) t.origin = origin;
      delete s.key;
      return s;
    });
  }
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  async function scanCloud(src, progress) {
    const prov = PR.get(src.provider);
    if (!prov) throw new Error('servizio sconosciuto');
    if (!prov.isSignedIn()) throw Object.assign(new Error('accesso a ' + prov.label + ' necessario'), { needLogin: true });
    let frontier = [{ id: src.folderId, name: src.name, path: [] }];
    const songs = [];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      progress(`${src.name}: livello ${depth + 1} (${frontier.length} cartelle)`);
      const byParent = {};
      if (prov.listMany) {
        const ids = new Set(frontier.map(f => f.id));
        for (const k of await prov.listMany([...ids])) {
          for (const p of k.parents || []) if (ids.has(p)) (byParent[p] = byParent[p] || []).push(k);
        }
      } else {
        const lists = await pool(frontier, 4, f => prov.list(f.id));
        frontier.forEach((f, i) => { byParent[f.id] = lists[i]; });
      }
      const next = [];
      for (const f of frontier) {
        const items = byParent[f.id] || [];
        const files = items.filter(i => !i.isFolder);
        if (files.length) songs.push(...toSongs(src, depth === 0 ? '' : f.name, files, f.path, prov.id, f.id));
        for (const sub of items) if (sub.isFolder && !isArchive(sub.name)) next.push({ id: sub.id, name: sub.name, path: f.path.concat(sub.name) });
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
    return toSongs(src, '', files, [], 'url', 'url:' + src.id).map(s => {
      for (const t of Object.values(s.tracks).concat(Object.values(s.videos))) t.url = files.find(f => f.id === t.id).url;
      return s;
    });
  }
  function scanLocal(src) {
    const byDir = new Map();
    for (const f of localFiles.filter(x => x.sourceId === src.id)) {
      const k = (f.path || []).join('/');
      if (!byDir.has(k)) byDir.set(k, []);
      byDir.get(k).push(f);
    }
    const out = [];
    for (const [dir, files] of byDir) {
      const path = dir ? dir.split('/') : [];
      out.push(...toSongs(src, path.length ? path[path.length - 1] : '', files, path, 'local', 'local:' + src.id + ':' + dir));
    }
    return out;
  }

  // Ricostruisce il catalogo. Se una sorgente non è raggiungibile (es. accesso scaduto)
  // si tengono i brani letti l'ultima volta e si segnala il problema.
  async function scanAll(prevSongs, progress) {
    const all = [];
    const problems = [];
    for (const src of enabled()) {
      try {
        progress(`Lettura ${src.name}…`);
        if (src.type === 'cloud') all.push(...await scanCloud(src, progress));
        else if (src.type === 'links') all.push(...await scanLinks(src));
        else if (src.type === 'local') all.push(...scanLocal(src));
      } catch (e) {
        problems.push(`${src.name}: ${e.message}`);
        all.push(...(prevSongs || []).filter(s => s.sourceId === src.id));
      }
    }
    return { songs: all, problems };
  }

  function download(file) {
    const prov = PR.get(file.origin || 'google');
    if (!prov) throw new Error('Servizio del file non riconosciuto');
    return prov.download(file);
  }

  // ---------- schede in Impostazioni ----------
  function sourceKind(s) {
    if (s.type === 'cloud') { const p = PR.get(s.provider); return (p ? p.label : s.provider) + (s.path && s.path.length ? ' · ' + s.path.join(' › ') : ''); }
    if (s.type === 'links') return `Link online · ${(s.links || []).length} link`;
    return `File importati · ${localFiles.filter(f => f.sourceId === s.id).length} file`;
  }
  function card() {
    const rows = sources.map(s => `<li class="src-row">
        <button class="src-toggle ${s.enabled !== false ? 'on' : ''}" data-action="src-toggle" data-id="${esc(s.id)}" aria-label="Attiva/disattiva">${s.enabled !== false ? '✓' : ''}</button>
        <div class="src-main"><div class="src-name">${esc(s.name)}</div><div class="src-sub">${esc(sourceKind(s))}</div></div>
        ${s.type === 'local' ? `<button class="icon" data-action="src-import" data-id="${esc(s.id)}" aria-label="Aggiungi file">＋</button>` : ''}
        ${s.type === 'links' ? `<button class="icon" data-action="src-edit-links" data-id="${esc(s.id)}" aria-label="Modifica link">✎</button>` : ''}
        <button class="icon" data-action="src-rename" data-id="${esc(s.id)}" aria-label="Rinomina">Aa</button>
        <button class="icon" data-action="src-del" data-id="${esc(s.id)}" aria-label="Rimuovi">✕</button>
      </li>`).join('');
    return `<section class="card">
      <label class="lbl">Sorgenti della libreria</label>
      <ul class="src-list">${rows || '<li class="empty-row">Nessuna sorgente: aggiungine una.</li>'}</ul>
      <button class="btn wide" data-action="src-add">+ Aggiungi sorgente</button>
      <input id="src-file" type="file" multiple accept="audio/*,video/*,application/pdf,.mp3,.m4a,.wav,.mov,.mp4,.pdf" hidden>
      <input id="src-dir" type="file" webkitdirectory multiple hidden>
    </section>`;
  }
  function accountsCard() {
    const rows = PR.all.map(p => {
      const status = !p.configured() ? 'da configurare (vedi README)' : p.isSignedIn() ? 'connesso' : 'non connesso';
      const btn = !p.configured() ? '' : p.isSignedIn()
        ? `<button class="btn ghost small" data-action="src-logout" data-p="${p.id}">Esci</button>`
        : `<button class="btn small" data-action="src-login" data-p="${p.id}">Accedi</button>`;
      return `<li class="src-row"><span class="prov-ico">${p.icon}</span><div class="src-main"><div class="src-name">${p.label}</div><div class="src-sub">${status}</div></div>${btn}</li>`;
    }).join('');
    return `<section class="card"><label class="lbl">Account collegati</label><ul class="src-list">${rows}</ul></section>`;
  }
  function loginBanner() {
    const need = cloudProviders().filter(p => !p.isSignedIn());
    if (!need.length) return '';
    const unconf = need.filter(p => !p.configured());
    if (unconf.length) return `<div class="banner warn"><span>${unconf.map(p => p.label).join(', ')}: manca la configurazione in <b>config.js</b> (vedi README).</span></div>`;
    return `<div class="banner"><span>Per aggiornare la libreria accedi a ${need.map(p => p.label).join(' e ')}.</span>
      ${need.map(p => `<button class="btn small" data-action="src-login" data-p="${p.id}">Accedi${need.length > 1 ? ' a ' + p.label : ''}</button>`).join('')}</div>`;
  }

  // ---------- selettore "Aggiungi sorgente" ----------
  const pk = { prov: null, stack: [], items: null, loading: false, error: '', info: '' };
  const hasDirPicker = () => typeof root.showDirectoryPicker === 'function';
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function addMenu() {
    const opt = (action, ico, title, sub, extra) =>
      `<button class="pick-opt" data-action="${action}" ${extra || ''}><span class="prov-ico">${ico}</span><span class="pick-txt"><b>${title}</b><small>${sub}</small></span><span class="pick-arrow">›</span></button>`;
    const provs = PR.all.map(p => opt('src-pick-prov', p.icon, p.label,
      !p.configured() ? 'da configurare: vedi README' : p.isSignedIn() ? 'connesso · scegli una cartella' : 'accedi e scegli una cartella', `data-p="${p.id}"`)).join('');
    return `<h3>Aggiungi sorgente</h3>
      <p class="sub">Scegli da dove prendere i brani.</p>
      <div class="pick-list">
        ${provs}
        ${opt('src-pick-icloud', '☁️', 'iCloud Drive', 'tramite l\'app File del telefono')}
        ${opt('src-pick-local', '📱', 'File del dispositivo', hasDirPicker() || !isIOS() ? 'scegli una cartella o dei file' : 'scegli i file dall\'app File')}
        ${opt('src-pick-links', '🔗', 'Link online', 'indirizzi di file audio o playlist .m3u')}
      </div>`;
  }

  function folderView() {
    const p = pk.prov;
    const crumbs = [`<button class="crumb" data-action="src-pk-crumb" data-i="0">${esc(p.label)}</button>`]
      .concat(pk.stack.map((f, i) => `<button class="crumb" data-action="src-pk-crumb" data-i="${i + 1}">${esc(f.name)}</button>`)).join('<span class="crumb-sep">›</span>');
    const cur = pk.stack[pk.stack.length - 1];
    let body;
    if (pk.loading) body = '<p class="empty-row">Caricamento…</p>';
    else if (pk.error) body = `<p class="empty-row">${esc(pk.error)}</p>`;
    else {
      const folders = (pk.items || []).filter(i => i.isFolder);
      if (cur) folders.sort((a, b) => a.name.localeCompare(b.name, 'it'));
      const media = (pk.items || []).filter(i => !i.isFolder && PR.isMedia(i.name, i.mimeType));
      body = `${cur && media.length ? `<p class="pick-count">In questa cartella: ${media.length} file audio, video o PDF</p>` : ''}
        <ul class="folder-list">${folders.map((f, i) => `<li><button class="folder-row" data-action="src-pk-open" data-i="${(pk.items || []).indexOf(f)}"><span>📁</span><span class="folder-name">${esc(f.name)}</span><span class="pick-arrow">›</span></button></li>`).join('')
          || (cur ? '' : '<li class="empty-row">Nessuna cartella</li>')}</ul>
        ${cur && !folders.length && !media.length ? '<p class="empty-row">Cartella vuota</p>' : ''}`;
    }
    const canUse = cur && !cur.virtual && !pk.loading;
    return `<div class="toolbar"><button class="link" data-action="src-add">‹ Servizi</button></div>
      <h3>Scegli la cartella</h3>
      <div class="crumbs">${crumbs}</div>
      <div class="folder-box">${body}</div>
      <button class="btn wide" data-action="src-pk-use" ${canUse ? '' : 'disabled'}>${canUse ? 'Usa “' + esc(cur.name) + '”' : 'Apri una cartella'}</button>
      <p class="hint">L'app leggerà questa cartella e tutte le sue sottocartelle (tranne quelle chiamate “archivio”).</p>`;
  }
  function messageView(title, html) {
    return `<div class="toolbar"><button class="link" data-action="src-add">‹ Servizi</button></div><h3>${title}</h3>${html}`;
  }
  const show = html => app().openSheet(html);

  async function loadFolder() {
    const p = pk.prov;
    const cur = pk.stack[pk.stack.length - 1];
    pk.error = '';
    if (!cur) {
      const roots = p.roots();
      if (roots.length === 1) { pk.stack = [roots[0]]; return loadFolder(); }
      pk.items = roots.map(r => Object.assign({ isFolder: true }, r));
      show(folderView());
      return;
    }
    pk.loading = true; show(folderView());
    try {
      const items = await p.list(cur.id);
      // le voci dentro "Condivisi con me" / "Drive condivisi" restano selezionabili
      pk.items = items;
    } catch (e) {
      pk.items = [];
      pk.error = e.needLogin ? 'Accesso scaduto: torna ai servizi e accedi di nuovo.' : (e.message || 'Errore di lettura');
    }
    pk.loading = false;
    show(folderView());
  }

  function openProvider(p) {
    pk.prov = p; pk.stack = []; pk.items = null;
    loadFolder();
  }

  function addSource(src) {
    sources.push(Object.assign({ id: uid(), enabled: true }, src));
    save();
    app().closeSheet();
    app().render();
    app().refreshCatalog();
  }

  async function* walkDir(dir, path) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') yield { file: await h.getFile(), path };
      else if (!isArchive(name)) yield* walkDir(h, path.concat(name));
    }
  }
  async function importInto(name, entries, existingId) {
    let src = existingId && sources.find(s => s.id === existingId);
    if (!src && name === 'File importati') src = sources.find(s => s.type === 'local' && s.name === name);
    if (!src) { src = { id: uid(), type: 'local', name, enabled: true }; sources.push(src); save(); }
    app().closeSheet();
    app().toast('Importazione in corso…');
    const n = await importLocal(src.id, entries);
    if (!n && !localFiles.some(f => f.sourceId === src.id)) { sources = sources.filter(s => s !== src); save(); }
    app().toast(n ? `${n} file importati in “${src.name}”` : 'Nessun file audio, video o PDF trovato');
    app().render();
    app().refreshCatalog();
  }

  let importTarget = null;
  function pickFiles(existingId) {
    importTarget = existingId || null;
    const input = document.getElementById('src-file');
    input.value = ''; input.click();
  }
  function pickDir() {
    const input = document.getElementById('src-dir');
    input.value = ''; input.click();
  }
  function askLinks(current) {
    const txt = prompt('Indirizzi di file audio (https://…mp3) o playlist .m3u, separati da ;\nPer dare un titolo: Titolo | https://…',
      (current || []).join(' ; '));
    if (txt == null) return null;
    return txt.split(/\s*[;\n]\s*/).map(x => x.trim()).filter(Boolean);
  }
  function changed() { save(); app().render(); }

  // ---------- eventi ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-action^="src-"]');
    if (!t) return;
    const a = t.dataset.action;
    const s = sources.find(x => x.id === t.dataset.id);
    const prov = t.dataset.p ? PR.get(t.dataset.p) : null;
    try {
      // l'accesso va avviato subito, dentro il tap (le finestre di login lo richiedono)
      if (a === 'src-login' && prov) {
        prov.signIn().then(() => { app().toast('Collegato a ' + prov.label); app().render(); app().refreshCatalog(); }).catch(e => app().toast(e.message));
        return;
      }
      if (a === 'src-pick-prov' && prov) {
        if (!prov.configured()) {
          show(messageView(prov.label, `<p>Per usare ${prov.label} serve una registrazione gratuita dell'app sul sito del servizio, da fare una sola volta. I passaggi sono nel README, sezione <b>${prov.label}</b>.</p>`));
          return;
        }
        if (!prov.isSignedIn()) {
          const p = prov.signIn();
          show(messageView(prov.label, '<p class="empty-row">Accesso in corso nella finestra di ' + esc(prov.label) + '…</p>'));
          p.then(() => openProvider(prov)).catch(e => show(messageView(prov.label, `<p class="empty-row">${esc(e.message)}</p>`)));
          return;
        }
        openProvider(prov);
        return;
      }
      if (a === 'src-add') { pk.prov = null; show(addMenu()); return; }
      if (a === 'src-pk-open') { pk.stack.push(pk.items[Number(t.dataset.i)]); loadFolder(); return; }
      if (a === 'src-pk-crumb') { pk.stack = pk.stack.slice(0, Number(t.dataset.i)); if (!pk.stack.length && pk.prov.roots().length === 1) { show(addMenu()); return; } loadFolder(); return; }
      if (a === 'src-pk-use') {
        const cur = pk.stack[pk.stack.length - 1];
        if (!cur || cur.virtual) return;
        const name = prompt('Nome da mostrare nell\'app', cur.name) || cur.name;
        addSource({ type: 'cloud', provider: pk.prov.id, folderId: cur.id, name, path: pk.stack.filter(f => !f.virtual).map(f => f.name) });
        return;
      }
      if (a === 'src-pick-local') {
        if (hasDirPicker()) {
          show(messageView('File del dispositivo', `<div class="pick-list">
            <button class="pick-opt" data-action="src-local-dir"><span class="prov-ico">📁</span><span class="pick-txt"><b>Scegli una cartella</b><small>importa tutti i brani della cartella e delle sottocartelle</small></span><span class="pick-arrow">›</span></button>
            <button class="pick-opt" data-action="src-local-files"><span class="prov-ico">🎵</span><span class="pick-txt"><b>Scegli dei file</b><small>uno o più file audio, video o PDF</small></span><span class="pick-arrow">›</span></button></div>`));
          return;
        }
        if (!isIOS()) {
          show(messageView('File del dispositivo', `<div class="pick-list">
            <button class="pick-opt" data-action="src-local-dir-input"><span class="prov-ico">📁</span><span class="pick-txt"><b>Scegli una cartella</b><small>importa tutti i brani della cartella</small></span><span class="pick-arrow">›</span></button>
            <button class="pick-opt" data-action="src-local-files"><span class="prov-ico">🎵</span><span class="pick-txt"><b>Scegli dei file</b><small>uno o più file audio, video o PDF</small></span><span class="pick-arrow">›</span></button></div>`));
          return;
        }
        pickFiles(); return;
      }
      if (a === 'src-local-files') { pickFiles(); return; }
      if (a === 'src-local-dir-input') { pickDir(); return; }
      if (a === 'src-local-dir') {
        const dir = await root.showDirectoryPicker({ mode: 'read' });
        const entries = [];
        for await (const e of walkDir(dir, [])) entries.push(e);
        await importInto(dir.name, entries);
        return;
      }
      if (a === 'src-pick-icloud') {
        show(messageView('iCloud Drive', `<p>Apple non consente alle app web di sfogliare iCloud Drive direttamente.</p>
          <p>Puoi però scegliere i file da iCloud con l'app File: tocca il pulsante qui sotto, poi <b>Sfoglia → iCloud Drive</b>, apri la cartella e seleziona i brani (tocca <b>Seleziona</b> in alto per sceglierne più di uno).</p>
          <button class="btn wide" data-action="src-local-files">Scegli file da iCloud Drive</button>`));
        return;
      }
      if (a === 'src-pick-links') {
        const links = askLinks([]);
        if (!links || !links.length) return;
        const name = prompt('Nome da mostrare nell\'app', 'Link online') || 'Link online';
        addSource({ type: 'links', name, links });
        return;
      }
      if (a === 'src-logout' && prov) { prov.signOut(); app().render(); return; }
      if (a === 'src-toggle' && s) { s.enabled = s.enabled === false; changed(); app().refreshCatalog(); return; }
      if (a === 'src-rename' && s) { const n = prompt('Nome della sorgente', s.name); if (n) { s.name = n.trim(); changed(); app().refreshCatalog(); } return; }
      if (a === 'src-del' && s) {
        if (!confirm(`Togliere "${s.name}" dalla libreria?` + (s.type === 'local' ? '\nI file importati verranno eliminati dall\'app.' : ''))) return;
        if (s.type === 'local') await removeLocalOf(s.id);
        sources = sources.filter(x => x !== s); changed(); app().refreshCatalog();
        return;
      }
      if (a === 'src-edit-links' && s) { const links = askLinks(s.links); if (links) { s.links = links; changed(); app().refreshCatalog(); } return; }
      if (a === 'src-import' && s) { pickFiles(s.id); return; }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // selezione annullata
      app().toast(e.message || 'Errore');
    }
  });

  document.addEventListener('change', async (ev) => {
    const id = ev.target.id;
    if (id !== 'src-file' && id !== 'src-dir') return;
    const files = [...(ev.target.files || [])];
    if (!files.length) return;
    try {
      if (id === 'src-dir') {
        const top = (files[0].webkitRelativePath || '').split('/')[0] || 'Cartella importata';
        const entries = files
          .map(f => ({ file: f, path: (f.webkitRelativePath || f.name).split('/').slice(1, -1) }))
          .filter(e => !e.path.some(isArchive));
        await importInto(top, entries);
      } else {
        await importInto('File importati', files.map(f => ({ file: f, path: [] })), importTarget);
      }
    } catch (e) { app().toast('Importazione non riuscita: spazio esaurito?'); }
  });

  root.CoroSources = { enabled, hasDrive, scanAll, card, accountsCard, loginBanner, download, importLocal };
})(window);
