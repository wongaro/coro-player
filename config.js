// Configurazione di Coro Player.
// Compila GOOGLE_CLIENT_ID con l'ID client OAuth creato su Google Cloud (vedi README.md).
window.CORO_CONFIG = {
  // ID client OAuth "Applicazione web" (termina con .apps.googleusercontent.com)
  GOOGLE_CLIENT_ID: '',

  // Facoltativo: se un giorno la cartella sarà condivisa con "chiunque abbia il link",
  // basterà una chiave API (senza login). Lascia vuoto per usare il login Google.
  GOOGLE_API_KEY: '',

  // Cartella "Spartiti Coro" su Google Drive
  ROOT_FOLDER_ID: '0B_tJxUucMWKbeUZoWTFEUE9EOW8',
  ROOT_RESOURCE_KEY: '0--yQITuDGbO8cuTvLQwOBcg',

  // Voci riconosciute nei nomi dei file (l'ordine è quello mostrato nell'app)
  VOICES: ['primi', 'secondi', 'baritoni', 'bassi', 'tutti'],

  APP_NAME: 'Coro Player'
};
