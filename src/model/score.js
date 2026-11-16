// The episode's scorecard on the page (contract H4, 2026-11-15): what the bar's score chip, the panel's Score block, the
// time bar's trial ticks and the episode picker show, read generically from the card (sprout_sim/scenes/components.py,
// "The scorecard"; the bundle's `episode.json["score"]`, the live episode end's `extras.score`) and from its head, which
// the scene dict carries from the start (`scene.task.sentence / protocol / pass_rule / primary`).
//
// The card is the judge's record of the whole episode: a replay has it from the first frame, so everything here reveals
// only the trial rows whose sim time `t` the playhead has passed, and the final number and verdict only once the episode
// has ended at the playhead. Everything is pure (no DOM, no clocks): the node tests run it on synthetic cards and on rows
// cut from recorded runs.

import { num, isObj, short, fmtCm } from '../util/format.js';

export const EN_DASH = '–';
// a card with more distinct trials than this draws only the ticks of trials that went one way or the other (`ok` true or
// false): C-3's fifty taps or C-6's turn every 1.5 s would otherwise cover the time bar
export const TICKS_ALL_MAX = 40;
// the metrics the result shows at once; the rest open behind "more"
export const METRICS_OPEN = 8;
// the row keys every card shares (components.py): they are never one of a line's own fields
const COMMON_KEYS = new Set(['n', 't', 't_task', 'value', 'ok']);
// the labels in a card's metrics that name the episode's variant (the level of C-4's balls, C-6's swing, C-1's stream,
// C-2's maze): known before the episode starts, so the header's scene line may show them at any time
const LEVEL_KEYS = [['spread', 'level'], ['swing', 'swing'], ['stream', 'stream'], ['maze', 'maze']];

/** The card's head as the scene dict describes it (`scene.task`: describe.py card_head_of), or null for a scene without a
 * scorecard: `{sentence, protocol, pass_rule, primary: {key, label, of, unit, better}}`. */
export function scoreHead(task) {
  if (!isObj(task) || !isObj(task.primary) || task.primary.key == null) return null;
  const p = task.primary;
  return { sentence: str(task.sentence), protocol: str(task.protocol), pass_rule: str(task.pass_rule),
    primary: { key: String(p.key), label: str(p.label) ?? String(p.key), of: num(p.of), unit: str(p.unit) ?? '',
      better: p.better === 'lower' ? 'lower' : 'higher' } };
}

/** A stored card made safe to read (`{task, protocol, pass_rule, primary, passed, final, success, reason, metrics, trials,
 * component}`), its trials in the order of their sim time (a row without one, a pass still running at the end, last), or
 * null for anything that is not a card. */
export function normCard(card) {
  if (!isObj(card) || !isObj(card.primary)) return null;
  const p = card.primary;
  const trials = (Array.isArray(card.trials) ? card.trials : []).filter(isObj).map((r, i) => ({ r, i }));
  trials.sort((a, b) => {
    const ta = num(a.r.t);
    const tb = num(b.r.t);
    if (ta == null || tb == null) return ta == null && tb == null ? a.i - b.i : ta == null ? 1 : -1;
    return ta - tb || a.i - b.i;
  });
  return {
    task: str(card.task), protocol: str(card.protocol), pass_rule: str(card.pass_rule),
    primary: { key: String(p.key ?? 'score'), label: str(p.label) ?? String(p.key ?? 'score'), value: p.value ?? null,
      of: num(p.of), unit: str(p.unit) ?? '', better: p.better === 'lower' ? 'lower' : 'higher' },
    passed: typeof card.passed === 'boolean' ? card.passed : null,
    // a card kept before the key existed was kept at the verdict (report.py card_final)
    final: card.final !== false,
    success: typeof card.success === 'boolean' ? card.success : null,
    reason: str(card.reason),
    component: str(card.component),
    metrics: isObj(card.metrics) ? card.metrics : {},
    trials: trials.map((x) => x.r),
    // whether the rows carry the running score themselves (components.py: every row's `value`); older cards do not
    has_value: trials.some((x) => Object.prototype.hasOwnProperty.call(x.r, 'value')),
  };
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** A number as a card writes it: an integer as it is, anything else with the decimals it needs (at most `nd`). */
export function fmtNum(v, nd = 2) {
  const x = num(v);
  if (x == null) return v == null ? EN_DASH : String(v);
  if (Number.isInteger(x)) return String(x);
  return String(+x.toFixed(nd));
}

/** The primary as `<value>[/<of>] <unit>` ("8/10 balls", "29.4 s", "5.0/60 s"); an unknown value is an en dash without
 * its unit. A duration with a maximum keeps one decimal, as the counter pills do. */
export function fmtPrimary(value, of, unit) {
  const u = unit ? ` ${unit}` : '';
  const x = num(value);
  if (x == null) return EN_DASH;
  const secs = unit === 's';
  const v = secs && of != null ? x.toFixed(1) : fmtNum(x, secs ? 1 : 2);
  return `${v}${of != null ? `/${fmtNum(of)}` : ''}${u}`;
}

/**
 * The score at the playhead, from the episode's state (`episode.score_head`, `episode.score_card`, `episode.counters`,
 * `episode.outcome`) and the playhead's sim time `tSim`:
 * `{head, card, ended, rows, value, text, mark, final, label, title}` or null for an episode without a scorecard.
 *
 * While the episode runs the value is the `value` of the last trial row with `t <= tSim`; a card whose rows do not carry it
 * falls back to the row's own primary field, then to the task's counter of the same key (the HUD line's, read up to the
 * playhead like every row); before the first row it is 0 when the primary has a maximum, else an en dash. Without a card
 * (a live run: the card comes with the episode's end) only a counter can say it, else the chip shows an en dash. Once the
 * episode has ended the card's own `primary.value` holds, with its verdict (`mark`: 'passed' | 'failed') and
 * `final: false` for a card kept from an episode that never reached its verdict. Such an episode has no end in its
 * rows: its recording's end (`opts.atEnd`, the replay's playhead at the last moment) stands for it.
 */
export function scoreView(e, tSim, opts = {}) {
  if (!isObj(e)) return null;
  const card = e.score_card ? normCard(e.score_card) : null;
  const head = e.score_head || (card ? { sentence: card.task, protocol: card.protocol, pass_rule: card.pass_rule,
    primary: card.primary } : null);
  if (!head && !card) return null;
  const primary = { ...(head ? head.primary : {}), ...(card ? card.primary : {}) };
  const ended = e.outcome != null || (!!card && !card.final && opts.atEnd === true);
  const t = num(tSim);
  const rows = card ? card.trials.filter((r) => {
    const rt = num(r.t);
    return rt == null ? ended : ended || (t != null && rt <= t + 1e-9);
  }) : [];
  const counter = (Array.isArray(e.counters) ? e.counters : []).find((c) => c && c.key === primary.key) || null;
  let value = null;
  let mark = null;
  if (ended && card) {
    value = card.primary.value;
    mark = card.passed === true ? 'passed' : card.passed === false ? 'failed' : null;
  } else {
    const last = rows.length ? rows[rows.length - 1] : null;
    if (last && card.has_value) value = last.value ?? null;
    else if (last && Object.prototype.hasOwnProperty.call(last, primary.key)) value = last[primary.key];
    else if (counter && counter.value != null) value = counter.value;
    else if (card && !rows.length && primary.of != null) value = 0;
  }
  // that the episode never reached its verdict is told at its end, like the verdict itself
  const final = card && ended ? card.final : true;
  const text = fmtPrimary(value, primary.of, primary.unit);
  const verdict = mark ? ` · ${mark}` : '';
  const title = `${primary.label}: ${text}${verdict}${final ? '' : ' (unfinished: the episode never reached its verdict)'}`
    + `${head && head.pass_rule ? `\n${head.pass_rule}` : ''}`;
  return { head, card, ended, rows, value, text, mark, final, label: primary.label, primary, title };
}

/** The trial rows in lines: rows that share one `n` (C-5: the eight pieces of a toss) are one group, in the rows' order. */
export function trialGroups(rows) {
  const out = [];
  const byN = new Map();
  for (const r of rows || []) {
    const n = r.n ?? null;
    const g = n != null ? byN.get(n) : null;
    if (g) {
      g.rows.push(r);
      continue;
    }
    const ng = { n, rows: [r] };
    if (n != null) byN.set(n, ng);
    out.push(ng);
  }
  return out;
}

/** A group's mark from its rows' `ok`: one row's own, else true when at least half of the rows that say went the player's
 * way (a toss with six of eight pieces turned), false when fewer did, null when none says. */
export function groupOk(rows) {
  const said = rows.filter((r) => typeof r.ok === 'boolean');
  if (!said.length) return null;
  const yes = said.filter((r) => r.ok).length;
  return 2 * yes >= said.length;
}

// ---- the lines of the Score block: per card a small table of the fields that say most --------------------------------------
const m2 = (v) => (num(v) == null ? null : `${fmtNum(Math.abs(num(v)), 2)} m`);
const cm = (v) => (num(v) == null ? null : fmtCm(v, 0));
const MISS_WORDS = { own_half: 'bounced on its own side', off_table: 'went off the table', not_touched: 'never touched',
  timeout: 'undecided at the limit', rest: 'came to rest' };
/** A missed ball's reason with its row's `touched`: "hit, but it went off the table", "never touched (it went off the table)". */
function ballMiss(r) {
  if (r.reason === 'off_table') return r.touched === true ? 'hit, but it went off the table'
    : r.touched === false ? 'never touched (it went off the table)' : MISS_WORDS.off_table;
  if (r.reason === 'own_half' && r.touched !== false) return "hit, but it bounced on the robot's own side";
  return MISS_WORDS[r.reason] || words(r.reason);
}
const PASS_WORDS = { taken: 'taken', passed: 'passed by', pinched_lost: 'pinched, then lost', off_belt: 'fell off the belt',
  running: 'still on the belt' };
const SWING_WORDS = { free: 'a free swing', knocked: 'knocked', pinched_lost: 'pinched, then lost', taken: 'taken',
  dropped: 'dropped' };

/** Where a ball came across the robot's end line, in words: + is the robot's left ("came 0.21 m left of centre"). */
export function cameWords(y) {
  const v = num(y);
  if (v == null) return null;
  if (Math.abs(v) < 0.01) return 'came down the middle';
  return `came ${m2(v)} ${v > 0 ? 'left' : 'right'} of centre`;
}

/** The tables, by the card's primary key (its component's name as the second guess: names are the preset's). `label`
 * names one row's line, `fields` gives its two to four words; a grouped card (`group`) also names the group's line. */
const TABLES = {
  returned: {      // C-4: one row per decided ball
    label: (r) => `ball ${r.n ?? '?'}`,
    fields: (r) => [r.outcome === 'returned' ? 'returned' : !r.reason ? 'missed' : ballMiss(r).startsWith('hit') ? ballMiss(r)
      : `missed: ${ballMiss(r)}`,
      cameWords(r.cross_y_m),
      r.outcome === 'returned' ? (num(r.land_along_m) != null ? `landed ${m2(r.land_along_m)} past the net` : null)
        : (r.touched !== true && num(r.miss_dist_m) != null ? `${cm(r.miss_dist_m)} from the blade` : null)],
  },
  laps: {          // C-1: one row per pass of the target
    label: (r) => `pass ${r.n ?? '?'}`,
    fields: (r) => [PASS_WORDS[r.outcome] || words(r.outcome), r.pinch_side ? `${r.pinch_side} hand` : null,
      num(r.gap_ahead_m) != null ? `${m2(r.gap_ahead_m)} behind the item ahead` : null],
  },
  points: {        // C-5: one row per piece and toss, grouped by the toss
    group: (n) => `toss ${n ?? '?'}`,
    label: (r) => `${r.piece ?? 'piece'}${r.vegetable ? ` ${r.vegetable}` : ''}`,
    fields: (r) => [r.point ? 'turned and caught' : r.lost ? 'lost' : r.in_toss === false ? 'not in the toss'
      : r.caught ? 'caught, not turned' : 'not caught',
    num(r.turn_deg) != null ? `turned ${fmtNum(r.turn_deg, 0)}°` : null,
    num(r.apex_m) != null ? `rose ${cm(r.apex_m)}` : null],
  },
  t_solved_s: {    // C-2: one row per cell the ball entered
    label: (r) => `cell ${r.cell ?? r.n ?? '?'}`,
    fields: (r) => [r.first_visit === false ? 'visited again' : 'first visit',
      r.on_shortest_route === false ? 'off the shortest route' : r.on_shortest_route === true ? 'on the shortest route' : null],
  },
  aloft_s: {       // C-3: one row per tap
    label: (r) => `tap ${r.n ?? '?'}`,
    fields: (r) => [r.by ? `by the ${r.by}` : null, num(r.z_m) != null ? `at ${m2(r.z_m)}` : null,
      num(r.apex_m) != null ? `rose to ${m2(r.apex_m)}` : null,
      num(r.dt_s) != null ? `${fmtNum(r.dt_s, 2)} s after the last` : null],
  },
  turns: {         // C-6: one row per turn of the swing, a last one for the take or the drop
    label: (r) => (r.outcome === 'taken' || r.outcome === 'dropped' ? String(r.outcome) : `turn ${r.n ?? '?'}`),
    fields: (r) => [r.side ? `${r.side} side` : null, SWING_WORDS[r.outcome] || words(r.outcome),
      num(r.amplitude_m) != null ? `${m2(r.amplitude_m)} out` : null,
      num(r.period_s) != null ? `period ${fmtNum(r.period_s, 2)} s` : null],
  },
};
const TABLE_BY_COMPONENT = { launcher: 'returned', belt: 'laps', toss: 'points', maze_judge: 't_solved_s',
  balloon_judge: 'aloft_s', swing: 'turns' };

function words(v) {
  return v == null ? null : String(v).replace(/_/g, ' ');
}

/** The table of a card: by its primary key, else its component's name, else null (the generic lines). */
export function tableOf(card) {
  if (!card) return null;
  const key = card.primary && card.primary.key;
  if (key && TABLES[key]) return TABLES[key];
  const byName = card.component ? TABLE_BY_COMPONENT[card.component] : null;
  return byName ? TABLES[byName] : null;
}

/** A metric's or a field's name in words and its value with the unit its name carries: `tap_interval_median_s` ->
 * ["tap interval median", "1.25 s"], `cells_entered_n` -> ["cells entered", "12"], `n_execute` -> ["execute count",
 * "1"], `maze` -> ["maze", "s2"]; null is an en dash, a flag yes / no, a string as it is. */
export function unitField(name, v) {
  const key = String(name);
  let label = key;
  let unit = '';
  let nd = 3;
  for (const [suffix, u, d] of [['_mps', 'm/s', 4], ['_deg', 'deg', 1], ['_s', 's', 3], ['_m', 'm', 4], ['_n', '', 0]]) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      label = key.slice(0, -suffix.length);
      unit = u;
      nd = d;
      break;
    }
  }
  // a count named the other way round (the run's `n_execute`): "execute count"
  if (unit === '' && /^n_./.test(label)) label = `${label.slice(2)} count`;
  label = label.replace(/_/g, ' ');
  let text;
  if (v == null) text = EN_DASH;
  else if (typeof v === 'boolean') text = v ? 'yes' : 'no';
  else if (num(v) != null && typeof v === 'number') text = `${fmtNum(v, nd)}${unit ? ` ${unit}` : ''}`;
  else if (Array.isArray(v)) text = v.length ? v.map(String).join(', ') : EN_DASH;
  else text = typeof v === 'object' ? short(JSON.stringify(v), 60) : String(v);
  return [label, text];
}

/** The generic line of a row of a card the page has no table for: its `outcome`, then its first scalar fields. */
function genericFields(r) {
  const out = [];
  if (r.outcome != null) out.push(words(r.outcome));
  for (const [k, v] of Object.entries(r)) {
    if (out.length >= 3) break;
    if (COMMON_KEYS.has(k) || k === 'outcome' || v == null || typeof v === 'object') continue;
    const [label, text] = unitField(k, v);
    out.push(typeof v === 'boolean' ? (v ? label : `not ${label}`) : `${label} ${text}`);
  }
  return out;
}

/** Every key of a row as "key: value" lines (a line's title: the record behind it). */
function rowTitle(r) {
  return Object.entries(r).map(([k, v]) => `${k}: ${v == null ? EN_DASH : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
}

/**
 * The lines of the Score block from the revealed rows, newest last: `[{key, n, t, ok, label, fields, title, rows?}]`. A
 * group (rows sharing one `n`) is one line, "toss 3 · 6 of 8" (the rows that went the player's way, of the group's rows),
 * with its rows as lines of their own under `rows`.
 */
export function trialLines(card, rows) {
  const table = tableOf(card);
  const one = (r, i) => {
    const fields = (table ? table.fields(r) : genericFields(r)).filter((x) => x != null && x !== '').slice(0, 4);
    return { key: `${r.n ?? 'x'}:${i}`, n: r.n ?? null, t: num(r.t), ok: typeof r.ok === 'boolean' ? r.ok : null,
      label: table ? table.label(r) : `trial ${r.n ?? i + 1}`, fields, title: rowTitle(r) };
  };
  return trialGroups(rows).map((g, gi) => {
    if (g.rows.length === 1) return one(g.rows[0], gi);
    const said = g.rows.filter((r) => typeof r.ok === 'boolean');
    const yes = said.filter((r) => r.ok).length;
    const t = Math.max(...g.rows.map((r) => num(r.t) ?? -Infinity));
    return { key: `g${g.n}`, n: g.n, t: Number.isFinite(t) ? t : null, ok: groupOk(g.rows),
      label: table && table.group ? table.group(g.n) : `trial ${g.n}`,
      fields: [said.length ? `${yes} of ${g.rows.length}` : `${g.rows.length} rows`],
      title: `${g.rows.length} rows${said.length ? `, ${yes} went the player's way` : ''}`,
      rows: g.rows.map((r, i) => one(r, i)) };
  });
}

/** The card's metrics as `[[label, value text, name]]` in the card's order (units from the names; `unitField`). */
export function metricRows(metrics) {
  if (!isObj(metrics)) return [];
  return Object.entries(metrics).map(([k, v]) => [...unitField(k, v), k]);
}

/** The time bar's trial ticks, `[{t, ok}]` in seconds of the bar (`relAt` maps a sim time to them): one per distinct `n` at
 * its last row's time, marked by the group's `ok`; past TICKS_ALL_MAX trials only those that went one way or the other. */
export function scoreTicks(card, relAt) {
  const c = card && card.trials ? card : normCard(card);
  if (!c || typeof relAt !== 'function') return [];
  const groups = trialGroups(c.trials.filter((r) => num(r.t) != null)).map((g) => ({
    t: Math.max(...g.rows.map((r) => num(r.t))), ok: groupOk(g.rows) }));
  const list = groups.length > TICKS_ALL_MAX ? groups.filter((g) => g.ok != null) : groups;
  return list.map((g) => ({ t: relAt(g.t), ok: g.ok })).filter((g) => num(g.t) != null);
}

/** The variant a card names (C-4's level of the balls, C-6's swing, C-1's stream, C-2's maze), for the header's scene
 * line ("level L2"), or ''. */
export function levelText(card) {
  const m = card && isObj(card.metrics) ? card.metrics : null;
  if (!m) return '';
  for (const [key, word] of LEVEL_KEYS) {
    if (typeof m[key] === 'string' && m[key].trim()) return `${word} ${m[key].trim()}`;
  }
  return '';
}

/** The score an episode index entry carries (`{label, value, of, unit, better, passed, final}`, written when the index is
 * rebuilt) beside its title in the picker: "8/10 balls returned ✓", "time to solve 29.4 s ✗", "… (unfinished)"; '' for an
 * entry without one. */
export function pickerScore(score) {
  if (!isObj(score) || (score.label == null && score.value == null)) return '';
  const label = str(score.label) ?? 'score';
  const of = num(score.of);
  const unit = str(score.unit) ?? '';
  const head = of != null ? `${fmtPrimary(score.value, of, '').trim()} ${label}`
    : `${label} ${fmtPrimary(score.value, null, unit)}`;
  const mark = score.passed === true ? ' ✓' : score.passed === false ? ' ✗' : '';
  return `${head}${mark}${score.final === false ? ' (unfinished)' : ''}`;
}
