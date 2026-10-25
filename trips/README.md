# Tragitti salvati

Qui vanno i file `tragitto-*.json` scaricati dalla app con **Salva tragitto**.
Ognuno contiene il percorso che faresti tu e le strade della zona, così il
modello si può provare e tarare su Torino anche senza connessione.

```bash
node scripts/check-trips.mjs
```

confronta, per ogni tragitto, il percorso Easy con il tuo e spiega da dove
viene lo stress di ciascuno.
