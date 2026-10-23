# Plugin Python GHOSTMAN

1. Crea una cartella dentro `plugins`, per esempio `plugins/mio-tool`. Usa
   lo stesso valore minuscolo per `id` nel manifest.
2. Aggiungi un `manifest.json` e il file Python indicato da `entry`.
3. Riavvia GHOSTMAN in sviluppo con `npm start`; il plugin apparira nel Plugin manager.
4. Premi **Esegui** e invia i campi definiti in `inputs`.

Esempio di manifest:

```json
{
  "id": "mio-tool",
  "name": "Mio tool",
  "version": "1.0.0",
  "description": "Un semplice tool Python",
  "category": "Utility",
  "apiVersion": 1,
  "runtime": "python",
  "entry": "main.py",
  "inputs": [
    {
      "name": "text",
      "label": "Testo",
      "type": "text",
      "required": true,
      "placeholder": "Scrivi qualcosa"
    }
  ]
}
```

Gli input supportati sono `text`, `number` e `url`. GHOSTMAN passa al programma
un oggetto JSON tramite standard input; il plugin deve stampare il risultato
sullo standard output. Per esempio:

```python
import json
import sys

request = json.load(sys.stdin)
print(json.dumps({"result": request["text"].upper()}))
```

Python deve essere installato e disponibile come `python` nel `PATH`. Se il
comando ha un percorso diverso, imposta la variabile d'ambiente
`GHOSTMAN_PYTHON` prima di avviare GHOSTMAN. Ogni esecuzione ha un limite di
30 secondi e un massimo di 1 MiB di output.

I plugin Python **non sono isolati**: possono accedere ai file e alle risorse
disponibili al tuo account Windows. Esegui soltanto plugin di cui ti fidi.

## Importare file della community

## Installare plugin selezionati dalla community

La pagina statica `plugins/community/index.html` mostra i plugin approvati dal
team leggendo `plugins/community/plugins.json`. Per aggiungere una scheda,
pubblica il pacchetto ZIP o RAR e aggiungi nel JSON ID, nome, versione,
descrizione, proprietario Discord, permalink del messaggio, URL diretto del
video facoltativo e URL diretto dell'archivio. Il post Discord non viene letto
automaticamente: copia a mano il link dell'allegato video e quello
dell'archivio. Il pulsante **Installa con GHOSTMAN** apre l'app installata,
scarica il pacchetto e chiede conferma prima di installarlo. I link CDN
Discord possono scadere; per i pacchetti è preferibile una GitHub Release.

Gli utenti possono usare **Installa con GHOSTMAN** dal sito, oppure scaricare
ed estrarre lo ZIP/RAR. Per l'installazione manuale, premere **Installa plugin da
cartella** e selezionare la cartella che contiene `manifest.json`, oppure
importare prima la cartella nella libreria: in quel caso usano **Installa plugin
Python** sulla voce importata. GHOSTMAN copia il plugin nell'area dati
dell'utente, che rimane disponibile anche se viene aggiornata l'app. È
supportato solo il runtime Python, con `manifest.json` e file entry `.py` nella
cartella principale. Gli aggiornamenti del plugin si installano scegliendo il
nuovo pacchetto e confermando la sostituzione.

I plugin Python non sono isolati: il loro codice può accedere ai file e alle
risorse del profilo Windows. Il sito è un catalogo curato, non una sandbox né
una verifica automatica di sicurezza. Analizza il codice prima di approvarlo
per la community e invita gli utenti a installare solo plugin fidati.

Dal **Plugin manager** usa **+ Importa file, cartella o archivio** per copiare file
singoli o un'intera cartella nella libreria locale di GHOSTMAN. Un archivio ZIP
o RAR viene estratto in una cartella con il nome dell'archivio; i percorsi non sicuri,
i collegamenti e gli archivi oltre i limiti vengono rifiutati. La cartella appare
come voce espandibile con l'elenco dei file contenuti. Se trova `index.html` o
`index.htm`, anche dentro una sottocartella, **Prova sito** lo apre su Windows e
puoi abilitarlo per il telefono. Sono mantenuti i percorsi relativi di CSS,
JavaScript e immagini. Le cartelle sono limitate a 2.000 file e 100 MiB e non
possono contenere collegamenti simbolici. **Esporta** crea una copia della
cartella da condividere con la community. I contenuti importati restano sul PC
e non vengono caricati automaticamente su GitHub o inviati agli altri utenti.

Questa libreria accetta file di qualsiasi estensione, ma importarli non li
trasforma in plugin GHOSTMAN: per comparire come tool con il pulsante **Esegui**,
un plugin deve avere la propria cartella, un `manifest.json` valido e usare un
runtime implementato dall'app (attualmente Python). Per installare un plugin
ricevuto, estrai prima il pacchetto e segui le istruzioni del manifest. Non
aprire file o plugin di cui non conosci o non hai verificato la provenienza.

Per provare un file HTML singolo, importa `index.html` e usa **Prova HTML**:
si apre nel browser predefinito di Windows. Per un sito composto da più file,
importa la cartella radice che contiene `index.html`; sul telefono usa **Prova
sito sul telefono**. La preview remota serve solo i file di quella cartella,
mantiene i percorsi relativi e blocca le connessioni di rete avviate dal sito.
Per registrare un programma come plugin eseguibile nel catalogo serve invece il
manifest e un runtime supportato.

Per aggiungere un file alla sezione **FILE LOCALI** del telefono, abilita
**Abilita remoto** sul file desiderato. Questa funzione non carica né invia il
contenuto a terzi: il telefono associato può scaricare il file direttamente
dal PC. Immagini, PDF, testo, HTML e siti cartella vengono mostrati in
anteprima; HTML e siti sono isolati in un frame sandbox senza accesso alla rete
esterna.
Gli altri tipi, come Word, vengono scaricati sul telefono per essere aperti
con un'app installata lì.

Il pulsante **Chiedi apertura sul PC** richiede comunque una conferma visibile
sul computer. Script ed eseguibili possono avviare codice con i permessi
dell'utente Windows: GHOSTMAN non consente di forzare a distanza l'avvio di un
file arbitrario senza conferma sul PC. Per eseguire da telefono uno strumento
Python quando sei lontano, usa un plugin valido e approvato con **Consenti
remoto**. Revoca il permesso remoto dei file quando non serve più.
