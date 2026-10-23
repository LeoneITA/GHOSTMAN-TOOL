# Aggiornamenti GHOSTMAN

## Come cambiare versione

Le versioni seguono il formato `MAJOR.MINOR.PATCH`, per esempio `1.1.12`.
`update/version.json` è la fonte del numero richiesto per la prossima release.
Non è necessario scegliere una versione in `package.json`: Actions lo
aggiorna per la build in modo che corrisponda al JSON.

Per chiedere una versione specifica:

1. Controlla **LeoneITA/GHOSTMAN-TOOL → Releases** e apri
   `update/version.json`. Imposta
   `version` a un numero maggiore dell'ultima Release, per esempio
   `1.1.11` → `1.1.12`.
2. Salva, fai commit e push delle modifiche sul branch `main`.
3. Apri **LeoneITA/GHOSTMAN-TOOL → Actions → Build and publish GHOSTMAN** e controlla che il
   workflow termini con successo.
4. Apri **LeoneITA/GHOSTMAN-TOOL → Releases** e verifica che siano presenti il tag
   `v1.1.12`, `GHOSTMAN-Setup.exe` e `latest.yml`. Solo dopo la pubblicazione
   l'app installata può rilevare e scaricare l'aggiornamento.

Se il numero nel JSON è uguale o inferiore all'ultima Release, oppure è già
stato pubblicato, non viene creata una seconda Release. Un numero più basso
dell'ultima Release causa un errore esplicito: Actions non incrementa la
versione da sola. Controlla il log **Read version from update manifest** per
verificare quale versione sta usando.

Il push del JSON avvia il workflow, ma il solo JSON non basta a distribuire
l'aggiornamento: le vecchie app lo leggono da GitHub e mostrano la versione
nuova quando è disponibile anche la Release con tag corrispondente e installer.
Non creare a mano un tag diverso dalla versione del JSON.

Se stai avviando l'app con `npm start`, sei in modalità sviluppo: il controllo
aggiornamenti automatico è disabilitato e l'app mostra la versione locale di
`package.json`. Per provare gli aggiornamenti installabili, attendi la Release
GitHub e installa `GHOSTMAN-Setup.exe`. In locale, se modifichi la versione del
manifest, esegui `npm version <versione> --no-git-tag-version` per mantenere
allineato il pacchetto di sviluppo. Se la Release non compare, controlla che il
push sia su `main`, che Actions sia abilitato e che il job sia riuscito.

## Pubblicare aggiornamenti automatici

Il file da distribuire è un solo installer chiamato `GHOSTMAN-Setup.exe`.
Installando l'app, il programma viene chiamato `GHOSTMAN.exe`. Non distribuire
gli EXE nella cartella `dist`: GitHub Actions crea una release e vi carica
l'installer.

Pubblica sorgenti e modifiche nella repository `LeoneITA/GHOSTMAN-TOOL`, sul
branch `main`, dopo aver aggiornato `update/version.json`. Actions esegue i
test, usa esattamente la versione del manifest per il pacchetto e crea la
Release con tag corrispondente `vX.Y.Z`. La versione deve essere maggiore
dell'ultima release pubblicata.

GHOSTMAN legge `update/version.json` dal branch `main` all'avvio e ogni quattro
ore. Se la versione è maggiore di quella installata, controlla direttamente
l'URL dell'installer nella Release con lo stesso tag, senza dipendere dalla
quota dell'API GitHub. Nelle build installate l'installer viene scaricato in background
e può essere installato dalla pagina **Aggiornamenti** o alla chiusura
dell'app. Il pulsante manuale di controllo ricontrolla il manifest.

Prima di distribuire questa configurazione, pubblica su GitHub anche
`.github/workflows/release.yml` e verifica che la repository consenta GitHub
Actions con permesso `contents: write`. Il branch deve chiamarsi `main`. Dopo
ogni push controlla **LeoneITA/GHOSTMAN-TOOL → Actions**: l'aggiornamento
compare solo quando il job termina e la Release con `GHOSTMAN-Setup.exe` e
`latest.yml` è disponibile. I vecchi utenti della versione portatile devono
eseguire una volta l'installer; da quel momento ricevono gli aggiornamenti
automatici.

Le modifiche fatte solo su GitHub non cambiano l'app fino a quando Actions non
ha creato la Release. Se un push non contiene sorgenti cambiati ma vuoi
comunque una nuova release, avvia il workflow da **Actions → Run workflow**.

## Comportamento nell'app

- L'installer NSIS controlla le Release all'avvio e poi ogni quattro ore.
- Il pallino in **Aggiornamenti** appare per una versione pubblicata più nuova;
  il changelog della Release è mostrato come testo.
- Premendo **Controlla aggiornamenti**, la build installata scarica il pacchetto
  completo in background. Quando è pronto, premi **Installa aggiornamento e
  riavvia GHOSTMAN**: il setup sostituisce i file dell'app e riapre la nuova
  versione. Non serve modificare o sostituire manualmente l'EXE.
- La versione portatile distribuita in precedenza non può aggiornarsi da sola:
  esegui una volta il nuovo installer per passare alla versione installata.
- Le Release GitHub sono la fonte ufficiale per il numero versione e per il
  download. Il controllo dell'app legge le Release pubblicate; il JSON serve
  solo come eventuale versione iniziale o incremento manuale.

## Accesso mobile privato

- Installare e collegare Tailscale sul PC e sul telefono allo stesso tailnet.
- Abilitare MagicDNS, certificati HTTPS e Tailscale Serve nelle impostazioni
  del tailnet.
- Se l'avvio segnala che Serve non è abilitato, usare il pulsante **Apri
  impostazioni Tailscale Serve** per abilitare la funzione per il dispositivo;
  poi riprovare da GHOSTMAN. Questa autorizzazione deve essere concessa da un
  amministratore del tailnet.
- In GHOSTMAN aprire **Accesso mobile** e attivare il servizio. GHOSTMAN ascolta
  solo su `127.0.0.1` e pubblica un percorso casuale solo tramite Tailscale
  Serve (non tramite Funnel o porte del router).
- Nel **Plugin manager**, approvare individualmente con **Consenti remoto**
  solo gli script Python fidati.
- I file della libreria locale possono essere abilitati singolarmente con
  **Abilita remoto**. Sul telefono appaiono sotto **FILE LOCALI · PC
  ASSOCIATO**; il dispositivo associato può usare **Scarica sul telefono**
  per salvare PDF, documenti, immagini e gli altri file direttamente dal PC,
  senza pubblicarli nella community. Per le cartelle abilitate, espandi
  **File della cartella** e scarica singoli file del sito/progetto. Immagini,
  PDF, testo e HTML possono anche essere aperti sul telefono. Le cartelle con `index.html` o
  `index.htm` vengono servite come siti completi con i relativi asset della
  cartella; la preview HTML resta in sandbox senza connessioni di rete esterne.
  Le cartelle importate sono limitate a 2.000 file e 100 MiB; ogni singola
  risorsa aperta da remoto è limitata a 25 MiB.
  documenti come Word si scaricano per l'app del telefono. **Chiedi apertura
  sul PC** richiede conferma sul computer. Non è previsto l'avvio forzato e
  non presidiato di EXE o script arbitrari.
- Il plugin dimostrativo **Discord Toolkit** usa il runtime Python indicato nel
  manifest e mostra quindi **Esegui** e **Consenti remoto**.
- Scansionare il QR/link entro 60 secondi. L'associazione richiede gli header
  di identita Tailscale e crea una sessione limitata a quell'identita.
- Le sessioni scadono dopo 30 minuti di inattivita o 12 ore; **Disattiva**
  revoca tutte le sessioni e rimuove il mount Serve di GHOSTMAN. Chiudere
  GHOSTMAN arresta il servizio.
- Gli avvii remoti vengono registrati in `remote-audit.jsonl` nella cartella
  user data di Electron senza memorizzare i valori degli input.

Serve un client Tailscale attivo anche sul telefono: il link non e un URL
pubblico e non funzionera con la sola rete mobile se l'app Tailscale non e
connessa al tailnet. Il PC e GHOSTMAN devono restare accesi. Ogni plugin
approvato esegue codice con i permessi dell'account Windows.

## Firma del codice

La build corrente non ha una firma Authenticode Windows. L'updater verifica
lo SHA-512 dichiarato nei metadati della release GitHub, ma senza un certificato
non può verificare l'identità del firmatario Windows. Prima di distribuire
aggiornamenti automatici su larga scala, configurare un certificato di firma
del codice e verificare il publisher atteso nell'updater. Non mettere mai il
certificato o la password nel repository: usare secrets GitHub Actions.
