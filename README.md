# Easy Drive

Il navigatore che sceglie il percorso **più semplice**, non solo il più veloce.
Meno svolte, strade scorrevoli, niente zig-zag per guadagnare 30 secondi: il
percorso che farebbe chi conosce davvero la città.

Prototipo su **Torino**.

## Provarlo

Serve Node.js 18 o più recente. Non ci sono dipendenze da installare.

```bash
npm start
```

Poi apri <http://localhost:8080>. La pagina parte con un tragitto di esempio
(Piazza Castello → Lingotto). Per cambiarlo:

- scrivi un indirizzo in **Partenza** o **Arrivo** e premi Invio, oppure
- tocca la mappa (il primo tocco imposta la partenza, il secondo l'arrivo), oppure
- trascina i segnaposto A e B.

Il cursore **"Tempo in più che accetto"** dice quanti minuti sei disposto a
perdere per un percorso più semplice. La pagina mostra due percorsi a
confronto: **Easy** in blu e **Più veloce** tratteggiato. Per ciascuno vedi
tempo, chilometri, manovre, svolte a sinistra e manovre ravvicinate. I pallini
sulla mappa segnano ogni manovra; quelli rossi sono le manovre ravvicinate.

Le strade vengono scaricate al momento da OpenStreetMap (servizio Overpass)
per la zona del tragitto, quindi la prima ricerca in una zona richiede qualche
secondo. Le ricerche successive nella stessa zona sono immediate.

## Come funziona

Ogni percorso ha un costo:

```
costo = tempo + λ × stress
```

**Tempo.** Non usa i limiti di velocità ma la velocità *reale* tipica di ogni
tipo di strada: un corso scorrevole a più corsie va più veloce del cartello,
una via residenziale molto più piano. A questo si aggiungono i semafori e il
tempo perso a svoltare (a sinistra più che a destra).

**Stress.** Punti che misurano la fatica di guida:

- ogni manovra, cioè ogni punto in cui devi decidere qualcosa (proseguire
  sulla stessa strada non conta, nemmeno se cambia nome);
- svolte a sinistra, perché attraversi il traffico che arriva di fronte;
- svolte a sinistra su una strada principale senza semaforo;
- manovre ravvicinate, a meno di 150 m l'una dall'altra;
- ingressi in rotonda e inversioni a U;
- chilometri su vie strette e residenziali.

L'app calcola il percorso per diversi valori di λ, da 0 (solo tempo, come i
navigatori classici) a valori alti (quasi solo semplicità). Poi sceglie il
percorso con meno stress tra quelli che stanno nel tempo in più che hai
accettato.

Tiene conto di sensi unici, divieti di svolta e strade chiuse al traffico
privato. Le strade con divieti a orario (ZTL, corsie riservate) vengono evitate
se sono segnate in OpenStreetMap.

### Tarare i parametri

Tutti i numeri sono in [`src/config.js`](src/config.js), commentati in
italiano: velocità reali per tipo di strada, attesa ai semafori, punti stress
di ogni manovra. Lì entra la conoscenza di chi guida a Torino tutti i giorni.

## Struttura

| File | Cosa fa |
| --- | --- |
| `index.html`, `css/style.css` | Pagina e stile |
| `src/app.js` | Mappa, ricerca indirizzi, confronto percorsi |
| `src/osm.js` | Scarica le strade da OpenStreetMap (Overpass) |
| `src/graph.js` | Costruisce il grafo stradale (incroci, sensi unici, divieti) |
| `src/router.js` | Algoritmo di percorso tempo + stress |
| `src/planner.js` | Prova vari λ e sceglie il percorso Easy |
| `src/instructions.js` | Istruzioni di guida in italiano e conteggi |
| `src/config.js` | Tutti i parametri da tarare |

## Test

```bash
npm test          # motore di percorso, su città sintetiche
npm run test:e2e  # pagina web nel browser (richiede Playwright)
```

## Limiti attuali

- Le velocità reali sono stime per tipo di strada, non misure.
  Il prossimo passo è usare dati storici (TomTom, HERE) o tracce GPS.
- Niente traffico in tempo reale.
- Le ZTL vengono evitate solo se in OpenStreetMap hanno il divieto a orario.
- Il calcolo gira nel browser e regge tragitti fino a circa 25 km.
- È una pagina web, non ancora un'app con navigazione guidata.

## Dati e servizi

- Strade: © [OpenStreetMap](https://www.openstreetmap.org/copyright), tramite
  l'API Overpass.
- Ricerca indirizzi: Nominatim (OpenStreetMap).
- Mappa di sfondo: CARTO.
- Mappa interattiva: [Leaflet](https://leafletjs.com) 1.9.4, in `vendor/`.

Questi servizi pubblici vanno bene per un prototipo, ma non per un'app con
molti utenti: in quel caso servono server propri o un fornitore a pagamento.
