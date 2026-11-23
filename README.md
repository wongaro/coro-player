# Coro Player

Web app installabile su iPhone (e Android) per studiare le parti del coro.
Legge i brani dalla cartella **Spartiti Coro** su Google Drive e riconosce da sola
brano, armonizzatore, voce (primi, secondi, baritoni, bassi, tutti) e versione.

## Cosa fa
- **Catalogo** dalla cartella del coro: lettere A–Z, "canti armonizzati da Ivan", "Audio Riscaldamento e Prove". La cartella `archivio` viene ignorata e per ogni voce si usa la versione più recente.
- **La mia voce**: la scegli una volta e ogni brano parte dalla tua parte.
- **Cambio voce senza perdere il punto**: passi da Baritoni a Tutti e la riproduzione continua dallo stesso istante.
- **Ripetizione A–B** di un passaggio e **velocità** dal 50% al 150% senza cambiare l'intonazione.
- **Volume oltre la registrazione**, per le tracce registrate troppo basse:
  - **Auto** porta ogni traccia al livello massimo senza distorcere;
  - **×1,5, ×2, ×3** amplificano di una quantità fissa, con un limitatore morbido che evita le saturazioni.

  L'impostazione resta memorizzata e vale per tutti i brani. Non si applica ai video e ai link esterni che non lo consentono.
- **Playlist** personali con brani del coro e link audio (https://…mp3).
- **Offline**: i brani ascoltati restano sul telefono. "Scarica offline" salva tutte le voci e il PDF di un brano.
- **Spartito PDF** e **video** (.mov) quando presenti nella cartella.
- Riproduzione con schermo bloccato e comandi nella schermata di blocco.

---

## Installazione (circa 20 minuti, una volta sola)

### 1. Pubblica l'app su GitHub Pages (gratis)
1. Su github.com crea un nuovo repository **pubblico**, per esempio `coro-player`.
2. Clicca **Add file → Upload files** e trascina tutti i file di questa cartella. Poi **Commit changes**.
3. Vai su **Settings → Pages**. In *Source* scegli **Deploy from a branch**, branch `main`, cartella `/ (root)`, poi **Save**.
4. Dopo circa un minuto l'app è online all'indirizzo `https://TUONOME.github.io/coro-player/`.

> L'ID della cartella nel file `config.js` non dà accesso a nulla: i file restano visibili solo agli account autorizzati su Drive.

### 2. Crea l'accesso a Google Drive (Google Cloud, gratis)
1. Apri https://console.cloud.google.com e crea un progetto, per esempio "Coro Player".
2. **API e servizi → Libreria** → cerca **Google Drive API** → **Abilita**.
3. **Google Auth Platform** (la vecchia "Schermata consenso OAuth") → **Inizia**:
   - nome app: *Coro Player*; email di assistenza: la tua;
   - destinatari: **Esterni**;
   - lascia l'app in modalità **Test**;
   - in **Destinatari → Utenti di test** aggiungi l'account Gmail con cui vedi la cartella *Spartiti Coro*.
4. **Accesso ai dati → Aggiungi ambiti**: aggiungi `.../auth/drive.readonly`.
5. **Client → Crea client**:
   - tipo: **Applicazione web**;
   - **Origini JavaScript autorizzate**: `https://TUONOME.github.io` (solo il dominio, senza `/coro-player`).
6. Copia l'**ID client**, che termina con `.apps.googleusercontent.com`.

### 3. Inserisci l'ID client
Su GitHub apri `config.js` e clicca la matita per modificarlo. Incolla l'ID tra gli apici:
```js
GOOGLE_CLIENT_ID: '1234567890-abc...apps.googleusercontent.com',
```
Poi **Commit changes** e attendi circa un minuto.

### 4. Installa sull'iPhone
1. Apri l'indirizzo dell'app in **Safari**.
2. Tocca **Condividi → Aggiungi alla schermata Home**.
3. Apri l'app dall'icona e vai su **Impostazioni → Accedi con Google**.
   Google avvisa che l'app non è verificata: è normale per un'app in prova. Tocca **Avanzate → Vai a Coro Player**.
4. Tocca **Aggiorna catalogo**: la prima lettura richiede qualche decina di secondi.
5. Scegli **la tua voce**.

---

## Da sapere
- L'accesso a Google dura un'ora. Dopo un'ora i brani già scaricati si ascoltano lo stesso; per scaricarne di nuovi o aggiornare il catalogo tocca di nuovo **Accedi**.
- Quando qualcuno aggiunge brani su Drive, tocca **Aggiorna catalogo**.
- I video `.mov` si vedono nel player. Con lo schermo bloccato iOS può mettere in pausa i video: per lo studio in tasca usa le tracce mp3.

## Problemi comuni
| Messaggio | Soluzione |
|---|---|
| `origin_mismatch` | L'origine al punto 2.5 deve essere esattamente `https://TUONOME.github.io` |
| `access_denied` | Aggiungi il tuo account agli **utenti di test** (punto 2.3) |
| Errore 403 *Drive API has not been used* | Abilita la Google Drive API (punto 2.2) |
| Il login non si apre dall'app installata | Apri l'indirizzo una volta in Safari, accedi da lì e poi torna all'app |

## Quando la renderemo condivisibile
- **Opzione semplice**: condividi la cartella *Spartiti Coro* con "chiunque abbia il link" e metti in `config.js` una **chiave API** (`GOOGLE_API_KEY`) al posto dell'ID client. I coristi useranno l'app senza login.
- **Opzione riservata**: si pubblica l'app in produzione su Google (verifica dell'app) e i coristi accedono con il proprio account, se la cartella è condivisa con loro.

## Struttura dei file
| File | Contenuto |
|---|---|
| `index.html`, `styles.css` | interfaccia |
| `app.js` | catalogo, player, playlist, offline |
| `parser.js` | riconoscimento di brano, voce e versione dai nomi dei file |
| `drive.js` | login Google e accesso a Drive |
| `config.js` | impostazioni (ID client, cartella, voci) |
| `sw.js`, `manifest.webmanifest`, icone `.png` | installazione come app e funzionamento offline |
