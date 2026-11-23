// Coro Player — logica dell'app
(function () {
  'use strict';
  const CFG = window.CORO_CONFIG;
  const P = window.CoroParser;
  const VOICES = CFG.VOICES;
  const VOICE_LABEL = { primi: 'Primi', secondi: 'Secondi', baritoni: 'Baritoni', bassi: 'Bassi', tutti: 'Tutti' };
  const vlabel = v => VOICE_LABEL[v] || (v.charAt(0).toUpperCase() + v.slice(1));
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Persistenza leggera ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Memoria piena: impossibile salvare.'); } }
  };

  // ---------- IndexedDB per i file offline ----------
  const idb = (() => {
    let dbp = null;
    function db() {
      if (!dbp) dbp = new Promise((res, rej) => {
        const r = indexedDB.open('coro-player', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    async function tx(mode, fn) {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction('files', mode);
        const st = t.objectStore('files');
        const out = fn(st);
        t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      get: id => tx('readonly', st => st.get(id)),
      put: (id, val) => tx('readwrite', st => st.put(val, id)),
      keys: () => tx('readonly', st => st.getAllKeys()),
      clear: () => tx('readwrite', st => st.clear()),
      clearDownloads: async () => {
        const keys = await tx('readonly', st => st.getAllKeys());
        const del = keys.filter(k => !String(k).startsWith('local:'));
        if (del.length) await tx('readwrite', st => del.forEach(k => st.delete(k)));
      }
    };
  })();

  // ---------- Stato ----------
  const state = {
    catalog: store.get('coro.catalog', null),
    playlists: store.get('coro.playlists', []),
    settings: Object.assign({ myVoice: 'tutti' }, store.get('coro.settings', {})),
    view: 'library',
    search: '',
    collection: '',
    openPlaylistId: null,
    offline: new Set(),
    refreshing: false
  };
  const saveSettings = () => store.set('coro.settings', state.settings);
  const savePlaylists = () => store.set('coro.playlists', state.playlists);
  const songById = id => state.catalog && state.catalog.songs.find(s => s.id === id);

  // ---------- Catalogo ----------
  function collectionLabel(name) {
    if (/^[A-Za-z]$/.test(name.trim())) return 'Repertorio';
    return name.replace(/^\s*-\s*/, '').trim();
  }
  const isFolder = f => f.mimeType === Drive.FOLDER;
  const isArchive = f => /^archivio$/i.test(f.name.trim());

  async function refreshCatalog() {
    if (state.refreshing) return;
    state.refreshing = true;
    render();
    try {
      const prev = state.catalog ? state.catalog.songs : [];
      const { songs, problems } = await CoroSources.scanAll(prev, setProgress);
      songs.sort((a, b) => a.title.localeCompare(b.title, 'it') || a.arranger.localeCompare(b.arranger, 'it'));
      // riduce i campi salvati
      const slim = t => t && { id: t.id, name: t.name, kind: t.kind, voice: t.voice, version: t.version, size: t.size, origin: t.origin, url: t.url };
      for (const s of songs) {
        for (const v of Object.keys(s.tracks)) s.tracks[v] = slim(s.tracks[v]);
        for (const v of Object.keys(s.videos)) s.videos[v] = slim(s.videos[v]);
        s.pdf = slim(s.pdf);
      }
      state.catalog = { updated: new Date().toISOString(), songs };
      store.set('coro.catalog', state.catalog);
      if (problems.length) toast('Non aggiornate: ' + problems.join(' · '));
      else toast(`Catalogo aggiornato: ${songs.length} brani`);
    } catch (e) {
      handleError(e);
    } finally {
      state.refreshing = false;
      setProgress('');
      render();
    }
  }

  function setProgress(text) {
    const el = $('#progress');
    if (el) { el.textContent = text; el.hidden = !text; }
  }

  // ---------- File offline ----------
  async function loadOfflineIndex() {
    try { state.offline = new Set(await idb.keys()); } catch (e) { state.offline = new Set(); }
  }
  async function getBlob(file) {
    const cached = await idb.get(file.id).catch(() => null);
    if (cached && cached.blob) return cached.blob;
    if (file.origin === 'local') throw new Error('File non più presente sul dispositivo: importalo di nuovo.');
    let blob;
    if (file.origin === 'url') {
      const r = await fetch(file.url);
      if (!r.ok) throw new Error('Link non raggiungibile');
      blob = await r.blob();
    } else blob = await Drive.download(file.id);
    try {
      await idb.put(file.id, { blob, name: file.name, savedAt: Date.now() });
      state.offline.add(file.id);
    } catch (e) { /* spazio esaurito: si suona comunque */ }
    return blob;
  }
  async function downloadSong(song) {
    const files = Object.values(song.tracks).concat(song.pdf ? [song.pdf] : []);
    let n = 0;
    for (const f of files) {
      if (state.offline.has(f.id)) { n++; continue; }
      setProgress(`Scarico ${song.title}: ${n + 1}/${files.length}`);
      await getBlob(f);
      n++;
    }
    setProgress('');
    toast('Disponibile offline');
    render();
  }
  const songOffline = s => Object.values(s.tracks).every(t => state.offline.has(t.id));

  // ---------- Player ----------
  const audio = $('#audio');
  const video = $('#video');
  const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  let unlocked = false;
  let unlockDone = Promise.resolve();
  // iOS consente play() programmatico solo dopo un primo play() dentro un tap.
  // Va chiamata in modo sincrono dentro il tap; playItem attende che finisca.
  function unlockMedia() {
    if (unlocked) return;
    unlocked = true;
    const ps = [audio, video].map(el => {
      try {
        el.muted = true;
        el.src = SILENT;
        const p = el.play() || Promise.resolve();
        return p.catch(() => {}).then(() => { el.pause(); el.muted = false; });
      } catch (e) { el.muted = false; return Promise.resolve(); }
    });
    const timeout = new Promise(r => setTimeout(r, 800));
    unlockDone = Promise.race([Promise.all(ps), timeout]).then(() => { audio.muted = false; video.muted = false; });
  }

  const player = {
    queue: [], index: -1, el: audio, objectUrl: null,
    item: null, song: null, voice: null, track: null,
    rate: store.get('coro.rate', 1), loopA: null, loopB: null, loading: false, token: 0,
    boost: store.get('coro.boost', 'off'), gainDb: null, boostNote: ''
  };

  function currentEl() { return player.el; }

  // ---------- Volume oltre il 100% ----------
  // L'mp3 viene decodificato, amplificato (con limitatore morbido contro la distorsione)
  // e riprodotto come WAV: resta un normale <audio>, quindi funziona anche a schermo bloccato.
  const BOOSTS = [['off', 'Originale'], ['auto', 'Auto'], ['1.5', '×1,5'], ['2', '×2'], ['3', '×3']];
  async function boostBlob(blob, mode) {
    const buf = await blob.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, 44100);
    const audioBuf = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
    const nch = audioBuf.numberOfChannels, len = audioBuf.length;
    const chans = [];
    let peak = 0;
    for (let c = 0; c < nch; c++) {
      const d = audioBuf.getChannelData(c);
      chans.push(d);
      for (let i = 0; i < len; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    }
    if (peak < 1e-4) peak = 1e-4;
    const gain = mode === 'auto' ? Math.min(0.97 / peak, 16) : Number(mode);
    const K = 0.85; // sopra questa soglia il limitatore comprime dolcemente
    const shape = x => {
      const y = x * gain, a = Math.abs(y);
      if (a <= K) return y;
      return Math.sign(y) * (K + (1 - K) * Math.tanh((a - K) / (1 - K)));
    };
    // WAV 16 bit
    const bytes = 44 + len * nch * 2;
    const out = new ArrayBuffer(bytes);
    const v = new DataView(out);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    const sr = audioBuf.sampleRate;
    w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, len * nch * 2, true);
    let o = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nch; c++) {
        const x = Math.max(-1, Math.min(1, shape(chans[c][i])));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
    }
    return { blob: new Blob([out], { type: 'audio/wav' }), gainDb: 20 * Math.log10(gain) };
  }

  function setBoost(mode) {
    player.boost = mode;
    store.set('coro.boost', mode);
    if (!player.item) { renderPlayer(); return; }
    const el = currentEl();
    playItem(player.item, { startAt: el.currentTime || 0, keepLoop: true, autoplay: !el.paused || player.loading });
  }

  function setQueue(items, startIndex) {
    player.queue = items.slice();
    player.index = startIndex || 0;
    return playIndex(player.index, {});
  }

  async function playIndex(i, opts) {
    if (i < 0 || i >= player.queue.length) return;
    player.index = i;
    await playItem(player.queue[i], opts);
  }

  async function playItem(item, opts) {
    opts = opts || {};
    const my = ++player.token;
    const other = player.el;
    player.item = item;
    player.loading = true;
    if (!opts.keepLoop) { player.loopA = null; player.loopB = null; }
    renderPlayer();
    let src, el, title, subtitle;
    try {
      player.gainDb = null; player.boostNote = '';
      if (item.type === 'url') {
        el = /\.(mov|mp4|m4v)(\?|$)/i.test(item.url) ? video : audio;
        src = item.url;
        player.song = null; player.voice = null; player.track = null;
        title = item.title || item.url; subtitle = 'Link';
        if (player.boost !== 'off' && el === audio) {
          try {
            renderPlayer();
            const r = await fetch(item.url);
            if (!r.ok) throw new Error();
            const b = await boostBlob(await r.blob(), player.boost);
            if (my !== player.token) return;
            if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
            player.objectUrl = URL.createObjectURL(b.blob);
            src = player.objectUrl; player.gainDb = b.gainDb;
          } catch (e) {
            player.boostNote = 'Questo link non permette di alzare il volume';
          }
        }
      } else {
        const song = songById(item.songId);
        if (!song) throw new Error('Brano non più presente nel catalogo.');
        let voice = item.voice || state.settings.myVoice;
        if (!song.tracks[voice]) voice = song.tracks.tutti ? 'tutti' : Object.keys(song.tracks)[0];
        if (!voice) throw new Error('Nessun audio per questo brano.');
        const track = song.tracks[voice];
        player.song = song; player.voice = voice; player.track = track;
        el = track.kind === 'video' ? video : audio;
        renderPlayer();
        let blob = null;
        if (track.origin === 'url' && !state.offline.has(track.id)) {
          // link online: si ascolta in streaming; si scarica solo se serve alzare il volume
          if (player.boost !== 'off' && track.kind === 'audio') {
            try { blob = await getBlob(track); } catch (e) { player.boostNote = 'Questo link non permette di alzare il volume'; }
          }
        } else blob = await getBlob(track);
        if (my !== player.token) return;
        if (!blob) {
          src = track.url;
        } else {
          if (player.boost !== 'off') {
            if (track.kind === 'audio') {
              try {
                const b = await boostBlob(blob, player.boost);
                blob = b.blob; player.gainDb = b.gainDb;
              } catch (e) { player.boostNote = 'Impossibile alzare il volume di questo file'; }
              if (my !== player.token) return;
            } else {
              player.boostNote = 'Per i video il volume resta quello originale';
            }
          }
          if (player.objectUrl) URL.revokeObjectURL(player.objectUrl);
          player.objectUrl = URL.createObjectURL(blob);
          src = player.objectUrl;
        }
        title = song.title; subtitle = vlabel(voice) + (song.arranger ? ' · ' + song.arranger : '');
      }
      await unlockDone;
      if (my !== player.token) return;
      if (other && other !== el) other.pause();
      player.el = el;
      el.src = src;
      el.playbackRate = player.rate;
      el.defaultPlaybackRate = player.rate;
      setPitch(el);
      await new Promise((res) => {
        if (el.readyState >= 1 && el.currentSrc === src) { res(); return; }
        const done = () => {
          if (el.currentSrc && el.currentSrc !== src) return; // evento di una sorgente precedente
          el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); res();
        };
        el.addEventListener('loadedmetadata', done);
        el.addEventListener('error', done);
      });
      if (my !== player.token) return;
      if (opts.startAt) { try { el.currentTime = Math.min(opts.startAt, (el.duration || opts.startAt) - 0.2); } catch (e) { /* ignore */ } }
      el.playbackRate = player.rate;
      player.loading = false;
      updateMediaSession(title, subtitle);
      if (opts.autoplay !== false) await el.play().catch(() => toast('Tocca ▶ per avviare'));
    } catch (e) {
      player.loading = false;
      handleError(e);
    }
    renderPlayer();
  }

  function setPitch(el) {
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
  }

  function switchVoice(voice) {
    if (!player.song || !player.song.tracks[voice]) return;
    const el = currentEl();
    const t = el.currentTime || 0;
    const wasPlaying = !el.paused;
    const item = Object.assign({}, player.item, { voice });
    player.queue[player.index] = item;
    playItem(item, { startAt: t, keepLoop: true, autoplay: wasPlaying || player.loading });
  }

  function togglePlay() {
    const el = currentEl();
    if (!el.src || el.src === SILENT) return;
    if (el.paused) el.play().catch(() => {}); else el.pause();
  }
  function seekBy(d) {
    const el = currentEl();
    if (!isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration - 0.1, el.currentTime + d));
  }
  function setRate(r) {
    player.rate = Math.round(r * 100) / 100;
    store.set('coro.rate', player.rate);
    const el = currentEl();
    el.playbackRate = player.rate; el.defaultPlaybackRate = player.rate; setPitch(el);
    renderPlayer();
  }
  function next() { if (player.index < player.queue.length - 1) playIndex(player.index + 1, {}); }
  function prev() {
    const el = currentEl();
    if (el.currentTime > 3 || player.index === 0) { el.currentTime = player.loopA || 0; return; }
    playIndex(player.index - 1, {});
  }

  function onTime() {
    const el = currentEl();
    if (player.loopB != null && player.loopA != null && el.currentTime >= player.loopB) {
      el.currentTime = player.loopA;
    }
    updateProgress();
  }
  for (const el of [audio, video]) {
    el.addEventListener('timeupdate', () => { if (el === player.el) onTime(); });
    el.addEventListener('play', () => { if (el === player.el) renderPlayer(); });
    el.addEventListener('pause', () => { if (el === player.el) renderPlayer(); });
    el.addEventListener('ended', () => {
      if (el !== player.el) return;
      if (player.loopA != null && player.loopB != null) { el.currentTime = player.loopA; el.play(); return; }
      next();
    });
  }

  function updateMediaSession(title, artist) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title, artist, album: CFG.APP_NAME,
        artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }]
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => currentEl().play());
      ms.setActionHandler('pause', () => currentEl().pause());
      ms.setActionHandler('seekbackward', () => seekBy(-10));
      ms.setActionHandler('seekforward', () => seekBy(10));
      ms.setActionHandler('previoustrack', prev);
      ms.setActionHandler('nexttrack', next);
      try { ms.setActionHandler('seekto', d => { currentEl().currentTime = d.seekTime; }); } catch (e) { /* non supportato */ }
    } catch (e) { /* ignore */ }
  }

  function fmtVersion(v) {
    const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(.*)$/);
    if (!m) return v || '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return 'versione del ' + d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }) + (m[4] ? ' (' + m[4] + ')' : '');
  }

  const fmt = s => {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // ---------- Errori e messaggi ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function handleError(e) {
    console.error(e);
    if (e && e.needLogin) { toast('Accedi a Google (Impostazioni) per scaricare i brani.'); render(); return; }
    toast((e && e.message) || 'Si è verificato un errore');
  }

  // ---------- Viste ----------
  function render() {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
    const main = $('#main');
    if (state.view === 'library') main.innerHTML = viewLibrary();
    else if (state.view === 'playlists') main.innerHTML = state.openPlaylistId ? viewPlaylist() : viewPlaylists();
    else main.innerHTML = viewSettings();
    renderPlayer();
  }

  function loginBanner() {
    if (!CoroSources.hasDrive()) return '';
    if (!Drive.isConfigured()) {
      return `<div class="banner warn"><span>Manca l'ID client Google in <b>config.js</b>. Segui il README per configurarlo.</span></div>`;
    }
    if (!Drive.isSignedIn()) {
      return `<div class="banner"><span>Per aggiornare il catalogo e scaricare nuovi brani accedi a Google.</span>
        <button class="btn small" data-action="signin">Accedi</button></div>`;
    }
    return '';
  }

  function filteredSongs() {
    const q = state.search.trim().toLowerCase();
    return state.catalog.songs.filter(s =>
      (!state.collection || s.collection === state.collection) &&
      (!q || (s.title + ' ' + s.arranger).toLowerCase().includes(q)));
  }

  function viewLibrary() {
    if (!state.catalog) {
      return `${loginBanner()}
        <div class="empty">
          <h2>Benvenuto</h2>
          <p>L'app raccoglie i brani dalle sorgenti indicate in <b>Impostazioni → Sorgenti della libreria</b>: cartelle Google Drive, link online e file del dispositivo.</p>
          <button class="btn" data-action="refresh" ${state.refreshing ? 'disabled' : ''}>Carica il catalogo</button>
        </div>`;
    }
    const cols = [...new Set(state.catalog.songs.map(s => s.collection))];
    const songs = filteredSongs();
    let lastLetter = '';
    const rows = songs.map(s => {
      const letter = s.title.charAt(0).toUpperCase();
      const head = letter !== lastLetter ? `<li class="letter">${esc(letter)}</li>` : '';
      lastLetter = letter;
      const has = s.tracks[state.settings.myVoice] || Object.keys(s.tracks).length < 2 ? '' : '<span class="tag dim">no ' + esc(vlabel(state.settings.myVoice)) + '</span>';
      return `${head}<li class="song" data-action="open-song" data-id="${esc(s.id)}">
        <div class="song-main"><div class="song-title">${esc(s.title)}</div>
        <div class="song-sub">${esc([s.arranger, s.collection !== 'Repertorio' ? s.collection : ''].filter(Boolean).join(' · '))}</div></div>
        <div class="song-side">${has}${songOffline(s) ? '<span class="dot" title="Offline">●</span>' : ''}</div></li>`;
    }).join('');
    return `${loginBanner()}
      <div class="searchbar"><input id="search" type="search" placeholder="Cerca titolo o armonizzatore" value="${esc(state.search)}" autocomplete="off"></div>
      <div class="chips">
        <button class="chip ${!state.collection ? 'on' : ''}" data-action="collection" data-c="">Tutti</button>
        ${cols.map(c => `<button class="chip ${state.collection === c ? 'on' : ''}" data-action="collection" data-c="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      <ul class="list">${rows || '<li class="empty-row">Nessun brano trovato</li>'}</ul>`;
  }

  function viewPlaylists() {
    const rows = state.playlists.map(p => `<li class="song" data-action="open-playlist" data-id="${esc(p.id)}">
      <div class="song-main"><div class="song-title">${esc(p.name)}</div><div class="song-sub">${p.items.length} brani</div></div>
      <div class="song-side">›</div></li>`).join('');
    return `<div class="toolbar"><h2>Playlist</h2><button class="btn small" data-action="new-playlist">+ Nuova</button></div>
      <ul class="list">${rows || '<li class="empty-row">Nessuna playlist. Creane una, poi aggiungi brani dalla scheda di ogni canto.</li>'}</ul>`;
  }

  function itemLabel(it) {
    if (it.type === 'url') return { t: it.title || it.url, s: 'Link' };
    const s = songById(it.songId);
    return { t: s ? s.title : '(brano non trovato)', s: (it.voice ? vlabel(it.voice) : 'La mia voce') + (s && s.arranger ? ' · ' + s.arranger : '') };
  }

  function viewPlaylist() {
    const p = state.playlists.find(x => x.id === state.openPlaylistId);
    if (!p) { state.openPlaylistId = null; return viewPlaylists(); }
    const rows = p.items.map((it, i) => {
      const l = itemLabel(it);
      const playing = state.playingPlaylistId === p.id && player.index === i;
      return `<li class="song ${playing ? 'playing' : ''}">
        <div class="song-main" data-action="play-playlist" data-i="${i}"><div class="song-title">${esc(l.t)}</div><div class="song-sub">${esc(l.s)}</div></div>
        <div class="row-actions">
          <button class="icon" data-action="pl-up" data-i="${i}" aria-label="Su">↑</button>
          <button class="icon" data-action="pl-down" data-i="${i}" aria-label="Giù">↓</button>
          <button class="icon" data-action="pl-del" data-i="${i}" aria-label="Rimuovi">✕</button>
        </div></li>`;
    }).join('');
    return `<div class="toolbar"><button class="link" data-action="back-playlists">‹ Playlist</button>
        <button class="link danger" data-action="del-playlist">Elimina</button></div>
      <h2 class="pl-title">${esc(p.name)}</h2>
      <div class="actions-row">
        <button class="btn" data-action="play-playlist" data-i="0" ${p.items.length ? '' : 'disabled'}>▶ Riproduci</button>
        <button class="btn ghost" data-action="pl-add-url">+ Link audio</button>
        <button class="btn ghost" data-action="pl-rename">Rinomina</button>
      </div>
      <ul class="list">${rows || '<li class="empty-row">Playlist vuota</li>'}</ul>`;
  }

  function viewSettings() {
    const c = state.catalog;
    return `<h2>Impostazioni</h2>
      <section class="card">
        <label class="lbl">La mia voce</label>
        <div class="chips wrap">${VOICES.map(v => `<button class="chip ${state.settings.myVoice === v ? 'on' : ''}" data-action="set-voice" data-v="${v}">${vlabel(v)}</button>`).join('')}</div>
      </section>
      ${CoroSources.card()}
      <section class="card">
        <label class="lbl">Account Google</label>
        <p>${Drive.apiKeyMode() ? 'Accesso tramite chiave API (cartella pubblica).' : Drive.isSignedIn() ? 'Connesso.' : 'Non connesso.'}</p>
        ${Drive.apiKeyMode() ? '' : Drive.isSignedIn()
          ? '<button class="btn ghost" data-action="signout">Esci</button>'
          : `<button class="btn" data-action="signin" ${Drive.isConfigured() ? '' : 'disabled'}>Accedi con Google</button>`}
      </section>
      <section class="card">
        <label class="lbl">Catalogo</label>
        <p>${c ? `${c.songs.length} brani · aggiornato il ${new Date(c.updated).toLocaleString('it-IT')}` : 'Non ancora caricato.'}</p>
        <button class="btn" data-action="refresh" ${state.refreshing ? 'disabled' : ''}>${state.refreshing ? 'Aggiornamento…' : 'Aggiorna catalogo'}</button>
      </section>
      <section class="card">
        <label class="lbl">Brani offline</label>
        <p id="storage-info">${[...state.offline].filter(k => !String(k).startsWith('local:')).length} file scaricati sul telefono (i file importati dal dispositivo non vengono toccati).</p>
        <button class="btn ghost" data-action="clear-offline">Svuota</button>
      </section>
      <p class="foot">${esc(CFG.APP_NAME)} · v1.2</p>`;
  }

  // ---------- Schede (sheet) ----------
  function openSheet(html) {
    $('#sheet-body').innerHTML = html;
    $('#sheet').hidden = false;
    requestAnimationFrame(() => $('#sheet').classList.add('open'));
  }
  function closeSheet() {
    $('#sheet').classList.remove('open');
    setTimeout(() => { $('#sheet').hidden = true; }, 200);
  }

  function songSheet(song) {
    const voices = VOICES.filter(v => song.tracks[v]).concat(Object.keys(song.tracks).filter(v => !VOICES.includes(v)));
    const my = state.settings.myVoice;
    const pls = state.playlists.map(p => `<button class="chip" data-action="add-to-pl" data-pl="${esc(p.id)}" data-song="${esc(song.id)}">${esc(p.name)}</button>`).join('');
    return `<h3>${esc(song.title)}</h3>
      <p class="sub">${song.arranger ? `<span class="cap">${esc(song.arranger)}</span>` : ''}${song.arranger && song.version ? ' · ' : ''}${esc(fmtVersion(song.version))}</p>
      ${song.tracks[my] ? `<button class="btn wide" data-action="play-song" data-id="${esc(song.id)}" data-v="${my}">▶ ${esc(vlabel(my))} (la mia voce)</button>` : ''}
      <label class="lbl">Voci</label>
      <div class="chips wrap">${voices.map(v => `<button class="chip" data-action="play-song" data-id="${esc(song.id)}" data-v="${v}">▶ ${esc(vlabel(v))}${song.tracks[v].kind === 'video' ? ' 🎬' : ''}</button>`).join('')}</div>
      <div class="actions-row">
        ${song.pdf ? `<button class="btn ghost" data-action="open-pdf" data-id="${esc(song.id)}">Spartito PDF</button>` : ''}
        <button class="btn ghost" data-action="download-song" data-id="${esc(song.id)}">${songOffline(song) ? '✓ Offline' : 'Scarica offline'}</button>
      </div>
      <label class="lbl">Aggiungi a playlist</label>
      <div class="chips wrap">${pls}<button class="chip" data-action="add-to-new-pl" data-song="${esc(song.id)}">+ Nuova</button></div>`;
  }

  // ---------- Player UI ----------
  function renderPlayer() {
    const bar = $('#mini');
    const has = !!player.item;
    bar.hidden = !has;
    document.body.classList.toggle('has-player', has);
    if (!has) return;
    const el = currentEl();
    const l = itemLabel(player.item);
    const sub = player.song ? vlabel(player.voice) + (player.song.arranger ? ' · ' + player.song.arranger : '') : l.s;
    $('#mini-title').textContent = l.t;
    $('#mini-sub').textContent = player.loading ? 'Caricamento…' : sub;
    $('#mini-play').textContent = el.paused ? '▶' : '❚❚';

    const full = $('#player');
    if (full.hidden) return;
    $('#p-title').textContent = l.t;
    $('#p-sub').textContent = player.loading ? 'Caricamento…' : sub;
    $('#p-play').textContent = el.paused ? '▶' : '❚❚';
    $('#p-rate').value = player.rate;
    $('#p-rate-val').textContent = Math.round(player.rate * 100) + '%';
    const voices = player.song ? VOICES.filter(v => player.song.tracks[v]) : [];
    $('#p-voices').innerHTML = voices.map(v => `<button class="chip ${v === player.voice ? 'on' : ''}" data-action="switch-voice" data-v="${v}">${esc(vlabel(v))}</button>`).join('');
    $('#p-voices').hidden = !voices.length;
    $('#p-pdf').hidden = !(player.song && player.song.pdf);
    $('#p-a').classList.toggle('on', player.loopA != null);
    $('#p-b').classList.toggle('on', player.loopB != null);
    $('#p-loop-info').textContent = player.loopA != null
      ? `Ripeti ${fmt(player.loopA)} → ${player.loopB != null ? fmt(player.loopB) : '…'}` : '';
    $('#video-wrap').hidden = player.el !== video;
    $('#p-boost').innerHTML = BOOSTS.map(([k, l]) => `<button class="chip ${player.boost === k ? 'on' : ''}" data-action="boost" data-b="${k}">${l}</button>`).join('');
    $('#p-boost-val').textContent = player.boostNote ? player.boostNote
      : player.boost === 'off' ? 'come registrato'
      : player.gainDb != null ? (player.gainDb >= 0 ? '+' : '') + player.gainDb.toFixed(1).replace('.', ',') + ' dB' : '';
    updateProgress();
  }

  function updateProgress() {
    const el = currentEl();
    const d = el.duration, t = el.currentTime;
    const pct = isFinite(d) && d > 0 ? (t / d) * 100 : 0;
    $('#mini-progress').style.width = pct + '%';
    if ($('#player').hidden) return;
    const seek = $('#p-seek');
    if (!seek._dragging) seek.value = isFinite(d) && d > 0 ? (t / d) * 1000 : 0;
    $('#p-cur').textContent = fmt(t);
    $('#p-dur').textContent = fmt(d);
    const marks = $('#p-marks');
    if (isFinite(d) && d > 0 && player.loopA != null) {
      const a = player.loopA / d * 100, b = (player.loopB != null ? player.loopB : t) / d * 100;
      marks.style.left = a + '%'; marks.style.width = Math.max(0.5, b - a) + '%'; marks.hidden = false;
    } else marks.hidden = true;
  }

  function openPlayer() {
    $('#player').hidden = false;
    requestAnimationFrame(() => $('#player').classList.add('open'));
    renderPlayer();
  }
  function closePlayer() {
    $('#player').classList.remove('open');
    setTimeout(() => { $('#player').hidden = true; }, 200);
  }

  async function openPdf(song) {
    if (!song || !song.pdf) return;
    if (navigator.onLine && !state.offline.has(song.pdf.id)) { window.open(Drive.viewUrl(song.pdf.id), '_blank'); return; }
    try {
      const blob = await getBlob(song.pdf);
      const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (e) { handleError(e); }
  }

  // ---------- Playlist ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  function createPlaylist() {
    const name = prompt('Nome della playlist', 'Prossimo concerto');
    if (!name) return null;
    const p = { id: uid(), name: name.trim(), items: [] };
    state.playlists.push(p); savePlaylists();
    return p;
  }

  // ---------- Eventi ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    const d = t.dataset;

    // azioni che devono restare sincrone dentro il tap
    if (a === 'signin') {
      Drive.signIn().then(() => { toast('Accesso effettuato'); render(); if (!state.catalog) refreshCatalog(); }).catch(handleError);
      return;
    }
    if (['play-song', 'play-playlist', 'mini-play', 'p-play', 'switch-voice', 'p-next', 'p-prev'].includes(a)) unlockMedia();

    switch (a) {
      case 'tab': state.view = d.view; state.openPlaylistId = null; render(); window.scrollTo(0, 0); break;
      case 'refresh': refreshCatalog(); break;
      case 'signout': Drive.signOut(); render(); break;
      case 'collection': state.collection = d.c; render(); break;
      case 'open-song': { const s = songById(d.id); if (s) openSheet(songSheet(s)); break; }
      case 'play-song': {
        closeSheet();
        state.playingPlaylistId = null;
        setQueue([{ type: 'song', songId: d.id, voice: d.v }], 0);
        break;
      }
      case 'open-pdf': openPdf(songById(d.id)); break;
      case 'download-song': { const s = songById(d.id); if (s) downloadSong(s).then(() => openSheet(songSheet(s))).catch(handleError); break; }
      case 'add-to-pl': {
        const p = state.playlists.find(x => x.id === d.pl);
        if (p) { p.items.push({ type: 'song', songId: d.song, voice: null }); savePlaylists(); toast('Aggiunto a ' + p.name); }
        break;
      }
      case 'add-to-new-pl': {
        const p = createPlaylist();
        if (p) { p.items.push({ type: 'song', songId: d.song, voice: null }); savePlaylists(); toast('Aggiunto a ' + p.name); const s = songById(d.song); if (s) openSheet(songSheet(s)); }
        break;
      }
      case 'new-playlist': if (createPlaylist()) render(); break;
      case 'open-playlist': state.openPlaylistId = d.id; render(); break;
      case 'back-playlists': state.openPlaylistId = null; render(); break;
      case 'play-playlist': {
        const p = state.playlists.find(x => x.id === state.openPlaylistId);
        if (!p || !p.items.length) break;
        state.playingPlaylistId = p.id;
        setQueue(p.items, Number(d.i) || 0).then(render);
        break;
      }
      case 'pl-up': case 'pl-down': case 'pl-del': {
        const p = state.playlists.find(x => x.id === state.openPlaylistId);
        const i = Number(d.i);
        if (!p) break;
        if (a === 'pl-del') p.items.splice(i, 1);
        else {
          const j = a === 'pl-up' ? i - 1 : i + 1;
          if (j >= 0 && j < p.items.length) [p.items[i], p.items[j]] = [p.items[j], p.items[i]];
        }
        savePlaylists(); render(); break;
      }
      case 'pl-add-url': {
        const p = state.playlists.find(x => x.id === state.openPlaylistId);
        const url = p && prompt('Indirizzo del file audio (https://…mp3)');
        if (!url) break;
        if (!/^https?:\/\//i.test(url)) { toast('Serve un indirizzo che inizi con https://'); break; }
        const title = prompt('Titolo', decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/\.[a-z0-9]+$/i, '')) || url;
        p.items.push({ type: 'url', url: url.trim(), title: title.trim() }); savePlaylists(); render(); break;
      }
      case 'pl-rename': {
        const p = state.playlists.find(x => x.id === state.openPlaylistId);
        const n = p && prompt('Nuovo nome', p.name);
        if (n) { p.name = n.trim(); savePlaylists(); render(); }
        break;
      }
      case 'del-playlist': {
        const p = state.playlists.find(x => x.id === state.openPlaylistId);
        if (p && confirm(`Eliminare la playlist "${p.name}"?`)) {
          state.playlists = state.playlists.filter(x => x !== p); savePlaylists(); state.openPlaylistId = null; render();
        }
        break;
      }
      case 'set-voice': state.settings.myVoice = d.v; saveSettings(); render(); break;
      case 'clear-offline':
        if (confirm('Eliminare i brani scaricati sul telefono?')) idb.clearDownloads().then(loadOfflineIndex).then(render);
        break;
      case 'close-sheet': closeSheet(); break;
      case 'mini-open': openPlayer(); break;
      case 'mini-play': case 'p-play': togglePlay(); break;
      case 'p-close': closePlayer(); break;
      case 'p-back': seekBy(-10); break;
      case 'p-fwd': seekBy(10); break;
      case 'p-prev': prev(); break;
      case 'p-next': next(); break;
      case 'switch-voice': switchVoice(d.v); break;
      case 'p-a': {
        const el = currentEl();
        player.loopA = el.currentTime;
        if (player.loopB != null && player.loopB <= player.loopA) player.loopB = null;
        renderPlayer(); break;
      }
      case 'p-b': {
        const el = currentEl();
        if (player.loopA == null) { toast('Imposta prima il punto A'); break; }
        if (el.currentTime <= player.loopA + 0.5) { toast('B deve venire dopo A'); break; }
        player.loopB = el.currentTime;
        el.currentTime = player.loopA;
        renderPlayer(); break;
      }
      case 'p-loop-clear': player.loopA = null; player.loopB = null; renderPlayer(); break;
      case 'p-pdf': openPdf(player.song); break;
      case 'boost': setBoost(d.b); break;
      case 'rate-step': setRate(Math.max(0.5, Math.min(1.5, player.rate + Number(d.step)))); break;
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.target.id === 'search') {
      state.search = ev.target.value;
      const main = $('#main');
      const y = window.scrollY;
      main.innerHTML = viewLibrary();
      window.scrollTo(0, y);
      const s = $('#search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length);
    } else if (ev.target.id === 'p-rate') {
      setRate(Number(ev.target.value));
    } else if (ev.target.id === 'p-seek') {
      const el = currentEl();
      if (isFinite(el.duration)) el.currentTime = Number(ev.target.value) / 1000 * el.duration;
    }
  });
  const seek = $('#p-seek');
  seek.addEventListener('pointerdown', () => { seek._dragging = true; });
  seek.addEventListener('pointerup', () => { seek._dragging = false; });
  $('#sheet').addEventListener('click', (ev) => { if (ev.target.id === 'sheet') closeSheet(); });

  window.CoroApp = { render, refreshCatalog, toast };

  // ---------- Avvio ----------
  async function start() {
    await loadOfflineIndex();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.addEventListener('load', () => Drive.initClient());
  }
  start();
})();
