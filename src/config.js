// Tutti i numeri che descrivono "come si guida davvero in città".
// Sono il punto da tarare con l'esperienza di chi conosce Torino.

// Classi di strada OSM che consideriamo percorribili in auto.
// rank: importanza della strada (serve per capire chi ha la precedenza).
// speed: velocità REALE media di scorrimento in km/h, semafori esclusi.
//        Non è il limite: un corso scorrevole si percorre più veloce di
//        quanto dica il cartello, una via residenziale molto più piano.
// stressPerKm: fatica di guida per km (pedoni, auto in doppia fila,
//        carreggiata stretta, pavé...). 1 punto = circa una svolta.
export const ROAD_CLASSES = {
  motorway:       { rank: 6, speed: 85, stressPerKm: 0.2 },
  motorway_link:  { rank: 5, speed: 45, stressPerKm: 0.4 },
  trunk:          { rank: 5, speed: 60, stressPerKm: 0.1 },
  trunk_link:     { rank: 4, speed: 35, stressPerKm: 0.3 },
  primary:        { rank: 4, speed: 40, stressPerKm: 0.0 },
  primary_link:   { rank: 3, speed: 28, stressPerKm: 0.3 },
  secondary:      { rank: 3, speed: 34, stressPerKm: 0.1 },
  secondary_link: { rank: 2, speed: 25, stressPerKm: 0.3 },
  tertiary:       { rank: 2, speed: 28, stressPerKm: 0.3 },
  tertiary_link:  { rank: 2, speed: 22, stressPerKm: 0.4 },
  unclassified:   { rank: 1, speed: 22, stressPerKm: 0.8 },
  residential:    { rank: 1, speed: 20, stressPerKm: 0.8 },
  living_street:  { rank: 0, speed: 10, stressPerKm: 2.0 },
};

// Strade con più corsie per senso di marcia scorrono meglio.
export const MULTILANE_SPEED_FACTOR = 1.12;

// Il limite conta solo quando è molto più basso della velocità tipica
// (es. zone 30): non si va oltre limite × questo fattore.
export const MAXSPEED_FACTOR = 1.15;

// Attesa media a un semaforo, in secondi.
export const SIGNAL_DELAY_S = 15;

// Tempo perso per ogni tipo di manovra (vale per entrambi i percorsi).
export const TURN_TIME_S = {
  straight: 0,
  slight: 2,
  right: 7,
  left: 12,
  sharp: 4, // in aggiunta a destra/sinistra
  roundabout: 6,
  uturn: 30,
  yieldMajor: 6, // immettersi su una strada più importante senza semaforo
};

// Punti stress: il cuore di Easy Drive.
export const STRESS = {
  maneuver: 1.0, // ogni decisione da prendere
  left: 0.6, // svolta a sinistra: si attraversa il traffico opposto
  sharp: 0.4, // svolta stretta
  roundabout: 1.0, // ingresso in rotonda
  unsignalizedLeftOntoMajor: 1.2, // sinistra su strada principale senza semaforo
  unsignalizedOntoMajor: 0.4, // destra su strada principale senza semaforo
  close: 1.0, // manovra a meno di CLOSE_MANEUVER_M dalla precedente
  uturn: 3.0,
};

// Due manovre più vicine di così si accavallano: stress extra.
export const CLOSE_MANEUVER_M = 150;

// Angoli (gradi) che separano dritto, leggera e vera svolta.
export const ANGLE = { straight: 25, turn: 40, sharp: 120 };

// Strade con divieti a orario (ZTL, corsie riservate) da evitare se richiesto.
export const RESTRICTED_PENALTY_S = 1800;

// Pesi λ (secondi per punto stress) provati per trovare percorsi più semplici.
export const STRESS_WEIGHTS = [0, 10, 20, 35, 50, 75, 100, 150, 220, 320];
