// Configurazione di Coro Player.
// Compila GOOGLE_CLIENT_ID con l'ID client OAuth creato su Google Cloud (vedi README.md).
window.CORO_CONFIG = {
  // ID client OAuth "Applicazione web" (termina con .apps.googleusercontent.com)
  GOOGLE_CLIENT_ID: '',

  // Facoltativo: se un giorno la cartella sarà condivisa con "chiunque abbia il link",
  // basterà una chiave API (senza login). Lascia vuoto per usare il login Google.
  GOOGLE_API_KEY: '',

  // Sorgenti iniziali della libreria (poi si gestiscono da Impostazioni → Sorgenti)
  DEFAULT_SOURCES: [
    { type: 'gdrive', name: 'Spartiti Coro', folderId: '0B_tJxUucMWKbeUZoWTFEUE9EOW8', resourceKey: '0--yQITuDGbO8cuTvLQwOBcg' }
  ],

  // Voci riconosciute nei nomi dei file (l'ordine è quello mostrato nell'app)
  VOICES: ['primi', 'secondi', 'baritoni', 'bassi', 'tutti'],

  APP_NAME: 'Coro Player'
};
