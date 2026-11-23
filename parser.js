// Riconoscimento di brano, voce e versione dai nomi dei file del Drive del coro.
// Gestisce entrambe le convenzioni viste nell'archivio:
//   "monte canino - f gervasi - v20211011revton - primi.mp3"   (tutti = senza voce)
//   "la tradotta - i fozzer - PRIMI v20260706.mp3"             (TUTTI esplicito)
(function (root) {
  const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'];
  const VIDEO_EXT = ['mov', 'mp4', 'm4v'];
  const DEFAULT_VOICES = ['primi', 'secondi', 'baritoni', 'bassi', 'tutti'];

  function voicesList() {
    return (root.CORO_CONFIG && root.CORO_CONFIG.VOICES) || DEFAULT_VOICES;
  }

  function splitExt(name) {
    const m = String(name).match(/^(.*)\.([A-Za-z0-9]+)$/);
    return m ? { base: m[1], ext: m[2].toLowerCase() } : { base: String(name), ext: '' };
  }

  function kindOf(ext, mimeType) {
    if (AUDIO_EXT.includes(ext)) return 'audio';
    if (VIDEO_EXT.includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (mimeType) {
      if (mimeType.startsWith('audio/')) return 'audio';
      if (mimeType.startsWith('video/')) return 'video';
      if (mimeType === 'application/pdf') return 'pdf';
    }
    return null;
  }

  function norm(s) {
    return String(s).toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  // Divide "titolo - armonizzatore" (l'ultimo " - " separa l'armonizzatore)
  function parseSongFolder(folderName) {
    const name = String(folderName).trim();
    const i = name.lastIndexOf(' - ');
    if (i <= 0) return { title: name, arranger: '' };
    return { title: name.slice(0, i).trim(), arranger: name.slice(i + 3).trim() };
  }

  function parseFile(fileName, songFolderName, mimeType) {
    const { base, ext } = splitExt(fileName);
    const kind = kindOf(ext, mimeType);
    let rest = base;
    if (songFolderName) {
      const pref = norm(songFolderName);
      if (norm(base).startsWith(pref)) rest = base.slice(songFolderName.trim().length);
    } else {
      // senza nome cartella: salta "titolo - autore"
      const parts = base.split(' - ');
      rest = parts.length > 2 ? parts.slice(2).join(' - ') : '';
    }
    const vm = rest.match(/(?:^|[\s\-_])v(\d{8})([a-z]*)(?=$|[\s\-_.])/i);
    const versionDate = vm ? vm[1] : '';
    const versionTag = vm ? vm[2].toLowerCase() : '';
    const restNoVersion = vm ? rest.replace(vm[0], ' ') : rest;
    let voice = 'tutti';
    const voices = voicesList();
    const lower = norm(restNoVersion);
    for (const v of voices) {
      const re = new RegExp('(^|[^a-zà-ù])' + v + '($|[^a-zà-ù])', 'i');
      if (re.test(lower)) { voice = v; break; }
    }
    return { kind, ext, voice, versionDate, versionTag, version: versionDate + versionTag };
  }

  function cmpVersion(a, b) {
    // >0 se a è più recente di b
    if (a.versionDate !== b.versionDate) return a.versionDate > b.versionDate ? 1 : -1;
    const ta = a.modifiedTime || '', tb = b.modifiedTime || '';
    if (ta !== tb) return ta > tb ? 1 : -1;
    return 0;
  }

  // files: [{id, name, mimeType, modifiedTime, resourceKey}]
  // Restituisce per ogni voce il file audio (o video se manca l'audio) più recente,
  // il video più recente per voce, il PDF più recente.
  function buildSong(folderName, files) {
    const tracks = {}, videos = {};
    let pdf = null;
    for (const f of files) {
      const p = parseFile(f.name, folderName, f.mimeType);
      if (!p.kind) continue;
      const item = Object.assign({}, f, p);
      if (p.kind === 'pdf') {
        if (!pdf || cmpVersion(item, pdf) > 0) pdf = item;
      } else if (p.kind === 'audio') {
        const cur = tracks[p.voice];
        if (!cur || cur.kind !== 'audio' || cmpVersion(item, cur) > 0) tracks[p.voice] = item;
      } else if (p.kind === 'video') {
        const curV = videos[p.voice];
        if (!curV || cmpVersion(item, curV) > 0) videos[p.voice] = item;
      }
    }
    // se per una voce esiste solo il video, si usa il video come traccia
    for (const v of Object.keys(videos)) {
      if (!tracks[v]) tracks[v] = videos[v];
    }
    const versions = Object.values(tracks).map(t => t.version).filter(Boolean).sort();
    const { title, arranger } = parseSongFolder(folderName);
    return {
      title, arranger, folderName,
      version: versions.length ? versions[versions.length - 1] : '',
      tracks, videos, pdf
    };
  }

  // Raggruppa i file di una cartella in brani.
  // I file che iniziano con il nome della cartella formano un unico brano (caso tipico);
  // gli altri vengono raggruppati per nome, tolti voce e versione (es. una cartella di esercizi).
  function songKey(base) {
    let k = norm(base).replace(/(?:^|[\s\-_])v\d{8}[a-z]*(?=$|[\s\-_.])/i, ' ');
    for (const v of voicesList()) k = k.replace(new RegExp('(^|[^a-zà-ù])' + v + '($|[^a-zà-ù])', 'i'), '$1 $2');
    return k.replace(/[\s\-_]+$/g, '').replace(/^[\s\-_]+/g, '').replace(/\s*-\s*(-\s*)+/g, ' - ').replace(/\s+/g, ' ').trim();
  }
  function groupFiles(folderName, files) {
    const groups = new Map();
    const pref = folderName ? norm(folderName) : '';
    for (const f of files) {
      const { base, ext } = splitExt(f.name);
      if (!kindOf(ext, f.mimeType)) continue;
      const key = pref && norm(base).startsWith(pref) ? '\u0000' : songKey(base) || norm(base);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const out = [];
    for (const [key, list] of groups) {
      if (key === '\u0000') { out.push(Object.assign(buildSong(folderName, list), { key: '' })); continue; }
      // nome leggibile: dal primo file, senza voce e versione
      const { base } = splitExt(list[0].name);
      let name = base.replace(/(?:^|[\s\-_])v\d{8}[a-z]*(?=$|[\s\-_.])/i, ' ');
      for (const v of voicesList()) name = name.replace(new RegExp('(^|[^A-Za-zÀ-ùà-ù])' + v + '($|[^A-Za-zÀ-ùà-ù])', 'i'), '$1 $2');
      name = name.replace(/[\s\-_]+$/g, '').replace(/\s*-\s*(-\s*)+/g, ' - ').replace(/\s+/g, ' ').trim() || base;
      out.push(Object.assign(buildSong(name, list), { key }));
    }
    return out;
  }

  const api = { parseFile, parseSongFolder, buildSong, groupFiles, splitExt, kindOf };
  root.CoroParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
