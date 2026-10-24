// Turns a route into turn-by-turn steps (in Italian) and stress counts.

const CARDINALS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ovest', 'ovest', 'nord-ovest'];

const TURN_TEXT = {
  left: 'Svolta a sinistra',
  right: 'Svolta a destra',
  'slight-left': 'Tieni la sinistra',
  'slight-right': 'Tieni la destra',
  straight: 'Prosegui dritto',
  uturn: 'Fai inversione a U',
};

export function streetLabel(edge) {
  if (edge.name && edge.ref) return `${edge.name} (${edge.ref})`;
  return edge.name || edge.ref || 'strada senza nome';
}

export function buildSteps(graph, route) {
  const { edges, nodes } = graph;
  const steps = [];
  const firstEdge = edges[route.legs[0].edge];
  steps.push({
    type: 'depart',
    text: `Parti verso ${CARDINALS[Math.round(firstEdge.bearingStart / 45) % 8]} su ${streetLabel(firstEdge)}`,
    at: route.coords[0],
    distance: 0,
  });

  let sinceLast = route.legs[0].length;
  let roundabout = null;
  for (let i = 1; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const turn = leg.turn;
    const edge = edges[leg.edge];
    const prev = edges[route.legs[i - 1].edge];
    const node = nodes[prev.to];
    const at = [node.lat, node.lon];

    if (turn.kind === 'roundabout') {
      roundabout = { at, distance: sinceLast, exits: 0, stress: turn.stress + (leg.close ? 1 : 0), close: leg.close };
      sinceLast = 0;
    } else if (roundabout) {
      // Count the exits we drive past before leaving the roundabout.
      const exitsHere = graph.outEdges[prev.to].some((id) => !edges[id].roundabout && edges[id].segment !== prev.segment);
      if (turn.kind === 'exit') {
        roundabout.exits++;
        steps.push({
          type: 'roundabout',
          text: `Alla rotonda prendi la ${roundabout.exits}ª uscita su ${streetLabel(edge)}`,
          at: roundabout.at,
          distance: roundabout.distance,
          close: roundabout.close,
          modifier: 'roundabout',
        });
        roundabout = null;
        sinceLast = 0;
      } else if (exitsHere) {
        roundabout.exits++;
      }
    } else if (turn.maneuver) {
      steps.push({
        type: turn.kind === 'uturn' ? 'uturn' : 'turn',
        modifier: turn.kind,
        text: `${TURN_TEXT[turn.kind]} ${turn.kind === 'uturn' ? 'su' : 'in'} ${streetLabel(edge)}`,
        at,
        distance: sinceLast,
        close: leg.close,
      });
      sinceLast = 0;
    }
    sinceLast += leg.length;
  }

  steps.push({ type: 'arrive', text: 'Sei arrivato a destinazione', at: route.coords[route.coords.length - 1], distance: sinceLast });
  return steps;
}

export function countStress(graph, route) {
  const counts = { maneuvers: 0, left: 0, right: 0, roundabouts: 0, close: 0, uturns: 0 };
  const streets = new Set();
  for (const leg of route.legs) {
    const edge = graph.edges[leg.edge];
    if (leg.length > 30) streets.add(edge.roundabout ? `rotonda-${edge.wayId}` : streetLabel(edge));
    const t = leg.turn;
    if (!t || !t.maneuver) continue;
    counts.maneuvers++;
    if (t.kind === 'left' || t.kind === 'slight-left') counts.left++;
    if (t.kind === 'right' || t.kind === 'slight-right') counts.right++;
    if (t.kind === 'roundabout') counts.roundabouts++;
    if (t.kind === 'uturn') counts.uturns++;
    if (leg.close) counts.close++;
  }
  counts.streets = streets.size;
  return counts;
}
