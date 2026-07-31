/**
 * Deterministic mock of the FPL API, shared by the test suite and the
 * offline preview server so neither needs the live endpoint.
 */
const TEAMS = [
  "Arsenal","Aston Villa","Bournemouth","Brentford","Brighton","Burnley","Chelsea",
  "Crystal Palace","Everton","Fulham","Leeds","Liverpool","Man City","Man Utd",
  "Newcastle","Nott'm Forest","Sunderland","Spurs","West Ham","Wolves",
];
const SHORTS = ["ARS","AVL","BOU","BRE","BHA","BUR","CHE","CRY","EVE","FUL","LEE","LIV","MCI","MUN","NEW","NFO","SUN","TOT","WHU","WOL"];
const CURRENT_GW = 12;

const rnd = (seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)(42);
const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1));

const teams = TEAMS.map((name, i) => ({
  id: i + 1, name, short_name: SHORTS[i], code: 100 + i,
  strength_attack_home: ri(1000, 1400), strength_attack_away: ri(1000, 1400),
  strength_defence_home: ri(1000, 1400), strength_defence_away: ri(1000, 1400),
  strength_overall_home: ri(1000, 1400), strength_overall_away: ri(1000, 1400),
}));

const element_types = [
  { id: 1, singular_name: "Goalkeeper", singular_name_short: "GKP" },
  { id: 2, singular_name: "Defender", singular_name_short: "DEF" },
  { id: 3, singular_name: "Midfielder", singular_name_short: "MID" },
  { id: 4, singular_name: "Forward", singular_name_short: "FWD" },
  { id: 5, singular_name: "Manager", singular_name_short: "MNG" },
];

const events = Array.from({ length: 38 }, (_, i) => ({
  id: i + 1,
  name: `Gameweek ${i + 1}`,
  deadline_time: new Date(Date.now() + (i + 1 - CURRENT_GW) * 7 * 864e5).toISOString(),
  finished: i + 1 < CURRENT_GW,
  is_current: i + 1 === CURRENT_GW,
  is_next: i + 1 === CURRENT_GW + 1,
}));

let elId = 0;
const elements = [];
for (const t of teams) {
  const plan = [[1, 2], [2, 6], [3, 7], [4, 4]];
  for (const [type, count] of plan) {
    for (let j = 0; j < count; j++) {
      elId++;
      const mins = ri(0, 1080);
      const xg = +(rnd() * (type >= 3 ? 6 : 1.5)).toFixed(2);
      const xa = +(rnd() * 4).toFixed(2);
      elements.push({
        id: elId, web_name: `${t.short_name}-P${j + 1}`,
        first_name: "Test", second_name: `${t.short_name}${j}`,
        team: t.id, element_type: type,
        now_cost: ri(38, 145), status: rnd() > 0.94 ? "d" : "a",
        penalties_order: j === 0 && type >= 3 ? 1 : null,
        corners_and_indirect_freekicks_order: null,
        direct_freekicks_order: j === 1 && type === 3 ? 1 : null,
        news: rnd() > 0.94 ? "Knock - 75% chance of playing" : "",
        chance_of_playing_next_round: 100,
        minutes: mins, starts: Math.floor(mins / 90),
        total_points: ri(0, 90), points_per_game: +(rnd() * 6).toFixed(1),
        form: +(rnd() * 8).toFixed(1), bonus: ri(0, 12), bps: ri(0, 400),
        selected_by_percent: +(rnd() * 45).toFixed(1),
        transfers_in_event: ri(0, 90000), transfers_out_event: ri(0, 90000),
        cost_change_start: ri(-6, 8),
        goals_scored: Math.round(xg + (rnd() - 0.5) * 3),
        assists: Math.round(xa + (rnd() - 0.5) * 2),
        clean_sheets: ri(0, 6),
        expected_goals: String(xg), expected_assists: String(xa),
        expected_goal_involvements: String((xg + xa).toFixed(2)),
        expected_goals_conceded: String((rnd() * 14).toFixed(2)),
        defensive_contribution: ri(0, 180),
        creativity: String((rnd() * 600).toFixed(1)),
        influence: String((rnd() * 600).toFixed(1)),
        threat: String((rnd() * 700).toFixed(1)),
        ict_index: String((rnd() * 150).toFixed(1)),
      });
    }
  }
}
// One manager-type element, which the app should filter out.
elements.push({
  id: ++elId, web_name: "Boss", first_name: "A", second_name: "Manager", team: 1,
  element_type: 5, now_cost: 15, minutes: 0, total_points: 0, status: "a",
  expected_goals: "0", expected_assists: "0", expected_goal_involvements: "0",
  expected_goals_conceded: "0", selected_by_percent: "0",
  transfers_in_event: 0, transfers_out_event: 0, cost_change_start: 0,
  goals_scored: 0, assists: 0, clean_sheets: 0, defensive_contribution: 0,
  creativity: "0", influence: "0", threat: "0", ict_index: "0",
  points_per_game: "0", form: "0", bonus: 0, bps: 0, starts: 0,
});

const fixtures = [];
let fxId = 0;
for (let gw = 1; gw <= 38; gw++) {
  const pool = [...teams].sort(() => rnd() - 0.5);
  for (let i = 0; i < pool.length; i += 2) {
    // Leave a couple of teams out around GW15 to exercise blanks and doubles.
    if (gw === 15 && i === 0) continue;
    fixtures.push({
      id: ++fxId, event: gw, finished: gw < CURRENT_GW,
      team_h: pool[i].id, team_a: pool[i + 1].id,
      team_h_score: gw < CURRENT_GW ? ri(0, 4) : null,
      team_a_score: gw < CURRENT_GW ? ri(0, 4) : null,
      team_h_difficulty: ri(2, 5), team_a_difficulty: ri(2, 5),
      kickoff_time: new Date(Date.now() + gw * 7 * 864e5).toISOString(),
    });
  }
}
// A genuine double gameweek for team 1 in GW16.
fixtures.push({
  id: ++fxId, event: 16, finished: false, team_h: 1, team_a: 5,
  team_h_score: null, team_a_score: null,
  team_h_difficulty: 2, team_a_difficulty: 4, kickoff_time: new Date().toISOString(),
});
// An unscheduled fixture, which must not crash the index.
fixtures.push({
  id: ++fxId, event: null, finished: false, team_h: 3, team_a: 9,
  team_h_score: null, team_a_score: null,
  team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: null,
});

const gws = [7, 8, 9, 10, 11, 12];
const formPoints = {};
const formMinutes = {};
elements.forEach((e) => {
  formPoints[e.id] = gws.map(() => (rnd() > 0.15 ? ri(0, 14) : 0));
  formMinutes[e.id] = gws.map(() => (rnd() > 0.15 ? ri(20, 90) : 0));
});

const squadPicks = elements
  .filter((e) => e.element_type <= 4)
  .slice(0, 15)
  .map((e, i) => ({
    element: e.id, position: i + 1,
    multiplier: i === 0 ? 1 : i === 1 ? 2 : i < 11 ? 1 : 0,
    is_captain: i === 1, is_vice_captain: i === 2,
  }));

// A handful of players have moved price; the rest are absent, exactly as the
// price_moves SQL function returns them.
const priceMoves = {};
elements.filter((e) => e.element_type <= 4).slice(0, 40).forEach((e, i) => {
  const change = [-2, -1, 1, 2, 3][i % 5];
  priceMoves[e.id] = { change, latest: e.now_cost + change };
});

const MOCK = {
  "/api/bootstrap": { events, teams, element_types, elements, total_players: 11000000 },
  "/api/fixtures": fixtures,
  "/api/form?last=6": { gws, points: formPoints, minutes: formMinutes, current: CURRENT_GW },
  [`/api/live/${CURRENT_GW}`]: {
    elements: elements.map((e) => ({
      id: e.id,
      // Force a non-zero score on the captain so the multiplier test bites.
      stats: {
        total_points: e.id === squadPicks.find((p) => p.is_captain).element ? 7 : ri(0, 13),
        minutes: ri(0, 90), bonus: ri(0, 3),
      },
    })),
  },
  "/api/prices?days=14": priceMoves,
  "/api/entry/1234567": {
    id: 1234567, name: "Top Bins XI", player_first_name: "Paul", player_last_name: "T",
    summary_overall_points: 712, summary_overall_rank: 184532, summary_event_points: 58,
  },
  "/api/entry/1234567/history": {
    current: Array.from({ length: CURRENT_GW }, (_, i) => ({
      event: i + 1, points: ri(30, 90), overall_rank: ri(100000, 400000),
    })),
    chips: [],
  },
  [`/api/entry/1234567/picks/${CURRENT_GW}`]: {
    active_chip: null, automatic_subs: [],
    entry_history: {
      event: CURRENT_GW, points: 58, total_points: 712, rank: 220145,
      overall_rank: 184532, bank: 7, value: 1013,
      event_transfers: 1, event_transfers_cost: 0, points_on_bench: 6,
    },
    picks: squadPicks,
  },
};



/* ------------------------------------------------------------------
   Journal fixtures

   Deterministic per (element, gameweek) so the same decision always scores
   the same way, which is what makes the render tests meaningful.
------------------------------------------------------------------ */
export function pointsFor(element, gw) {
  const h = (element * 7919 + gw * 104729) % 97;
  return h % 17;
}

export function pointsPayload(from, to, elements) {
  const points = {};
  const minutes = {};
  const ids = elements && elements.length
    ? elements
    : elements.length === 0
    ? []
    : [];
  for (const id of ids) {
    for (let gw = from; gw <= Math.min(to, CURRENT_GW); gw++) {
      (points[id] ??= {})[gw] = pointsFor(id, gw);
      (minutes[id] ??= {})[gw] = 90;
    }
  }
  return {
    from,
    to,
    current: CURRENT_GW,
    finished: Array.from({ length: CURRENT_GW - 1 }, (_, i) => i + 1),
    points,
    minutes,
  };
}

/** Approximates the real endpoint by scaling each player's season totals
 *  down to the requested window's share of gameweeks played so far. */
export function teamsWindowPayload(from, to) {
  const cappedTo = Math.min(to, CURRENT_GW);
  const span = Math.max(0, cappedTo - from + 1);
  const scale = CURRENT_GW > 0 ? span / CURRENT_GW : 0;
  const teams = {};
  for (const e of elements) {
    const t = (teams[e.team] ??= { xg: 0, xa: 0, xgcRaw: 0, defcon: 0, mins: 0 });
    t.xg += Number(e.expected_goals) * scale;
    t.xa += Number(e.expected_assists) * scale;
    t.xgcRaw += Number(e.expected_goals_conceded) * scale;
    t.defcon += Number(e.defensive_contribution) * scale;
    t.mins += Math.round(e.minutes * scale);
  }
  return { from, to: cappedTo, teams };
}

const pickIds = elements.filter((e) => e.element_type === 3).slice(0, 6).map((e) => e.id);
const opt = (id) => {
  const e = elements.find((x) => x.id === id);
  const t = teams.find((x) => x.id === e.team);
  return { id, name: e.web_name, short: t.short_name, pos: "MID" };
};

/** Two settled calls and one still to play, so every card state renders. */
export const seedDecisions = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    created_at: "2026-01-05T09:00:00Z",
    kind: "captain",
    gw: CURRENT_GW - 1,
    horizon: "1",
    title: "Armband on the differential",
    options: [opt(pickIds[0]), opt(pickIds[1])],
    chosen: pickIds[0],
    confidence: 4,
    reasons: ["fixtures", "form"],
    note: "Home to a side that has conceded in nine straight. If he is benched for the cup this looks silly.",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-01-02T09:00:00Z",
    kind: "transfer",
    gw: CURRENT_GW - 2,
    horizon: "3",
    title: "Third midfield slot",
    options: [opt(pickIds[2]), opt(pickIds[3]), opt(pickIds[4])],
    chosen: pickIds[4],
    confidence: 2,
    reasons: ["underlying", "price"],
    note: "Underlying numbers are better and he is 0.3 cheaper, which funds the defender upgrade next week.",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    created_at: "2026-01-09T09:00:00Z",
    kind: "hold",
    gw: CURRENT_GW + 1,
    horizon: "1",
    title: "Roll the transfer",
    options: [opt(pickIds[5])],
    chosen: pickIds[5],
    confidence: 3,
    reasons: ["gut"],
    note: "Nothing screams at me this week. Bank it and see how the double shakes out.",
  },
];

export { MOCK, CURRENT_GW, squadPicks, elements, teams, fixtures };
