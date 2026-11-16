// The pipeline reducer over a recorded episode (docs/design/WEB_HUD.md section 9, "JavaScript"):
//
//   node web/tests/test_pipeline.mjs
//
// The checks of the C scenes (contract H3, 2026-11-13) run on hand-made rows shaped like the real ones: a `papers` task's
// status rows with their goal predicates and component counters, the scene components' events, and the real-time lane's
// traces (its re-plans several times a second, its key moments, a looping run); the plan overlay is driven at 5 Hz when
// three.js is installed (web/node_modules).
//
// The scorecard (contract H4, 2026-11-15): the chip, the Score block's lines, the time bar's trial ticks and the picker's
// score, on synthetic cards (a count with a maximum, a card kept unfinished, a live run's card at the episode's end) and on
// cards cut from fresh runs (web/tests/fixtures/scores: scripted C-2 and C-3 episodes and a step-clock C-5 run, each
// file naming its run in `source`); the scene machines' new events as feed lines.
//
// The fixture is a real sweep run (tabletop_random, seed 3, Claude as the player: a reach that JEV refuses twice, then
// a grasp and a carry that succeed and are kept in the motion memory), exported as a replay bundle with the camera
// images stripped (two are kept). Every check runs on the rows exactly as a replay delivers them; the exit status is
// non-zero when any check fails. The replay bundle the page ships (web/episodes/tabletop_random_s3, a later run of the
// same scene with the engine's `plan` records and the player's transcript) is checked too when it is present, and so
// are three runs of the papers' fourth development sweep (web/episodes/paper_sweep_4: 007 with two watch splices, 002
// with two holds while the engine asked the decider; 016 from its sweep timeline when its bundle is absent): the
// re-edits and the watch as the engine records them since 2026-11-09. A check whose recording is absent is skipped.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initialState, reduce, tick, rowActor, learnedIds, menuSummary, holdRows, watchVerdict, changeWords, FEED_MAX,
  EVENTS_MAX, PULSES_MAX, STEPS_MAX, taskPills, taskShape, hudCounters, rtCountText, CLASSIC_PREDICATES, swingArc, swingMeeting,
  swingView, rtWatchText, SWING_MEET_LINGER_S, missWords, noMeetingWords, meetWhyWords, armedWords } from '../src/model/pipeline.js';
import { SPEEDS, createPlayer } from '../src/transport/replay.js';
import { engineStatus, engineTag, watchLine, jevBadges, runCountsText, spliceChanged, rtReasonLine } from '../src/hud/panel.js';
import { pickMimeType, recordingName } from '../src/util/recorder.js';
import { decisionFields, bindingsText } from '../src/util/format.js';
import { scoreView, normCard, fmtPrimary, trialLines, groupOk, metricRows, scoreTicks, levelText, pickerScore, unitField,
  TICKS_ALL_MAX } from '../src/model/score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, 'fixtures', 'tabletop_random_s3', 'episode.json');
const episode = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
const ROWS = episode.rows;
const REAL_BUNDLE = path.join(HERE, '..', 'episodes', 'tabletop_random_s3', 'episode.json');
const real = fs.existsSync(REAL_BUNDLE) ? JSON.parse(fs.readFileSync(REAL_BUNDLE, 'utf8')) : null;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e]);
  }
}
const skipped = [];
function skip(name, why) {
  skipped.push([name, why]);
}

/** A fresh state with the bundle's library (minus what the recording learns), as the replay transport builds it. */
function fresh() {
  const s = initialState();
  const learned = learnedIds(ROWS);
  reduce(s, { kind: 'library', items: episode.library.filter((it) => !learned.has(it.id)) });
  return s;
}

/** Reduce rows until `stop(row, index)` is true (the stopping row included); returns [state, index]. */
function reduceUntil(stop, s = fresh()) {
  for (let i = 0; i < ROWS.length; i++) {
    reduce(s, ROWS[i]);
    if (stop(ROWS[i], i)) return [s, i];
  }
  throw new Error('the stopping row never came');
}

const isResult = (tool) => (r) => r.kind === 'lab/tool_result' && r.tool_id === tool;
const isStart = (tool) => (r) => r.kind === 'reasoning/tool_status' && r.state === 'starting' && r.tool_id === tool;

/** Section 4.1's hand `plan` record for the accepted reach, synthesized (the fixture predates the plan trace). */
function planRow(t, tWall, reedit = false) {
  const line = (a, b, n) => Array.from({ length: n }, (_, i) => a.map((v, k) => +(v + ((b[k] - v) * i) / (n - 1)).toFixed(4)));
  const start = [0.05, -0.32, 0.92];
  const goal = [0.27, -0.27, 0.78];
  return {
    kind: 'research/jev_trace', trace_kind: 'plan', t, t_wall: tWall, channel: 'hand', motion: 'reach_side_right',
    arm: 'right', object_ref: 'obj:cylinder_0', entry_s: 0.0097, grasp_s: 0.82, duration_s: 9.91, D: 0.0833, goal,
    ghost: line(start, [0.3, -0.24, 0.8], 32), edited: line(start, goal, 32), path: line(start, goal, 64),
    points: [start, [0.16, -0.3, 0.86], goal], roles: ['start', 'via', 'grasp'], reedit,
  };
}

// ---- the menu --------------------------------------------------------------------------------------------------------
test('the recorder picks the first container the browser records, and names the file after the episode', () => {
  const only = (...types) => ({ isTypeSupported: (t) => types.includes(t) });
  assert.equal(pickMimeType(only('video/webm', 'video/webm;codecs=vp9', 'video/mp4')), 'video/webm;codecs=vp9');
  assert.equal(pickMimeType(only('video/webm;codecs=vp8', 'video/webm')), 'video/webm;codecs=vp8');
  assert.equal(pickMimeType(only('video/mp4')), 'video/mp4');
  assert.equal(pickMimeType(only()), null);
  assert.equal(pickMimeType({ isTypeSupported: () => { throw new Error('unknown'); } }), null);
  assert.equal(pickMimeType(undefined), null);
  const at = new Date(2026, 10, 2, 9, 5, 7);
  assert.equal(recordingName('interesting/003_tabletop_random_s3_claude', 'video/webm;codecs=vp9', at),
    'interesting_003_tabletop_random_s3_claude_20261102-090507.webm');
  assert.equal(recordingName('live', 'video/mp4', at), 'live_20261102-090507.mp4');
});

test('the first jev_query_options result leaves a menu of 14 candidates', () => {
  const [s] = reduceUntil(isResult('jev_query_options'));
  assert.equal(s.jev.menu.candidates.length, 14);
  assert.equal(s.jev.menu.building, false);
  assert.equal(s.jev.menu.intent, 'reach');
  assert.equal(s.jev.menu.target, 'obj:cylinder_0');
  const fit = s.jev.menu.candidates.filter((c) => c.feasible).map((c) => c.motion);
  assert.deepEqual(fit, ['reach_top_right', 'right_reach', 'retract_left', 'retract_right', 'kneel_reach_top_right',
    'kneel_retract_left', 'kneel_retract_right']);
  const side = s.jev.menu.candidates.find((c) => c.motion === 'reach_side_right');
  assert.equal(side.feasible, false);
  assert.equal(side.reason, 'undecided');
  assert.equal(s.memory.candidates.length, 14);
  assert.equal(s.llm.phase, 'thinking');
  assert.ok(s.pulses.some((p) => p.from === 'jev' && p.to === 'llm' && p.label === 'menu · 14'));
});

test('while JEV builds the menu, every candidate it decides is folded into the menu (not the decision card)', () => {
  const [s] = reduceUntil((r) => r.kind === 'research/jev_trace' && r.context === 'options');
  assert.equal(s.jev.menu.building, true);
  assert.equal(s.jev.menu.candidates.length, 1);
  assert.equal(s.jev.menu.candidates[0].pending, true);
  assert.equal(s.jev.decision, null);
  assert.equal(s.jev.busy, 'menu');
  assert.equal(s.llm.phase, 'asking');
  assert.ok(s.pulses.some((p) => p.from === 'llm' && p.to === 'jev' && p.label === 'intent · reach'));
  assert.ok(s.pulses.some((p) => p.from === 'memory' && p.to === 'jev'));
});

// ---- the LLM's choice and JEV's decision ---------------------------------------------------------------------------------
test('the jev_execute of reach_side_right records the choice with its insight', () => {
  const [s] = reduceUntil((r) => isStart('jev_execute')(r) && r.arguments?.motion?.anchor === 'reach_side_right');
  const c = s.llm.choice;
  assert.equal(c.motion, 'reach_side_right');
  assert.deepEqual(c.allowed, ['right_reach', 'reach_top_right']);
  assert.deepEqual(c.bindings, { hands: 'obj:cylinder_0' });
  assert.match(c.insight, /^Firm side grasp with the pad about 3 cm below the top/);
  assert.equal(c.wait, false);
  assert.equal(s.llm.phase, 'choosing');
  assert.equal(s.jev.busy, 'deciding');
  assert.ok(s.pulses.some((p) => p.from === 'llm' && p.to === 'jev' && p.label === 'chose reach_side_right · insight'));
});

test('a decision trace with context execute fills the decision card', () => {
  const [s, i] = reduceUntil((r) => r.kind === 'research/jev_trace' && r.trace_kind === 'decision' && r.context === 'execute'
    && r.motion === 'reach_side_right');
  const d = s.jev.decision;
  assert.equal(d.motion, 'reach_side_right');
  assert.equal(d.context, 'execute');
  assert.equal(d.kind, 'decision');
  assert.equal(d.decider, 'model');
  assert.equal(d.arm, 'right');
  assert.equal(d.object_ref, 'obj:cylinder_0');
  assert.equal(d.decision.face, 'side');
  assert.equal(d.decision.pinch, 'clip');
  assert.equal(d.t_wall, ROWS[i].t_wall);
  assert.ok(d.decision.min_confidence < 0.05);
});

test('JEV refuses the first reach (undecided) and tells the LLM', () => {
  const [s] = reduceUntil((r) => r.kind === 'research/jev_event' && r.event === 'fail');
  assert.equal(s.jev.refusal.reason, 'undecided');
  assert.equal(s.jev.refusal.motion, 'reach_side_right');
  assert.equal(s.jev.refusal.why, 'the decider is not confident enough to act');
  assert.equal(s.jev.n_redecisions, 3);
  assert.equal(s.jev.busy, null);
  assert.equal(s.engine.run?.motion === 'reach_side_right', false, 'a refusal never starts a run');
  assert.ok(s.pulses.some((p) => p.from === 'jev' && p.to === 'llm' && p.label === 'refused: undecided'));
  // the answer that follows repeats the refusal: no second pulse
  const [s2] = reduceUntil((r, k) => isResult('jev_execute')(r) && r.result?.reason === 'undecided');
  assert.equal(s2.pulses.filter((p) => p.label === 'refused: undecided').length, 1);
});

// ---- JEV's steps (section 11.2) ------------------------------------------------------------------------------------------
const isFirstSideReach = (r) => isStart('jev_execute')(r) && r.arguments?.motion?.anchor === 'reach_side_right';

test('the menu step counts the 14 candidates by fit, undecided and reason', () => {
  const [s, i] = reduceUntil(isResult('jev_query_options'));
  const text = 'judged 14 candidates for “reach” on obj:cylinder_0 · 7 fit · 3 undecided · 4 out of reach';
  assert.equal(s.jev.steps.length, 1);
  assert.equal(s.jev.steps[0].kind, 'menu');
  assert.equal(s.jev.steps[0].text, text);
  assert.equal(menuSummary(s.jev.menu), text);
  // the question opened the command: its start is the steps' time origin
  const q = ROWS.findIndex(isStart('jev_query_options'));
  assert.equal(s.jev.steps_cmd_t_wall, ROWS[q].t_wall);
  assert.ok(s.jev.steps[0].t_wall > ROWS[q].t_wall && s.jev.steps[0].t_wall <= ROWS[i].t_wall);
});

test('the first reach_side_right execute: command, decision, fallbacks, three re-decisions, an undecided refusal', () => {
  const k = ROWS.findIndex(isFirstSideReach);
  const [s] = reduceUntil((r) => r.kind === 'research/jev_event' && r.event === 'fail');
  const steps = s.jev.steps;
  assert.deepEqual(steps.map((x) => x.kind),
    ['command', 'decision', 'fallback', 'fallback', 'redecision', 'redecision', 'redecision', 'refusal']);
  assert.equal(s.jev.steps_total, 8);
  assert.equal(s.jev.steps_cmd_t_wall, ROWS[k].t_wall);
  assert.equal(steps[0].text, 'LLM chose reach_side_right · with an insight · undecided on the menu');
  assert.match(steps[1].text, /^decided · side grasp · pad 4\.4 cm · elevation 30° · yaw 0° · conf 0\.01$/);
  assert.equal(steps[2].text, 'fell back to right_reach · decided conf 0.01');
  assert.equal(steps[3].text, 'fell back to reach_top_right · decided conf 1.00');
  // each re-decision names the fields that changed from the decision before it (of the same motion)
  assert.equal(steps[4].text, 'collision predicted → re-decided · yaw 0° → 15° · lift 0 cm → 6 cm · conf 1.00');
  assert.equal(steps[5].text, 'collision predicted → re-decided · yaw 15° → 30° · lift 6 cm → 3 cm · conf 1.00');
  assert.equal(steps[6].text, 'collision predicted → re-decided · yaw 30° → 45° · lift 3 cm → 6 cm · conf 1.00');
  assert.equal(steps[7].text, 'refused · undecided · the decider is not confident enough to act');
  assert.deepEqual(steps.map((x) => x.tone), [null, null, null, null, 'warn', 'warn', 'warn', 'fail']);
  // the snapshots the card and the pill follow while a step is the one revealed
  assert.equal(steps[1].decision.motion, 'reach_side_right');
  assert.equal(steps[3].decision.motion, 'reach_top_right');
  assert.equal(steps[6].decision, s.jev.decision);
  assert.equal(steps[7].refusal, s.jev.refusal);
  assert.equal(steps[7].refusal.reason, 'undecided');
  for (let n = 1; n < steps.length; n++) assert.ok(steps[n].id > steps[n - 1].id && steps[n].t_wall >= steps[n - 1].t_wall);
});

test('a new command starts a new step list; a plan record is a step', () => {
  const [s] = reduceUntil((r, i) => i > ROWS.findIndex(isFirstSideReach) && isStart('look_at')(r));
  assert.equal(s.jev.steps.length, 8, 'a tool that is not JEV leaves the steps');
  const [s2] = reduceUntil((r, i) => i > ROWS.findIndex(isFirstSideReach) && isStart('jev_execute')(r));
  assert.deepEqual(s2.jev.steps.map((x) => x.kind), ['command']);
  const k = ROWS.findIndex((r) => isResult('jev_execute')(r) && r.result?.execute?.accepted && r.result.execute.motion === 'reach_side_right');
  const s3 = fresh();
  for (let i = 0; i < k; i++) reduce(s3, ROWS[i]);
  reduce(s3, planRow(78.3, ROWS[k].t_wall - 0.05));
  const last = s3.jev.steps[s3.jev.steps.length - 1];
  assert.equal(last.kind, 'plan');
  assert.equal(last.text, 'edited to the scene · D 0.08 · 9.9 s → handed to the engine');
  assert.equal(last.tone, 'ok');
  reduce(s3, planRow(84.0, ROWS[k].t_wall + 4, true));
  assert.equal(s3.jev.steps[s3.jev.steps.length - 1], last, 'the plan of a re-edit makes no step of its own');
});

test('re-edits, mid-run runs and watch interventions are steps; the list keeps the last eight', () => {
  const s = initialState();
  reduce(s, { kind: 'reasoning/tool_status', state: 'starting', tool_id: 'jev_execute', call_id: 'c1', t: 1, t_wall: 100,
    arguments: { motion: 'reach_side_right', bindings: { hands: 'obj:cylinder_0' } } });
  reduce(s, planRow(1.2, 100.2));
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'reedit', installed: true, t: 2, t_wall: 101, motion: 'reach_side_right',
    phase: 0.31, object_moved_m: 0.048 });
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'chain', installed: true, t: 3, t_wall: 102, motion: 'reach_side_right',
    entry_s: 0.42, n_runs: 2 });
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'watch', t: 3, t_wall: 102.01, motion: 'reach_side_right',
    entry: { phase: 0.42, p: 0.62, intervene: true, applied: true, why: 'p=0.62 above 0.50: intervene' } });
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'watch', t: 4, t_wall: 103, motion: 'reach_side_right',
    entry: { phase: 0.5, p: 0.02, intervene: false, why: 'p=0.02 below 0.50: carry on' } });
  assert.deepEqual(s.jev.steps.map((x) => [x.kind, x.text, x.tone]), [
    ['command', 'LLM chose reach_side_right', null],
    ['plan', 'edited to the scene · D 0.08 · 9.9 s → handed to the engine', 'ok'],
    ['reedit', 'object moved 4.8 cm → re-edited at phase 0.31', 'warn'],
    ['chain', 're-decided mid-run → run 2 from phase 0.42', 'warn'],
    ['watch', 'watch · p 0.62 → intervened', 'warn'],
  ]);
  // the run counts its checks and the ones that intervened (the watch line's verdict once the run is over)
  assert.equal(s.engine.run.n_watch, 2);
  assert.equal(s.engine.run.n_intervene, 1);
  for (let i = 0; i < 20; i++) {
    reduce(s, { kind: 'research/jev_trace', trace_kind: 'reedit', installed: true, t: 5 + i, t_wall: 104 + i,
      motion: 'reach_side_right', phase: 0.5 });
  }
  assert.equal(s.jev.steps.length, STEPS_MAX);
  assert.equal(s.jev.steps_total, 25);
  assert.equal(s.jev.steps[STEPS_MAX - 1].id, s.step_seq);
});

// ---- the camera image (section 11.5) ---------------------------------------------------------------------------------------
test('the LLM image goes stale when the head moves after it and fresh with the next image', () => {
  const firstImage = (r) => isResult('get_camera_image')(r) && r.result?._png?.b64;
  const [s] = reduceUntil(firstImage);
  assert.equal(s.llm.image.stale, false);
  const [s2] = reduceUntil((r) => r.kind === 'research/jev_trace' && r.trace_kind === 'run_end' && r.channel === 'gaze'
    && r.t_wall > s.llm.image.t_wall);
  assert.equal(s2.llm.image.t_wall, s.llm.image.t_wall);
  assert.equal(s2.llm.image.stale, true, 'a gaze run ended after the image');
  const [s3] = reduceUntil((r) => firstImage(r) && r.t_wall > s2.llm.image.t_wall);
  assert.equal(s3.llm.image.stale, false, 'a new image is fresh');
  const [s4] = reduceUntil(isResult('look_at'));
  assert.equal(s4.llm.image.stale, true, 'look_at turned the head after the image');
  // a gaze run that ends before the image does not make it stale
  const t = initialState();
  reduce(t, { kind: 'research/jev_trace', trace_kind: 'run_end', channel: 'gaze', motion: 'look_down', outcome: 'success', t: 1, t_wall: 10 });
  reduce(t, { kind: 'lab/tool_result', tool_id: 'get_camera_image', call_id: 'c', t: 2, t_wall: 11, result: { success: true, _png: { b64: 'AA==', bytes: 1 } } });
  reduce(t, { kind: 'research/jev_trace', trace_kind: 'run_end', channel: 'hand', motion: 'right_reach', outcome: 'success', t: 3, t_wall: 12 });
  assert.equal(t.llm.image.stale, false, 'a hand run does not move the head');
  reduce(t, { kind: 'lab/tool_result', tool_id: 'set_head', call_id: 'd', t: 4, t_wall: 13, result: { success: true } });
  assert.equal(t.llm.image.stale, true);
});

test('the replay speeds include half speed', () => {
  assert.deepEqual(SPEEDS, [0.5, 1, 2, 4]);
});

// ---- the engine's run, the plan, the memory ------------------------------------------------------------------------------
test('a plan record lands in state.jev.plan and starts the run; a re-edit plan replaces it', () => {
  const k = ROWS.findIndex((r) => isResult('jev_execute')(r) && r.result?.execute?.accepted && r.result.execute.motion === 'reach_side_right');
  assert.ok(k > 0);
  const s = fresh();
  for (let i = 0; i < k; i++) reduce(s, ROWS[i]);
  const plan = planRow(78.3, ROWS[k].t_wall - 0.05);
  const seq0 = s.jev.plan_seq;
  reduce(s, plan);
  assert.equal(s.jev.plan, plan);
  assert.equal(s.jev.plan_seq, seq0 + 1);
  assert.equal(s.engine.run.motion, 'reach_side_right');
  assert.equal(s.engine.run.channel, 'hand');
  assert.equal(s.engine.run.source, 'plan');
  assert.equal(s.engine.run.duration_s, 9.91);
  assert.equal(s.memory.active, 'reach_side_right');
  assert.equal(s.jev.busy, null);
  assert.equal(s.llm.phase, 'executing');
  reduce(s, ROWS[k]);                                     // the accepted answer: the run keeps its plan source
  assert.equal(s.engine.run.source, 'plan');
  assert.equal(s.pulses.filter((p) => p.from === 'jev' && p.to === 'engine' && p.t_wall >= plan.t_wall).length, 1);
  assert.equal(s.llm.phase, 'executing');
  const re = planRow(84.0, ROWS[k].t_wall + 4, true);
  reduce(s, re);
  assert.equal(s.jev.plan, re);
  assert.equal(s.engine.run.source, 'plan', 'a re-edit keeps the run going');
  tick(s, { t: 78.3 + 4.955, t_wall: ROWS[k].t_wall + 5 });
  assert.ok(Math.abs(s.engine.run.phase - (0.0097 + 4.955 * (1 - 0.0097) / 9.91)) < 1e-6);
});

test('a run end with accumulated grows the memory', () => {
  const [s] = reduceUntil((r) => r.kind === 'research/jev_trace' && r.trace_kind === 'run_end' && r.accumulated);
  assert.deepEqual(s.memory.added, ['reach_side_right_acc01']);
  const child = s.memory.items.find((it) => it.id === 'reach_side_right_acc01');
  assert.ok(child);
  assert.equal(child.accumulated_from, 'reach_side_right');
  assert.equal(child.channel, 'hand');
  assert.equal(s.memory.active, null);
  assert.equal(s.engine.run.outcome, 'success');
  assert.equal(s.engine.run.ended, true);
  assert.ok(s.pulses.some((p) => p.from === 'engine' && p.to === 'memory' && p.label === 'kept as reach_side_right_acc01'));
});

test('the watch line counts the watch judgements of the running motion', () => {
  const [s] = reduceUntil((r) => r.kind === 'research/jev_trace' && r.trace_kind === 'watch' && Math.abs(r.entry.phase - 0.4593) < 1e-3);
  assert.equal(s.jev.watch.n, 4);
  assert.equal(s.jev.watch.verdict, 'carry on');
  assert.equal(s.jev.watch.intervene, false);
  assert.equal(s.engine.run.n_watch, 4);
  assert.ok(Math.abs(s.engine.run.phase - 0.4593) < 1e-3);
});

test('task/episode_end sets the outcome to success and the LLM to done', () => {
  const [s] = reduceUntil((r) => r.kind === 'task/episode_end');
  assert.equal(s.episode.outcome, 'success');
  assert.equal(s.episode.message, 'all predicates hold');
  assert.deepEqual(s.episode.predicates, { in_region: true, at_rest: true, on_surface: true, released: true });
  assert.equal(s.llm.phase, 'done');
  // a tool answer after the end keeps the LLM done
  for (const r of ROWS.slice(ROWS.findIndex((r) => r.kind === 'task/episode_end') + 1)) reduce(s, r);
  assert.equal(s.llm.phase, 'done');
  assert.deepEqual(s.memory.added, ['reach_side_right_acc01', 'carry_right_across_acc01']);
});

// ---- time -----------------------------------------------------------------------------------------------------------------
test('thinking seconds accumulate through tick()', () => {
  const [s, i] = reduceUntil(isResult('jev_query_options'));
  const tw = ROWS[i].t_wall;
  assert.equal(s.llm.thinking_s, 0);
  const total0 = s.llm.thinking_total_s;
  tick(s, { t_wall: tw + 1.5, t: null });
  assert.ok(Math.abs(s.llm.thinking_s - 1.5) < 1e-9);
  tick(s, { t_wall: tw + 4.0, t: null });
  assert.ok(Math.abs(s.llm.thinking_s - 4.0) < 1e-9);
  assert.ok(Math.abs(s.llm.thinking_total_s - (total0 + 4.0)) < 1e-9);
  // the next call closes the gap: its length is kept in the total
  const next = ROWS.findIndex((r, k) => k > i && r.kind === 'reasoning/tool_status' && r.state === 'starting');
  for (let k = i + 1; k <= next; k++) reduce(s, ROWS[k]);
  assert.equal(s.llm.gap_t_wall, null);
  assert.ok(Math.abs(s.llm.thinking_total_s - (total0 + (ROWS[next].t_wall - tw))) < 1e-6);
  assert.ok(s.feed.some((l) => /^thinks \d+\.\d s$/.test(l.text)));
});

test('the running motion phase is extrapolated by tick() and stops while paused', () => {
  const s = initialState();
  reduce(s, planRow(10, 1000));
  tick(s, { t: 12, t_wall: 1002 });
  const p1 = s.engine.run.phase;
  assert.ok(p1 > 0.0097 && p1 < 0.3);
  reduce(s, { kind: 'research/jev_event', event: 'scene_changed', t: 12, t_wall: 1002, motion: 'reach_side_right',
    object: 'obj:cylinder_0', displacement_m: 0.042, paused: true, change: 'moved' });
  assert.equal(s.engine.run.paused, true);
  assert.ok(s.pulses.some((p) => p.from === 'engine' && p.to === 'llm' && p.label === 'scene changed'));
  tick(s, { t: 20, t_wall: 1010 });
  assert.equal(s.engine.run.phase, p1);
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'resume', t: 21, t_wall: 1011, motion: 'reach_side_right',
    why: 'the decision stands', paused_s: 9, phase: p1 });
  assert.equal(s.engine.run.paused, false);
  tick(s, { t: 22, t_wall: 1012 });
  assert.ok(s.engine.run.phase > p1);
});

// ---- determinism and bounds ------------------------------------------------------------------------------------------------
test('re-reducing the same rows gives a deep-equal state', () => {
  const run = () => {
    const s = fresh();
    for (const r of ROWS) {
      reduce(s, r);
      if (r.t_wall != null) tick(s, { t_wall: r.t_wall + 0.25, t: r.t ?? null });
    }
    return s;
  };
  const a = run();
  const b = run();
  assert.deepStrictEqual(a, b);
  assert.ok(a.feed.length > 50);
  assert.ok(a.pulses.length > 10);
  assert.ok(a.step_seq > 20, 'the steps are part of the state that must come out the same');
  assert.deepStrictEqual(a.jev.steps, b.jev.steps);
});

test('the feed, the engine events and the pulses stay bounded', () => {
  const s = initialState();
  reduce(s, planRow(0, 0));
  for (let i = 0; i < 3000; i++) {
    reduce(s, { kind: 'research/jev_trace', trace_kind: 'watch', t: i * 0.1, t_wall: i * 0.1, motion: 'reach_side_right',
      entry: { phase: (i % 100) / 100, p: 0.01, intervene: false, why: 'p=0.01 below 0.50: carry on' } });
    reduce(s, { kind: 'research/jev_event', event: 'stalled', t: i * 0.1, t_wall: i * 0.1, motion: 'reach_side_right', phase: 0.5 });
    reduce(s, { kind: 'research/jev_trace', trace_kind: 'reedit', installed: true, t: i * 0.1, t_wall: i * 0.1,
      motion: 'reach_side_right', phase: 0.5 });
  }
  assert.equal(s.feed.length, FEED_MAX);
  assert.equal(s.engine.events.length, EVENTS_MAX);
  assert.equal(s.pulses.length, PULSES_MAX);
  assert.equal(s.feed[s.feed.length - 1].n, s.feed_seq);
  assert.ok(s.engine.run.watch_marks.length <= 64);
});

test('pseudo-rows hand over the library, the scene and the robot mode', () => {
  const s = initialState();
  reduce(s, { kind: 'library', items: episode.library });
  assert.equal(s.memory.items.length, 52);
  assert.deepEqual([...new Set(s.memory.items.map((it) => it.channel))].sort(), ['base', 'gaze', 'hand', 'root']);
  reduce(s, { kind: 'scene', scene: { name: 'tabletop_random', nq: 43 } });
  assert.equal(s.episode.scene, 'tabletop_random');
  reduce(s, { kind: 'robot', mode: 'teleop_walk_control_module', state: 'ACTIVE' });
  assert.equal(s.engine.mode, 'teleop_walk_control_module');
  assert.equal(s.engine.control, 'ACTIVE');
});

test('rows that get a tick on the time bar', () => {
  const actors = ROWS.map(rowActor).filter(Boolean);
  for (const a of ['llm', 'jev', 'engine', 'memory', 'task', 'fail']) assert.ok(actors.includes(a), a);
  assert.equal(actors.filter((a) => a === 'memory').length, 2);
});

test('world rows: a gate closing and the mover\'s steps are feed lines and time-bar ticks', () => {
  const s = fresh();
  const base = { t_wall: 1792916000, t: 40 };
  const gate = { kind: 'scene/gate', ...base, name: 'hall', state: 'closed', from_side: '-x', geom_id: 12, pos: [1.5, 0, 1],
    quat: [1, 0, 0, 0] };
  const teleStart = { kind: 'scene/object_motion', ...base, t: 41, step: 0, mode: 'teleport', object: 'target_0', state: 'started',
    reason: 'start_s', from: [0.6, 0.1, 0.76], to: [0.6, -0.2, 0.76], geom_id: 6, pos: [0.6, -0.2, 0.76], quat: [1, 0, 0, 0] };
  const teleEnd = { ...teleStart, state: 'finished', reason: 'teleport' };
  const driftStart = { kind: 'scene/object_motion', ...base, t: 42, step: 1, mode: 'drift', object: 'cylinder_0', state: 'started',
    reason: 'robot_near', from: [0.5, 0, 0.8], to: [0.62, 0, 0.8] };
  const driftEnd = { ...driftStart, t: 44, state: 'finished', reason: 'distance', to: [0.6234, 0.0012, 0.8] };
  const n0 = s.feed.length;
  for (const r of [gate, teleStart, teleEnd, driftStart, driftEnd]) reduce(s, r);
  const lines = s.feed.slice(n0);
  assert.deepEqual(lines.map((l) => l.who), ['world', 'world', 'world', 'world']);
  assert.deepEqual(lines.map((l) => l.text), [
    'gate hall closed behind the robot',
    'the target target_0 moved (teleport) → (0.60, -0.20)',
    'cylinder_0 starts to move (drift)',
    'cylinder_0 moved (drift) → (0.62, 0.00) · distance',
  ]);
  assert.equal(lines[0].t, 40);
  assert.deepEqual([gate, teleStart, teleEnd, driftStart, driftEnd].map(rowActor), ['world', null, 'world', null, 'world']);
  // a recording made before the rows carried the marker's geom: the scene dict's region names tell the target apart
  reduce(s, { kind: 'scene', scene: { name: 'tabletop_random', regions: [{ name: 'target_0', geom_id: 6 }] } });
  const old = { ...teleEnd };
  for (const k of ['geom_id', 'pos', 'quat']) delete old[k];
  reduce(s, old);
  assert.equal(s.feed[s.feed.length - 1].text, 'the target target_0 moved (teleport) → (0.60, -0.20)');
});

// ---- the shipped replay bundle (plan records, the player's transcript) -------------------------------------------------------
if (real) {
  const reduceReal = () => {
    const s = initialState();
    const learned = learnedIds(real.rows);
    reduce(s, { kind: 'library', items: real.library.filter((it) => !learned.has(it.id)) });
    const seen = [];
    for (const r of real.rows) {
      const before = s.step_seq;
      reduce(s, r);
      for (const x of s.jev.steps) if (x.id > before) seen.push(x);
    }
    return [s, seen];
  };

  test('the shipped bundle: plan steps, the insight on the right_reach command, the steps re-reduce the same', () => {
    const [s, seen] = reduceReal();
    assert.ok(real.rows.some((r) => r.kind === 'research/jev_trace' && r.trace_kind === 'plan'));
    assert.ok(real.rows.some((r) => String(r.kind).startsWith('player/')));
    const plans = seen.filter((x) => x.kind === 'plan').map((x) => x.text);
    assert.ok(plans.some((t) => t.startsWith('edited to the scene · D 0.08 · 6.2 s')), plans.join(' | '));
    assert.ok(plans.includes('aimed look_down → handed to the engine'), plans.join(' | '));
    const cmd = seen.filter((x) => x.kind === 'command' && x.text.startsWith('LLM chose right_reach'));
    assert.ok(cmd.length >= 1);
    for (const x of cmd) assert.match(x.text, /^LLM chose right_reach · with an insight/);
    assert.ok(seen.some((x) => x.kind === 'refusal' && x.text === 'refused · collision_predicted · the head is turned into the arm\'s way'));
    assert.ok(s.pulses.some((p) => p.from === 'llm' && p.to === 'jev' && p.label === 'chose right_reach · insight'));
    const [again] = reduceReal();
    assert.deepStrictEqual(again, s);
  });
}

// ---- the re-edits and the watch (contract H1, 2026-11-09) ----------------------------------------------------------------
const trace = (kind, o) => ({ kind: 'research/jev_trace', trace_kind: kind, ...o });

/** A command whose hand motion runs: the execute call, its decision (elevation 30°, yaw 0°) and the plan (t 10, wall 1000). */
function runningReach(motion = 'reach_side_left') {
  const s = initialState();
  reduce(s, { kind: 'reasoning/tool_status', state: 'starting', tool_id: 'jev_execute', call_id: 'c1', t: 9, t_wall: 999,
    arguments: { motion, bindings: { hands: 'obj:target' } } });
  reduce(s, trace('decision', { context: 'execute', motion, arm: 'left', object_ref: 'obj:target', t: 9.5, t_wall: 999.5,
    decision: { face: 'side', pinch: 'clip', pad_from_top_m: 0.01, elevation_deg: 30, yaw_deg: 0, via_lift_m: 0, speed: 'normal',
      min_confidence: 0.5 } }));
  reduce(s, { ...planRow(10, 1000), motion, arm: 'left' });
  return s;
}

/** The watch's changed decision spliced into the running motion, as bundle 007 records it at t 50.26. */
const SPLICE = trace('reedit', { t: 12, t_wall: 1002, motion: 'reach_side_left', installed: true, new_decision: true, phase: 0.2499,
  entry_s: 0.2066, object_moved_m: 0.0388, target: 'obj:target', splice_latency_s: 0.587, decision_age_s: 0,
  decision: { face: 'side', pinch: 'clip', pad_from_top_m: 0.01, elevation_deg: 45, yaw_deg: 15, waist: true, via_lift_m: 0,
    speed: 'normal', close: 'near', min_confidence: 0.67, decider: 'decisions',
    dimensions: ['pinch', 'pad_from_top_m', 'elevation_deg', 'yaw_deg', 'via_lift_m', 'waist', 'speed', 'close'] },
  change: { kind: 'decision', from: { pad_from_top_m: 0.01, elevation_deg: 30, yaw_deg: 0 },
    to: { pad_from_top_m: 0.01, elevation_deg: 45, yaw_deg: 15 }, source: 'watch' } });

test('a spliced decision is its own step and mark, the card takes its values, and it has a badge of its own', () => {
  const s = runningReach();
  reduce(s, trace('reedit', { t: 11, t_wall: 1001, motion: 'reach_side_left', installed: true, new_decision: false, phase: 0.1,
    entry_s: 0.1, object_moved_m: 0.039 }));
  reduce(s, SPLICE);
  reduce(s, trace('watch', { t: 12, t_wall: 1002.01, motion: 'reach_side_left', entry: { t: 12, phase: 0.25, p: 0.61, intervene: true,
    applied: true, spliced: true, changed: ['elevation_deg'], splice_latency_s: 0.587,
    why: 'p=0.61: elevation_deg changed; model: cell clip|0.010|45; yaw-symmetric grasp: a yaw tie is not doubt' } }));
  const text = 'watch changed the decision → spliced in 0.59 s · elevation 30° → 45° · yaw 0° → 15°';
  // the follow before it stays a re-edit; the spliced watch entry makes no step of its own (the splice is the step)
  assert.deepEqual(s.jev.steps.slice(-2).map((x) => [x.kind, x.text, x.tone]), [
    ['reedit', 'object moved 3.9 cm → re-edited at phase 0.10', 'warn'],
    ['splice', text, 'warn'],
  ]);
  const run = s.engine.run;
  assert.deepEqual(run.reedit_marks, [0.1]);
  assert.deepEqual(run.splice_marks, [{ phase: 0.2499, text }], 'a mark of its own, its step as the tooltip');
  const d = s.jev.decision;
  assert.equal(d.kind, 'splice');
  assert.equal(d.decision.elevation_deg, 45);
  assert.equal(d.decision.yaw_deg, 15);
  assert.equal(d.decider, 'model');
  assert.equal(d.arm, 'left');
  assert.equal(d.object_ref, 'obj:target');
  assert.equal(s.jev.steps[s.jev.steps.length - 1].decision, d, 'the card follows the splice step');
  assert.deepEqual([...spliceChanged(d)].sort(), ['elevation_deg', 'yaw_deg'], 'the fields that glow (the pad did not change)');
  assert.equal(spliceChanged(s.jev.steps.find((x) => x.kind === 'decision').decision), null);
  assert.deepEqual(jevBadges(s).map((b) => `${b[0]} ${b[1]}`), ['re-edited ×1', 'spliced ×1']);
  assert.equal(watchLine(s).text, 'watching every tick · check 1 · p 0.61 → spliced in 0.59 s');
  assert.ok(s.pulses.some((p) => p.from === 'jev' && p.to === 'engine' && p.label === 'spliced'));
});

test('a jev_modify splice names the LLM, body and close-gate re-edits are named, and only follows count as re-edited', () => {
  const s = runningReach('carry_left_forward');
  const m = 'carry_left_forward';
  reduce(s, trace('reedit', { t: 12, t_wall: 1002, motion: m, installed: true, new_decision: true, phase: 0.7061, entry_s: 0.4133,
    splice_latency_s: 0.215, decision: { clearance_m: 0.01, point: 'centre', level: 'keep', yaw_deg: 0, via_lift_m: 0,
      dimensions: ['clearance_m', 'point', 'level', 'yaw_deg'] },
    change: { kind: 'decision', source: 'modify', from: { clearance_m: 0.04, point: 'nearest' }, to: { clearance_m: 0.01, point: 'centre' } } }));
  reduce(s, trace('reedit', { t: 13, t_wall: 1003, motion: m, installed: true, new_decision: false, phase: 0.8, entry_s: 0.78,
    change: { kind: 'body' } }));
  reduce(s, trace('reedit', { t: 14, t_wall: 1004, motion: m, installed: true, new_decision: false, phase: 0.9, entry_s: 0.88,
    change: { kind: 'off_goal' } }));
  // a change only in a dimension the card does not show is still named
  reduce(s, trace('reedit', { t: 15, t_wall: 1005, motion: m, installed: true, new_decision: true, phase: 0.92,
    change: { kind: 'decision', source: 'watch', from: { close: 'between_pads' }, to: { close: 'near' } } }));
  assert.deepEqual(s.jev.steps.slice(-4).map((x) => x.text), [
    'LLM changed the decision → spliced in 0.21 s · clearance 4.0 cm → 1.0 cm · nearest → centre',
    'body moved → re-edited',
    'off goal → re-edited',
    'watch changed the decision → spliced · close between pads → near',
  ]);
  assert.equal(s.jev.decision.decision.point, 'centre', 'a splice without a decision record leaves the card as it was');
  assert.deepEqual(jevBadges(s).map((b) => `${b[0]} ${b[1]}`), ['spliced ×2']);
  // a re-edit while the run is paused answers the pause (a jev_modify), it is no follow
  reduce(s, { kind: 'research/jev_event', event: 'scene_changed', t: 16, t_wall: 1006, motion: m, object: 'obj:target',
    displacement_m: 0.04, paused: true, change: 'moved' });
  reduce(s, trace('reedit', { t: 17, t_wall: 1007, motion: m, installed: true, new_decision: true, phase: 0.92, object_moved_m: 0.04 }));
  assert.equal(s.jev.reedits, 0);
  reduce(s, trace('resume', { t: 17, t_wall: 1007.01, motion: m, phase: 0.92 }));
  reduce(s, trace('reedit', { t: 18, t_wall: 1008, motion: m, installed: true, new_decision: false, phase: 0.95, object_moved_m: 0.05 }));
  assert.deepEqual(jevBadges(s).map((b) => `${b[0]} ${b[1]}`), ['re-edited ×1', 'spliced ×2']);
});

test('the watch line and its steps read the entry flags, never the tail of the decider\'s why', () => {
  const cases = [
    [{ p: 0.51, intervene: false, stands: true, why: 'p=0.51 but the decision stands: model: a yaw tie is not doubt' }, 'decision stands'],
    [{ p: 0.61, intervene: true, applied: true, spliced: true, splice_latency_s: 0.587, why: 'p=0.61: a yaw tie is not doubt' },
      '→ spliced in 0.59 s'],
    [{ p: 0.7, intervene: true, applied: false, refused: 'out_of_reach', why: 'p=0.70: x: y' }, 'change refused (out of reach)'],
    [{ p: 0.7, intervene: true, applied: false, refused: 'chain_exhausted', why: 'p=0.70: x: y' }, 'budget spent'],
    [{ p: 0.04, intervene: false, applied: false, held: 'the playhead held for the engine\'s own re-decision',
      why: 'p=0.04 below 0.50: carry on' }, 'held'],
    [{ p: 0.8, intervene: true, applied: false, late: 'the grasp had begun', why: 'p=0.80: x: y' }, 'not applied (the grasp had begun)'],
    [{ requests: 0, error: '_PlanFailure(\'binding_not_found\')' }, 'no answer'],
    [{ p: 0.02, intervene: false, why: 'p=0.02 below 0.50: carry on' }, 'carry on'],
    [{ p: 0.62, intervene: true, applied: true, why: 'p=0.62 above 0.50: intervene' }, 'intervened'],
  ];
  for (const [e, words] of cases) assert.equal(watchVerdict(e), words, JSON.stringify(e));
  const s = runningReach();
  cases.forEach(([e], i) => reduce(s, trace('watch', { t: 11 + i, t_wall: 1001 + i, motion: 'reach_side_left',
    entry: { phase: 0.1 + 0.05 * i, ...e } })));
  // the interventions are steps, the spliced one excepted (its re-edit is the step); the checks that pass are not
  assert.deepEqual(s.jev.steps.filter((x) => x.kind === 'watch').map((x) => x.text), [
    'watch · p 0.70 → change refused (out of reach)',
    'watch · p 0.70 → budget spent',
    'watch · p 0.80 → not applied (the grasp had begun)',
    'watch · p 0.62 → intervened',
  ]);
  assert.equal(watchLine(s).text, 'watching every tick · check 9 · p 0.62 · intervened');
  reduce(s, trace('watch', { t: 30, t_wall: 1020, motion: 'reach_side_left', entry: { phase: 0.6, p: 0.51, stands: true, intervene: false } }));
  assert.equal(watchLine(s).text, 'watching every tick · check 10 · p 0.51 · decision stands');
  assert.equal(s.engine.run.n_watch, 10, 'the check counter counts every entry, as before');
});

/** The engine's own re-decision in a job: a refused follow at t 12 asks, the answer lands at `landT` (wall 1004.2) after the
 * playhead held `heldS`; `after` are the rows of the landing's tick. The motion is the plan row's (reach_side_right). */
function asyncRows(heldS, after, extra = {}, landT = 12 + heldS) {
  const m = 'reach_side_right';
  return [
    trace('reedit', { t: 12, t_wall: 1002, motion: m, installed: false, new_decision: false, phase: 0.2, reason: 'collision_predicted' }),
    trace('watch', { t: 13.5, t_wall: 1003.4, motion: m, entry: { phase: 0.2, p: 0.04, intervene: false, applied: false,
      held: 'the playhead held for the engine\'s own re-decision' } }),
    trace('redecision', { t: landT, t_wall: 1004.2, context: 'execute', motion: m, arm: 'right', object_ref: 'obj:target',
      async: true, asked_t: 12, asked_phase: 0.2, redecision_latency_s: 1.9, held_s: heldS, change: { kind: 'moved' },
      decision: { face: 'side', pinch: 'clip', pad_from_top_m: 0.03, elevation_deg: 30, yaw_deg: 60, via_lift_m: 0, min_confidence: 0.8 },
      ...extra }),
    ...after.map((r, i) => ({ ...r, t: landT, t_wall: 1004.4 + 0.1 * i, motion: m })),
  ];
}

test('a hold: the replay adds it at the asking tick, the bar stands and the watch rests until the answer lands', () => {
  const rows = [planRow(10, 1000), ...asyncRows(2.4, [trace('reedit', { installed: true, new_decision: true, phase: 0.21, entry_s: 0.2,
    object_moved_m: 0.41 })])];
  assert.deepEqual(holdRows(rows), [{ kind: 'hold', motion: 'reach_side_right', t: 12, t_wall: 1002, why: 'object moved', phase: 0.2,
    held_s: 2.4 }]);
  // the replay plays it right after the rows of the tick that asked
  const order = createPlayer({ meta: {}, rows, frames: null }).rows;
  assert.deepEqual(order.map((r) => (r.kind === 'hold' ? 'hold' : r.trace_kind)), ['plan', 'reedit', 'hold', 'watch', 'redecision', 'reedit']);
  const s = initialState();
  for (const r of order.slice(0, 3)) reduce(s, r);
  const run = s.engine.run;
  assert.deepEqual(run.held, { why: 'object moved', since: 12 });
  assert.equal(run.phase, 0.2);
  tick(s, { t: 13.9, t_wall: 1003.9 });
  assert.equal(run.phase, 0.2, 'the playhead holds');
  assert.equal(engineTag(s), 'held · asking the decider (object moved)');
  assert.equal(watchLine(s).text, 'resting');
  reduce(s, order[3]);                           // a verdict that lands during the hold
  assert.equal(s.jev.watch.verdict, 'held');
  assert.equal(watchLine(s).text, 'resting');
  reduce(s, order[4]);                           // the answer lands: the hold ends
  assert.equal(run.held, null);
  const step = s.jev.steps[s.jev.steps.length - 1];
  assert.equal(step.kind, 'redecision');
  assert.equal(step.text, 're-decided in 1.9 s · held 2.4 s');
  assert.equal(step.decision, s.jev.decision);
  reduce(s, order[5]);                           // its re-edit tells the outcome and makes no step of its own
  assert.equal(s.jev.steps[s.jev.steps.length - 1], step);
  assert.equal(step.text, 're-decided in 1.9 s · held 2.4 s → re-edited');
  assert.equal(engineTag(s), 'running');
  assert.equal(s.jev.reedits, 1, 'the re-edit it installed follows the moved object');
  tick(s, { t: 15.4, t_wall: 1005.4 });
  assert.ok(run.phase > 0.2, 'the playhead plays on');
});

test('a landed re-decision tells how it ended: paused, the decision stands, played on, not applied', () => {
  const land = (heldS, after, extra, landT) => {
    const s = initialState();
    for (const r of [planRow(10, 1000), ...asyncRows(heldS, after, extra, landT)]) reduce(s, r);   // as live delivers them
    return s;
  };
  const last = (s) => s.jev.steps[s.jev.steps.length - 1].text;
  const paused = land(2.4, [trace('reedit', { installed: false, new_decision: true, phase: 0.2, reason: 'collision_predicted' }),
    { kind: 'research/jev_event', event: 'scene_changed', object: 'obj:target', displacement_m: 0.5, paused: true, change: 'moved',
      diagnostics: { reason: 'collision_predicted' } }]);
  assert.equal(last(paused), 're-decided in 1.9 s · held 2.4 s → paused');
  assert.equal(engineStatus(paused), 'Paused: object moved · the LLM decides');
  const stands = land(2.4, [trace('reedit', { installed: true, new_decision: false, phase: 0.2, entry_s: 0.2 })]);
  assert.equal(last(stands), 're-decided in 1.9 s · held 2.4 s → the decision stands');
  const playedOn = land(0, [trace('reedit', { installed: true, new_decision: true, phase: 0.3, entry_s: 0.28 })], {}, 12.8);
  assert.equal(last(playedOn), 're-decided in 1.9 s while the motion played on → re-edited');
  assert.deepEqual(holdRows([planRow(10, 1000), ...asyncRows(0, [], {}, 12.8)]), [], 'a plan that played on held nothing');
  const late = land(0, [], { dropped: 'late' }, 12.8);
  assert.equal(last(late), 're-decided in 1.9 s while the motion played on → not applied (the grasp had begun)');
  assert.equal(late.jev.decision, null, 'an answer that landed too late changes no card');
});

test('a hand run\'s outcome line ends with its counts; a gaze run and an older run end carry none', () => {
  const c = { n_reedits: 7, n_reedits_follow: 6, n_reedits_body: 0, n_reedits_off_goal: 0, n_reedits_decision: 1, n_watch_passes: 4,
    n_watch_changes: 1, splice_latency_max_s: 0.192, n_redecisions_async: 0, redecision_latency_max_s: null, held_total_s: 0 };
  assert.equal(runCountsText(c), ' · 7 re-edits (6 follow · 1 decision) · watch 4 checks, 1 change');
  assert.equal(runCountsText({ ...c, n_redecisions_async: 2, held_total_s: 3.21 }),
    ' · 7 re-edits (6 follow · 1 decision) · watch 4 checks, 1 change · asked the decider 2×, held 3.2 s');
  assert.equal(runCountsText({ ...c, n_reedits: 0, n_reedits_follow: 0, n_reedits_decision: 0, n_watch_passes: 3, n_watch_changes: 0 }),
    ' · watch 3 checks, 0 changes');
  assert.equal(runCountsText(null), '');
  const s = runningReach();
  reduce(s, trace('run_end', { t: 23.5, t_wall: 1013.5, channel: 'hand', motion: 'reach_side_left', arm: 'left', outcome: 'success',
    duration_s: 13.5, phase: 1, ...c }));
  assert.equal(engineStatus(s), 'reach_side_left succeeded in 13.5 s · 7 re-edits (6 follow · 1 decision) · watch 4 checks, 1 change');
  reduce(s, trace('run_end', { t: 30, t_wall: 1020, channel: 'gaze', motion: 'look_down', outcome: 'success', duration_s: 2.3 }));
  assert.equal(engineStatus(s), 'look_down succeeded in 2.3 s');
  reduce(s, trace('run_end', { t: 40, t_wall: 1030, channel: 'hand', motion: 'right_reach', outcome: 'fail', reason: 'grasp_missed',
    duration_s: 6.2, n_reedits: 2 }));
  assert.equal(engineStatus(s), 'right_reach failed: grasp_missed', 'a run end recorded before the counts');
});

test('a pause names its cause and who decides now, and why no decider was asked when the engine says so', () => {
  const pause = (change, diagnostics = {}) => {
    const s = runningReach();
    reduce(s, { kind: 'research/jev_event', event: 'scene_changed', t: 12, t_wall: 1002, motion: 'reach_side_left', object: 'obj:target',
      displacement_m: 0.05, paused: true, change, diagnostics });
    return engineStatus(s);
  };
  assert.equal(pause('moved'), 'Paused: object moved · the LLM decides');
  assert.equal(pause('moved', { decider: 'not asked: the grasp stage had begun', reason: 'out_of_reach' }),
    'Paused: object moved · no re-decision (the grasp had begun) · the LLM decides');
  assert.equal(pause('shape', { decider: 'no answer' }), 'Paused: shape changed · the decider gave no answer · the LLM decides');
  assert.equal(pause('body'), 'Paused: body moved · the LLM decides');
  assert.equal(pause('off_goal'), 'Paused: off goal · the LLM decides');
  assert.equal(pause(undefined), 'Paused: the scene changed · the LLM decides', 'a recording without the change kind');
  assert.equal(changeWords('pushed'), 'object pushed');
});

// ---- the papers' fourth development sweep (web/episodes/paper_sweep_4), when present -----------------------------------------
const SWEEP4 = path.join(HERE, '..', 'episodes', 'paper_sweep_4');
/** A run's rows: its bundle, else (when given) its sweep timeline; null when neither is here. */
function sweepRows(id, timeline = null) {
  const b = path.join(SWEEP4, id, 'episode.json');
  if (fs.existsSync(b)) return JSON.parse(fs.readFileSync(b, 'utf8')).rows;
  if (timeline && fs.existsSync(timeline)) return fs.readFileSync(timeline, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return null;
}

/** Reduce rows as the replay plays them (wall order, the holds among them): the state, every step made (with its final
 * text), the engine's status line at every pause and hand run end, and each hand run's splice marks. */
function replayRows(rows) {
  const s = initialState();
  const seen = [];
  const statuses = [];
  const marks = [];
  for (const r of createPlayer({ meta: {}, rows, frames: null }).rows) {
    const before = s.step_seq;
    reduce(s, r);
    for (const x of s.jev.steps) if (x.id > before) seen.push(x);
    if (r.kind === 'research/jev_event' && r.event === 'scene_changed' && r.paused) statuses.push(engineStatus(s));
    if (r.trace_kind === 'run_end' && r.channel === 'hand') {
      statuses.push(engineStatus(s));
      marks.push(s.engine.run.splice_marks.map((m) => m.phase));
    }
  }
  return { s, seen, statuses, marks };
}

const ID007 = '007_papers-a21_moving_capture_s9002_claude';
const rows007 = sweepRows(ID007);
if (rows007) {
  test('bundle 007: the two watch splices are steps with marks and the card, the outcome lines carry the counts', () => {
    const { s, seen, statuses, marks } = replayRows(rows007);
    const splices = seen.filter((x) => x.kind === 'splice');
    assert.deepEqual(splices.map((x) => x.text), [
      'watch changed the decision → spliced in 0.59 s · elevation 30° → 45° · yaw 0° → 15°',
      'watch changed the decision → spliced in 0.19 s · elevation 45° → 30° · yaw -60° → -30°',
    ]);
    assert.deepEqual(splices.map((x) => [x.decision.kind, x.decision.decision.elevation_deg, x.decision.decision.yaw_deg]),
      [['splice', 45, 15], ['splice', 30, -30]]);
    assert.ok(!seen.some((x) => x.kind === 'watch'), 'both interventions were spliced: no watch step besides');
    assert.deepEqual(marks.slice(0, 2), [[0.2499], [0.8582]]);
    assert.deepEqual(statuses.slice(0, 2), [
      'reach_side_left failed: grasp_missed · 17 re-edits (16 follow · 1 decision) · watch 18 checks, 1 change',
      'reach_side_left succeeded in 13.5 s · 7 re-edits (6 follow · 1 decision) · watch 4 checks, 1 change',
    ]);
    assert.equal(s.jev.splices, 2);
    assert.equal(s.jev.reedits, 22, 'the follows of both runs (16 + 6, the engine\'s own counts)');
  });
} else skip('bundle 007', `${ID007} is not under web/episodes/paper_sweep_4`);

const ID002 = '002_papers-a11_teleport_grasp_s9003_claude';
const rows002 = sweepRows(ID002);
if (rows002) {
  test('bundle 002: two holds while the engine asked the decider, the arm standing, the landings and the counts', () => {
    assert.deepEqual(holdRows(rows002).map((x) => [x.motion, x.t, x.held_s, x.why]),
      [['reach_side_left', 70.84, 3.78, 'object moved'], ['reach_side_right', 88.92, 2.82, 'object moved']]);
    const { s, seen, statuses } = replayRows(rows002);
    assert.deepEqual(seen.filter((x) => /^re-decided (in|while)/.test(x.text)).map((x) => x.text), [
      're-decided in 2.9 s · held 3.8 s → paused',
      're-decided in 2.4 s · held 2.8 s → re-edited',
    ]);
    assert.ok(statuses.includes('Paused: object moved · the LLM decides'), statuses.join(' | '));
    assert.ok(statuses.includes('reach_side_right succeeded in 52.0 s · 6 re-edits (2 follow · 2 off goal · 1 decision) · watch 15 checks, '
      + '1 change · asked the decider 1×, held 2.8 s'), statuses.join(' | '));
    // inside the first hold: the bar stands at the phase it asked at, the watch rests
    const h = initialState();
    const order = createPlayer({ meta: {}, rows: rows002, frames: null }).rows;
    const k = order.findIndex((r) => r.kind === 'hold');
    for (const r of order.slice(0, k + 1)) reduce(h, r);
    tick(h, { t: 72.5, t_wall: order[k].t_wall + 1.5 });
    assert.equal(h.engine.run.phase, 0.0566);
    assert.equal(engineTag(h), 'held · asking the decider (object moved)');
    assert.equal(watchLine(h).text, 'resting');
    assert.deepStrictEqual(replayRows(rows002).s, s, 'the holds and the landings re-reduce the same');
  });
} else skip('bundle 002', `${ID002} is not under web/episodes/paper_sweep_4`);

const ID016 = '016_papers-b2a_clear_goal_s9002_claude';
const rows016 = sweepRows(ID016, path.join(HERE, '..', '..', 'logs', 'sweeps', 'papers_dev_4', ID016, 'timeline_0_9002.jsonl'));
if (rows016) {
  test('run 016: a pause in the grasp stage says no decider was asked; body and close-gate re-edits are named', () => {
    const { seen, statuses } = replayRows(rows016);
    assert.ok(statuses.includes('Paused: object moved · no re-decision (the grasp had begun) · the LLM decides'), statuses.join(' | '));
    assert.ok(statuses.includes('Paused: body moved · the LLM decides'), statuses.join(' | '));
    assert.ok(seen.some((x) => x.text === 'body moved → re-edited'));
    assert.ok(seen.some((x) => x.text === 'off goal → re-edited'));
    assert.ok(statuses.includes('right_reach failed: stop · 4 re-edits (1 body · 2 off goal) · watch 6 checks, 0 changes'), statuses.join(' | '));
  });
} else skip('run 016', `${ID016}: neither its bundle nor its sweep timeline is here`);

// ---- the C scenes (contract H3, 2026-11-13): task progress, component events, the real-time lane ------------------------------
const status = (t, predicates, hudLine, st = 'running') => ({ kind: 'task/status', t, t_wall: 2000 + t, status: st, predicates,
  hud_line: hudLine, t_elapsed: t - 1, message: '', episode: 1 });
const pillsOf = (s) => taskPills(s.episode).map((p) => `${p.kind === 'counter' ? '#' : ''}${p.label}${p.on ? '+' : ''}`);

test('task pills: a classic task keeps today\'s four, a papers goal is a pill, a component goal a counter that fills', () => {
  const classic = initialState();
  assert.deepEqual(pillsOf(classic), CLASSIC_PREDICATES, 'nothing known yet: the classic four, off');
  reduce(classic, status(5, { in_region: true, at_rest: false, on_surface: true, released: false }, 'waiting (in_region, on_surface)'));
  assert.deepEqual(pillsOf(classic), ['in_region+', 'at_rest', 'on_surface+', 'released']);
  assert.equal(taskPills(classic.episode)[1].title, 'at_rest: does not hold');

  assert.deepEqual(hudCounters('waiting (goal_0, goal_1) | tosses 3/5, solved -/1'), [
    { key: 'tosses', text: '3', value: 3, at_text: '5', at_least: 5 },
    { key: 'solved', text: '-', value: null, at_text: '1', at_least: 1 }]);
  assert.equal(hudCounters('waiting (goal_0)'), null);
  assert.equal(hudCounters('TASK: SUCCESS'), null);

  // C-5: one component goal; the HUD line carries its counter, the throttled value as the task last let it change
  const s = initialState();
  reduce(s, { kind: 'scene', scene: { name: 'papers/c5_pan_toss' } });
  assert.deepEqual(pillsOf(s), [], 'a papers scene before its first status row: no classic pills');
  reduce(s, status(1, { goal_0: false, hold: false }, 'waiting | tosses -/5'));
  assert.deepEqual(pillsOf(s), ['#tosses -/5', 'hold']);
  const p0 = taskPills(s.episode)[0];
  assert.equal(p0.frac, 0);
  assert.equal(p0.width, 'tosses 5/5'.length, 'the counter keeps the width of its widest label');
  reduce(s, status(20, { goal_0: false, hold: false }, 'waiting | tosses 2/5'));
  assert.deepEqual(pillsOf(s), ['#tosses 2/5', 'hold']);
  assert.ok(Math.abs(taskPills(s.episode)[0].frac - 0.4) < 1e-9);
  assert.equal(taskPills(s.episode)[0].title, 'goal_0 · tosses: 2 of at least 5');
  reduce(s, status(60, { goal_0: true, hold: false }, 'waiting (goal_0) | tosses 5/5'));
  assert.deepEqual(pillsOf(s), ['#tosses 5/5+', 'hold']);
  reduce(s, status(61, { goal_0: true, hold: true }, 'TASK: SUCCESS', 'success'));
  assert.deepEqual(pillsOf(s), ['#tosses 5/5+', 'hold+'], 'the verdict\'s line has no counters: the last ones stay');
  reduce(s, { kind: 'task/episode_end', t: 61, t_wall: 2061, task: 'papers', status: 'success', predicates: { goal_0: true, hold: true } });
  assert.equal(taskPills(s.episode).length, 2, 'the pills never change their number at the end');

  // B-3's two place goals: plain pills; a lift goal with a component goal beside it: the counter follows the goals
  const b3 = initialState();
  reduce(b3, status(5, { goal_0: true, goal_1: false, hold: false }, 'waiting (goal_0)'));
  assert.deepEqual(pillsOf(b3), ['goal_0+', 'goal_1', 'hold']);
  const mixed = initialState();
  reduce(mixed, status(5, { goal_0: false, goal_1: false, hold: false }, 'waiting | taken 1/3'));
  assert.deepEqual(pillsOf(mixed), ['goal_0', 'goal_1', '#taken 1/3', 'hold'], 'which goal a counter is the row does not say');
  assert.equal(taskPills(mixed.episode)[2].on, false);

  // a task with predicates of its own (tabletop_grasp) shows them
  const grasp = initialState();
  reduce(grasp, status(5, { grasped: true, lifted: false }, 'waiting (grasped)'));
  assert.deepEqual(pillsOf(grasp), ['grasped+', 'lifted']);
});

test('task pills: a replay knows them from the start (task_shape), and re-reducing gives the same pills', () => {
  const rows = [
    { kind: 'meta', t: 1, t_wall: 2001, scene: 'papers/c2_ball_maze', seed: 3 },
    status(40, { goal_0: false, hold: false }, 'waiting | solved 0/1'),
    status(90, { goal_0: true, hold: false }, 'waiting (goal_0) | solved 1/1'),
    { kind: 'task/episode_end', t: 91, t_wall: 2091, task: 'papers', status: 'success', predicates: { goal_0: true, hold: true },
      hud_line: 'TASK: SUCCESS' },
  ];
  const shape = taskShape(rows);
  assert.deepEqual(shape, { kind: 'task_shape', keys: ['goal_0', 'hold'],
    counters: [{ key: 'solved', text: '0', value: 0, at_text: '1', at_least: 1 }] }, 'nothing counted before the first status row');
  assert.equal(taskShape([{ kind: 'meta' }]), null);
  const s = initialState();
  reduce(s, shape);
  assert.deepEqual(pillsOf(s), ['#solved 0/1', 'hold'], 'before the first status row');
  for (const r of rows) reduce(s, r);
  assert.deepEqual(pillsOf(s), ['#solved 1/1+', 'hold+']);
  const again = initialState();
  reduce(again, shape);
  for (const r of rows) reduce(again, r);
  assert.deepStrictEqual(again.episode, s.episode);
  // an older papers recording: its two status rows come at the end, the shape names its pills from the start
  const old = sweepRows('002_papers-a11_teleport_grasp_s9003_claude');
  if (old) assert.deepEqual(taskShape(old).keys, ['goal_0', 'hold']);
});

/** `scene/component` rows as the timeline writes them (the payload's own `kind`, the component's, becomes `trace_kind`). */
const comp = (kind, component, event, o = {}) => ({ kind: 'scene/component', t: 30, t_wall: 2030, component, trace_kind: kind,
  event, event_id: 'comp-9', host_ns: 1, ...o });

test('component events: World lines for what a viewer cares about, nothing for the noisy ones, ticks for the judge\'s counts', () => {
  const s = initialState();
  const n0 = s.feed.length;
  const noisy = [
    // C-1's real rows (the S3 run): a belt spawning and retiring items
    comp('conveyor', 'belt', 'spawn', { object: 'item_12', lateral_m: 0.01372, yaw: 5.664501, n: 1 }),
    comp('conveyor', 'belt', 'retire', { object: 'item_12', reason: 'exit' }),
    comp('maze', 'maze_judge', 'cell', { cell: 'b2', from: 'b1' }),
    comp('conveyor', 'belt', 'speed', { speed_mps: 0.12 }),
    comp('ball_launcher', 'launcher', 'touch', { ball: 'ball_03', n: 3, by: 'paddle' }),
    comp('ball_launcher', 'launcher', 'retire', { ball: 'ball_03', reason: 'still' }),
    comp('conveyor', 'belt', 'jammed', { object: 'item_02' }),                  // an event the page does not know
    comp('maze', 'maze_judge', 'taken', { object: 'x' }),                       // a known event of another component kind
  ];
  for (const r of noisy) reduce(s, r);
  assert.equal(s.feed.length, n0, s.feed.slice(n0).map((l) => l.text).join(' | '));
  assert.deepEqual(noisy.map(rowActor), noisy.map(() => null));

  const said = [
    [comp('conveyor', 'belt', 'taken', { object: 'item_07', gripper: 'right' }), 'item_07 taken off the belt (right hand)'],
    [comp('maze', 'maze_judge', 'solved'), 'the ball rests in the cup: the maze is solved'],
    [comp('maze', 'maze_judge', 'ball_off'), 'the ball fell off the maze board'],
    [comp('pan_toss', 'toss', 'toss', { n: 3, counted: true, kept: 8, of: 8, apex_min_m: 0.12, apex_mean_m: 0.15, tosses: 2 }),
      'toss 3: 8 of 8 back in the pan · counted, 2 so far'],
    [comp('pan_toss', 'toss', 'toss', { n: 4, counted: false, kept: 5, of: 8, tosses: 2 }), 'toss 4: 5 of 8 back in the pan · not counted'],
    [comp('pan_toss', 'toss', 'lost', { piece: 'veg_3', pos: [0.4, 0.1, 0.01] }), 'veg_3 fell out of the pan'],
    [comp('ball_launcher', 'launcher', 'launch', { ball: 'ball_04', n: 4 }), 'ball 4 launched'],
    [comp('ball_launcher', 'launcher', 'returned', { ball: 'ball_04', n: 4, along_m: 1.9, across_m: 0.1 }), 'ball 4 returned over the net'],
    [comp('ball_launcher', 'launcher', 'missed', { ball: 'ball_05', n: 5, reason: 'not_touched' }), 'ball 5 missed (not touched)'],
    [comp('grip_assist', 'grip', 'grip_on', { grip: 'paddle_grip', object: 'paddle', hand: 'right', relpose: 'measured' }),
      'the grip assist locks paddle to the right hand'],
    [comp('grip_assist', 'grip', 'grip_off', { grip: 'paddle_grip', object: 'paddle', hand: 'right', reason: 'opened' }),
      'the grip assist lets go of paddle (the hand opened)'],
    // tolerant of missing fields, and of a row without the component kind
    [{ kind: 'scene/component', t: 31, t_wall: 2031, event: 'toss' }, 'a toss ended'],
    [{ kind: 'scene/component', t: 31, t_wall: 2031, event: 'returned' }, 'a ball returned over the net'],
  ];
  for (const [r, text] of said) {
    reduce(s, r);
    const line = s.feed[s.feed.length - 1];
    assert.equal(line.text, text);
    assert.equal(line.who, 'world');
  }
  assert.equal(s.feed.length, n0 + said.length);
  assert.deepEqual(said.map(([r]) => rowActor(r)), ['world', 'world', null, 'world', 'world', null, null, 'world', null, null, null,
    'world', 'world']);
});

const RT = 'keep_up';
/** The real-time lane's hand plan (rt.py `plan_fields`: the clip's duration, `rt`), its edit shifted by `dx` (a re-aim). */
function rtPlan(t, tw, reedit, dx = 0, extra = {}) {
  const p = { ...planRow(t, tw, reedit), motion: RT, arm: 'right', object_ref: 'obj:balloon', entry_s: 0, rt: true, duration_s: 1.2,
    ...extra };
  p.edited = p.edited.map(([x, y, z]) => [+(x + dx).toFixed(4), y, z]);
  return p;
}
const rtGaze = (t, tw, reedit) => trace('plan', { t, t_wall: tw, channel: 'gaze', motion: RT, points: [[0, 0], [0.3, 0.1]],
  duration_s: 0, reedit, rt: true });
const rtReedit = (t, tw, phase) => trace('reedit', { t, t_wall: tw, motion: RT, installed: true, phase, change: { kind: 'follow' },
  n_edits: 3, rt: true, t_hit: t + 0.4, p_hit: [0.4, -0.2, 1.1] });

/** A real-time run (keep_up, both tracks) re-planned at 5 Hz for two seconds, its phase wrapping once; the execute's answer
 * says it loops when `loopAnswer`. Returns the state and the rows. */
function rtRun(loopAnswer) {
  const s = initialState();
  const rows = [
    { kind: 'reasoning/tool_status', state: 'starting', tool_id: 'jev_execute', call_id: 'k1', t: 9, t_wall: 999,
      arguments: { motion: RT, bindings: { target: 'obj:balloon' } } },
    trace('decision', { context: 'execute', motion: RT, arm: 'right', object_ref: 'obj:balloon', t: 10, t_wall: 1000,
      decision: { speed: 'normal' }, rt: true }),
    rtPlan(10, 1000, false),
    rtGaze(10, 1000.001, false),
  ];
  if (loopAnswer) {
    rows.push({ kind: 'lab/tool_result', tool_id: 'jev_execute', call_id: 'k1', t: 10.1, t_wall: 1000.1,
      result: { execute: { accepted: true, motion: RT, plan: { kind: 'rt', behaviour: 'strike', loop: true, duration_s: null } } } });
  }
  const phases = [0.2, 0.45, 0.7, 0.95, 0.15, 0.4, 0.65, 0.9, 0.12, 0.38];
  phases.forEach((ph, i) => {
    const t = 10.2 + 0.2 * i;
    const tw = 1000.2 + 0.2 * i;
    rows.push(rtPlan(t, tw, true, 0.01 * (i + 1)), rtGaze(t, tw + 0.0005, true), rtReedit(t, tw + 0.001, ph));
  });
  for (const r of rows) reduce(s, r);
  return [s, rows];
}

test('the real-time lane: re-plans at 5 Hz keep the hands\' plan, make no line or step each, and a wrap makes the run a loop', () => {
  const [s, rows] = rtRun(false);
  const run = s.engine.run;
  assert.equal(run.motion, RT);
  assert.equal(run.channel, 'hand', 'the gaze track\'s plan does not take the run over');
  assert.equal(s.jev.plan.channel, 'hand');
  assert.equal(s.jev.plan.t_wall, rows.filter((r) => r.trace_kind === 'plan' && r.channel === 'hand').pop().t_wall);
  assert.ok(s.feed.some((l) => l.text === 'aims keep_up beside its hand track'));
  assert.ok(!s.feed.some((l) => /re-edits|re-edit of/.test(l.text)), 'no line per re-aim');
  assert.deepEqual(s.jev.steps.map((x) => x.kind), ['command', 'decision', 'plan'], 'no step per re-aim');
  assert.equal(s.jev.reedits, 0);
  assert.deepEqual(run.reedit_marks, []);
  assert.equal(run.loop, true, 'the phase fell from 0.95 to 0.15: the run loops');
  assert.equal(run.phase, 0.38);
  tick(s, { t: 14, t_wall: 1004 });
  assert.equal(run.phase, 0.38, 'nothing extrapolates a real-time phase');
  // the time bar: the run's first plan and its decision get ticks, the re-plans none
  const ticks = rows.map(rowActor).filter(Boolean);
  assert.deepEqual(ticks, ['llm', 'jev', 'jev', 'jev']);
  // an older recording's follows (no `rt`) keep their lines, steps and marks
  const old = runningReach();
  reduce(old, trace('reedit', { t: 12, t_wall: 1002, motion: 'reach_side_left', installed: true, phase: 0.3, entry_s: 0.3,
    object_moved_m: 0.04 }));
  assert.equal(old.jev.reedits, 1);
  assert.equal(old.engine.run.reedit_marks.length, 1);
});

test('the real-time lane: a loop from the execute\'s answer, its key moments on the feed and the run line, a run without a duration', () => {
  const [s] = rtRun(true);
  const run = s.engine.run;
  assert.equal(run.loop, true);
  for (let n = 1; n <= 3; n++) {
    reduce(s, trace('rt', { t: 12 + n, t_wall: 1002 + n, event: 'strike', n, arm: n === 2 ? 'left' : 'right', motion: RT, v_in_mps: 2.1,
      v_out_mps: 1.4, timing_error_s: 0.01 }));
  }
  assert.equal(s.feed[s.feed.length - 1].text, 'keep_up: strike #3 (right)');
  assert.equal(s.feed[s.feed.length - 1].who, 'engine');
  assert.equal(rtCountText(run), 'strikes 3');
  reduce(s, trace('rt', { t: 16, t_wall: 1006 }));                        // nothing but the kind
  assert.equal(s.feed[s.feed.length - 1].text, 'keep_up: moment #1');
  reduce(s, trace('rt', { t: 17, t_wall: 1007, event: 'catch', motion: RT }));
  assert.equal(s.feed[s.feed.length - 1].text, 'keep_up: catch #1');
  assert.equal(rtCountText(run), 'strikes 3 · moment 1 · catches 1', 'an unknown moment: its name and count as they are');
  assert.equal(engineStatus(s), 'Running keep_up');
  reduce(s, trace('run_end', { t: 43, t_wall: 1033, channel: 'rt', motion: RT, outcome: 'success', reason: null, t_start: 10,
    duration_s: 33, phase: 0.5, tracks: ['gaze', 'hands'] }));
  assert.equal(run.channel, 'hand');
  assert.equal(engineStatus(s), 'keep_up succeeded in 33.0 s');
  assert.equal(rtCountText(run), 'strikes 3 · moment 1 · catches 1', 'the count stays on the run line after the run');
  // a moment with no run on the page and no motion is still a line
  const bare = initialState();
  reduce(bare, trace('rt', { t: 1, t_wall: 1, event: 'toss' }));
  assert.equal(bare.feed[bare.feed.length - 1].text, 'toss');
  // a looping plan without a duration: the bar stands at the reported phase, never NaN, never past its end
  const nod = initialState();
  reduce(nod, rtPlan(10, 1000, false, 0, { duration_s: null, loop: true }));
  tick(nod, { t: 30, t_wall: 1020 });
  assert.equal(nod.engine.run.phase, 0);
  reduce(nod, rtReedit(30.1, 1020.1, 0.97));
  reduce(nod, rtReedit(30.3, 1020.3, 1.4));
  assert.equal(nod.engine.run.phase, 1);
  reduce(nod, rtReedit(30.5, 1020.5, 0.03));
  tick(nod, { t: 31, t_wall: 1021 });
  assert.equal(nod.engine.run.phase, 0.03);
  assert.ok(Number.isFinite(nod.engine.run.phase));
});

/** C-2 seed 9002, 243.9 .. 263.2 s: the tilt starts on a wrong route (both hands: the right hand's curves under `second`),
 * the ball is blocked at B2 and the run pauses with its advice, the LLM answers with a jev_modify (a new route, a quicker
 * pace from its insight) and the run resumes (the arrays cut to their ends). */
const C2_MODIFY = [
  {"t_wall": 1794626797.551, "t": 244.44, "kind": "reasoning/tool_status", "call_id": "4f68ee", "tool_id": "jev_execute", "state": "starting", "arguments": {"motion": {"anchor": "tilt_tray_both", "allowed": []}, "insight": "Gentle tilts; let the ball settle in each cell before the next.", "bindings": {"hands": "obj:maze", "ball": "obj:ball", "path": "A1 B1 B2 A2 A3 A4 A5"}}},
  {"t_wall": 1794626797.576, "t": 244.46, "kind": "research/jev_trace", "trace_kind": "decision", "context": "execute", "motion": "tilt_tray_both", "arm": "both", "object_ref": "obj:maze", "insight": "Gentle tilts; let the ball settle in each cell before the next.", "decider": "rules", "rt": true, "decision": {"values": {"tilt": "gentle", "pace": "normal", "settle": "each_cell"}, "tilt": "gentle", "pace": "normal", "settle": "each_cell", "dimensions": ["tilt", "pace", "settle"], "confidence": {"tilt": 1.0, "pace": 1.0, "settle": 1.0}, "min_confidence": 1.0, "reason": "rules: the first value of each dimension; the insight: 'gentle' -> tilt gentle, 'each cell' -> settle each_cell", "decider": "rules"}},
  {"t_wall": 1794626797.577, "t": 244.46, "kind": "research/jev_trace", "trace_kind": "plan", "channel": "hand", "motion": "tilt_tray_both", "arm": "both", "object_ref": "obj:maze", "entry_s": 0.0, "grasp_s": 1.0, "duration_s": 4.0, "D": 0.0, "goal": [0.2884, 0.1685, 0.7445], "reedit": false, "rt": true, "loop": false, "track": "hands", "ghost": [[0.2884, 0.1685, 0.7445], [0.318, 0.1749, 0.839]], "edited": [[0.2884, 0.1685, 0.7445], [0.2884, 0.1685, 0.7445]], "path": [], "points": [[0.2884, 0.1685, 0.7445], [0.318, 0.1749, 0.779]], "roles": ["start", "approach"], "second": {"arm": "right", "goal": [0.2777, -0.1874, 0.7454], "ghost": [[0.2777, -0.1874, 0.7454], [0.3221, -0.1811, 0.839]], "edited": [[0.2777, -0.1874, 0.7454], [0.2777, -0.1874, 0.7454]], "path": [], "points": [[0.2777, -0.1874, 0.7454], [0.3221, -0.1811, 0.779]], "roles": ["start", "approach"]}},
  {"t_wall": 1794626797.59, "t": 244.48, "kind": "lab/tool_result", "call_id": "4f68ee", "tool_id": "jev_execute", "result": {"success": true, "reason": "ok", "accepted": true, "motion": "tilt_tray_both", "execute": {"accepted": true, "motion": "tilt_tray_both", "joined": false, "rt": {"tracks": ["hands"], "channels": ["left_hand", "right_hand"]}}}},
  {"t_wall": 1794626799.859, "t": 246.76, "kind": "research/jev_trace", "trace_kind": "rt", "event": "grasp", "motion": "tilt_tray_both", "track": "hands", "n": 1, "arm": "both"},
  {"t_wall": 1794626801.856, "t": 248.76, "kind": "research/jev_trace", "trace_kind": "rt", "event": "lift", "motion": "tilt_tray_both", "track": "hands", "n": 1, "arm": "both"},
  {"t_wall": 1794626803.579, "t": 250.48, "kind": "research/jev_trace", "trace_kind": "rt", "event": "cell", "motion": "tilt_tray_both", "track": "hands", "n": 1, "arm": "both", "cell": "B1", "prev": "A1", "next_cell": "B1"},
  {"t_wall": 1794626804.657, "t": 251.56, "kind": "research/jev_trace", "trace_kind": "rt", "event": "cell", "motion": "tilt_tray_both", "track": "hands", "n": 2, "arm": "both", "cell": "B2", "prev": "B1", "next_cell": "B2"},
  {"t_wall": 1794626808.577, "t": 255.48, "kind": "research/jev_event", "event": "scene_changed", "object": "obj:ball", "displacement_m": 0.0, "change": "blocked", "paused": true, "motion": "tilt_tray_both", "diagnostics": {"motion": "tilt_tray_both", "ball_cell": "B2", "next_cell": "A2", "why": "the ball made no progress from B2 toward A2 for 3 s (a wall may stand between them): the board is held level. Resume with jev_modify(bindings={\"path\": \"<the cells from B2 to the goal>\"})", "advice": "The ball rests in cell B2 and cannot go on to A2, the cell the route asks next (a wall may stand between them); the board is held level. Read the maze again and give a new route from B2, cell by neighbouring cell: jev_modify(bindings={\"path\": \"B2 ...\"}); or jev_stop."}},
  {"t_wall": 1794626808.577, "t": 255.48, "kind": "research/jev_trace", "trace_kind": "watch", "motion": "tilt_tray_both", "entry": {"t": 255.48, "phase": 0.75, "p": 0.0, "intervene": true, "why": "the ball made no progress from B2 toward A2 for 3 s (a wall may stand between them): the board is held level. Resume with jev_modify(bindings={\"path\": \"<the cells from B2 to the goal>\"})", "rt": true, "change": "blocked"}},
  {"t_wall": 1794626808.578, "t": 255.48, "kind": "research/jev_trace", "trace_kind": "rt", "event": "blocked", "motion": "tilt_tray_both", "track": "hands", "n": 1, "arm": "both", "next_cell": "A2", "ball_cell": "B2"},
  {"t_wall": 1794626809.125, "t": 256.02, "kind": "lab/tool_result", "call_id": "c19f42", "tool_id": "jev_wait_turn", "result": {"success": true, "reason": "event", "turn": 1, "events": [{"event": "scene_changed", "change": "blocked", "paused": true, "motion": "tilt_tray_both"}], "advice": ["The ball rests in cell B2 and cannot go on to A2, the cell the route asks next (a wall may stand between them); the board is held level. Read the maze again and give a new route from B2, cell by neighbouring cell: jev_modify(bindings={\"path\": \"B2 ...\"}); or jev_stop."], "waited_s": 10.454}},
  {"t_wall": 1794626816.088, "t": 262.98, "kind": "reasoning/tool_status", "call_id": "71778e", "tool_id": "jev_modify", "state": "starting", "arguments": {"motion": null, "insight": "Quicker pace, firmer tilts; time is short.", "bindings": {"path": "B2 C2 C3 C4 D4 D5 C5 B5 A5"}}},
  {"t_wall": 1794626816.09, "t": 262.98, "kind": "research/jev_trace", "trace_kind": "decision", "context": "modify", "motion": "tilt_tray_both", "arm": "both", "object_ref": "obj:maze", "insight": "Quicker pace, firmer tilts; time is short.", "decider": "rules", "rt": true, "decision": {"values": {"tilt": "normal", "pace": "fast", "settle": "flow"}, "tilt": "normal", "pace": "fast", "settle": "flow", "dimensions": ["tilt", "pace", "settle"], "confidence": {"tilt": 1.0, "pace": 1.0, "settle": 1.0}, "min_confidence": 1.0, "reason": "rules: the first value of each dimension; the insight: 'quick' -> pace fast", "decider": "rules"}},
  {"t_wall": 1794626816.09, "t": 262.98, "kind": "research/jev_trace", "trace_kind": "resume", "motion": "tilt_tray_both", "why": "resumed by jev_modify", "paused_s": 7.5, "phase": 0.75, "rt": true, "by": "modify", "binding": "obj:ball", "change": "blocked"},
  {"t_wall": 1794626816.098, "t": 263.0, "kind": "lab/tool_result", "call_id": "71778e", "tool_id": "jev_modify", "result": {"success": true, "reason": "ok", "modify": {"motion": "tilt_tray_both", "bindings": {"hands": "obj:maze", "ball": "obj:ball", "path": "B2 C2 C3 C4 D4 D5 C5 B5 A5"}}}},
  {"t_wall": 1794626816.737, "t": 263.64, "kind": "research/jev_trace", "trace_kind": "rt", "event": "cell", "motion": "tilt_tray_both", "track": "hands", "n": 3, "arm": "both", "cell": "C2", "prev": "B2", "next_cell": "C2"},
];

// ---- the re-recorded group-C bundles (the lead's second polish pass, 2026-11-13) ----------------------------------------------
test('C-2 rows: the blocked pause says what happened, the jev_modify is its steps, and the blocks come back', () => {
  const s = initialState();
  const steps = [];
  const upTo = (pred) => {
    while (C2_MODIFY.length > upTo.i) {
      const r = C2_MODIFY[upTo.i++];
      const before = s.step_seq;
      reduce(s, r);
      for (const x of s.jev.steps) if (x.id > before) steps.push(x.text);
      if (pred(r)) return r;
    }
    throw new Error('the row never came');
  };
  upTo.i = 0;
  upTo((r) => r.trace_kind === 'plan');
  const run = s.engine.run;
  assert.equal(run.arm, 'both');
  assert.equal(s.jev.plan.second.arm, 'right', 'the plan carries the right hand\'s curves');
  upTo((r) => r.event === 'scene_changed');
  assert.equal(engineStatus(s), 'Paused: blocked · the LLM decides');
  assert.equal(run.pause.text, 'The ball rests in cell B2 and cannot go on to A2, the cell the route asks next (a wall may stand '
    + 'between them); the board is held level.', 'the advice\'s first sentence, not "obj:ball moved 0.0 cm"');
  assert.match(run.pause.full, /Read the maze again/);
  assert.match(s.feed[s.feed.length - 1].text, /^paused · blocked — The ball rests in cell B2/);
  upTo((r) => r.trace_kind === 'rt' && r.event === 'blocked');
  assert.equal(rtCountText(run), 'cells 2 · blocked');
  upTo((r) => r.tool_id === 'jev_wait_turn');
  upTo((r) => r.tool_id === 'jev_modify' && r.state === 'starting');
  assert.equal(steps[steps.length - 1], 'LLM changed the route → B2 … A5 (9)');
  assert.equal(s.llm.choice.bindings.path, 'B2 C2 C3 C4 D4 D5 C5 B5 A5', 'the LLM block shows the modify\'s bindings');
  assert.equal(s.llm.choice.insight, 'Quicker pace, firmer tilts; time is short.');
  assert.equal(s.llm.choice.modified, true);
  upTo((r) => r.trace_kind === 'decision' && r.context === 'modify');
  assert.equal(steps[steps.length - 1], 'LLM changed the decision · tilt gentle → normal · pace normal → fast · settle each cell → flow');
  assert.equal(s.jev.decision.decision.pace, 'fast', 'the card takes the changed decision');
  upTo((r) => r.trace_kind === 'resume');
  assert.equal(engineStatus(s), 'Running tilt_tray_both');
  assert.equal(rtCountText(run), 'cells 2', 'blocked ends with the resume');
  assert.equal(s.feed[s.feed.length - 1].text, 'resumes tilt_tray_both (after the LLM\'s modify)');
  upTo((r) => r.tool_id === 'jev_modify' && r.result);
  assert.equal(s.jev.busy, null, 'JEV watches the run again');
  upTo((r) => r.trace_kind === 'rt' && r.cell === 'C2');
  assert.equal(rtCountText(run), 'cells 3');
  // a blocked that comes again stands again, and the next cell ends it as well
  reduce(s, { ...C2_MODIFY.find((r) => r.event === 'blocked'), t_wall: 1794626820, n: 2 });
  assert.equal(rtCountText(run), 'cells 3 · blocked 2');
  reduce(s, { ...C2_MODIFY[C2_MODIFY.length - 1], t_wall: 1794626821, n: 4, cell: 'C3' });
  assert.equal(rtCountText(run), 'cells 4');
});

/** C-4 seed 9001, the end: the twelfth stroke, the second progress turn, the verdict, and what came after it as the runner
 * stopped the server (the shutdown rows of C-5 seed 9001 put after them). */
const C4_END = [
  trace('rt', { t_wall: 1794626509.358, t: 70.78, event: 'stroke', motion: 'paddle_forehand_right', track: 'hands', n: 12, arm: 'right',
    ball: 'obj:ball_1', end: 'done', launched: true }),
  { t_wall: 1794626491.006, t: 52.43, kind: 'reasoning/tool_status', call_id: '79a42d', tool_id: 'jev_wait_turn', state: 'starting',
    arguments: { max_s: 30.0 } },
  { t_wall: 1794626509.836, t: 71.26, kind: 'task/status', status: 'running', predicates: { goal_0: true, hold: false },
    hud_line: 'waiting (goal_0) | returned 10/10', t_elapsed: 70.26, message: '', episode: 1 },
  { t_wall: 1794626510.08, t: 71.5, kind: 'lab/tool_result', call_id: '79a42d', tool_id: 'jev_wait_turn', arguments: { max_s: 30.0 },
    result: { success: true, reason: 'progress', turn: 2, events: [], advice: [], waited_s: 19.063, motion: 'paddle_forehand_right' } },
  { t_wall: 1794626510.836, t: 72.26, kind: 'task/status', status: 'success', predicates: { goal_0: true, hold: true },
    hud_line: 'TASK: SUCCESS', t_elapsed: 71.26, message: 'all predicates hold', episode: 1 },
  { t_wall: 1794626510.8363, t: 72.26, kind: 'task/episode_end', episode: 1, seed: 9001, task: 'papers', status: 'success',
    message: 'all predicates hold', hud_line: 'TASK: SUCCESS', t_elapsed: 71.26, predicates: { goal_0: true, hold: true } },
  trace('watch', { t_wall: 1794626511.392, t: 72.8, motion: 'paddle_forehand_right', entry: { t: 72.8, phase: 0.0, p: 0.0,
    intervene: false, rt: true, stands: true, step_ms: 2.44,
    why: 'real-time lane: 12 balls, 12 strokes, 12 contacts, 4 cut, 0 skipped; lead 112 ms, restitution 0.87 (ready)' } }),
  { t_wall: 1794626511.577, t: 73.0, kind: 'scene/component', component: 'launcher', trace_kind: 'ball_launcher', event: 'returned',
    ball: 'ball_2', n: 13 },
  { t_wall: 1794626512.461, t: null, kind: 'player/tool_result', id: 'toolu_x', tool: 'jev_wait_turn', is_error: true,
    text: 'MCP server "sprout-sim-lab" connection closed before the tool call was answered.' },
  { t_wall: 1794626512.977, t: 73.69, kind: 'reasoning/tool_status', call_id: '5902f9', tool_id: 'jev_wait_turn', state: 'canceled',
    arguments: { max_s: 30.0 }, error_message: 'stopped: server shutting down' },
  { t_wall: 1794626512.985, t: 73.7, kind: 'lab/tool_result', call_id: '5902f9', tool_id: 'jev_wait_turn', arguments: { max_s: 30.0 },
    result: { success: false, reason: 'cancelled', turn: null, events: null, advice: null, waited_s: null,
      message: 'stopped: server shutting down' } },
];

test('C-4 rows: a progress turn is a quiet line, and a run still going at the verdict ends with the episode', () => {
  const s = initialState();
  reduce(s, { ...rtPlan(30, 1794626468, false), motion: 'paddle_forehand_right', arm: 'right', loop: true, track: 'hands' });
  for (const r of C4_END.slice(0, 4)) reduce(s, r);
  assert.equal(s.llm.phase, 'reading', 'the LLM reads a progress report, it is not asked to decide');
  assert.equal(s.feed[s.feed.length - 1].text, 'progress report · strokes 1');
  assert.equal(s.feed[s.feed.length - 1].tone, null);
  assert.equal(engineStatus(s), 'Running paddle_forehand_right');
  const n = s.feed.length;
  for (const r of C4_END.slice(4)) reduce(s, r);
  const run = s.engine.run;
  assert.equal(engineStatus(s), 'Ended with the episode · success');
  assert.equal(engineTag(s), 'ended');
  assert.equal(rtCountText(run), 'strokes 1', 'its counts stay');
  assert.equal(s.memory.active, null);
  assert.deepEqual(s.feed.slice(n).map((l) => l.text), ['success · TASK: SUCCESS', 'episode end · success — all predicates hold'],
    'nothing of the shutdown in the feed');
  // the replay's time bar has no tick after the verdict either
  const pl = createPlayer({ meta: {}, rows: C4_END, frames: null });
  const end = pl.rows.findIndex((r) => r.kind === 'task/episode_end');
  const tEnd = 1794626510.8363 - pl.t0;
  assert.ok(pl.ticks.every((k) => k.t <= tEnd + 1e-6), JSON.stringify(pl.ticks));
  assert.ok(end > 0);
  // a new episode opens the pipeline again
  reduce(s, { kind: 'task/episode_start', t_wall: 1794626600, t: 1, episode: 2, task: 'papers' });
  reduce(s, C4_END[0]);
  assert.ok(s.feed[s.feed.length - 1].text.startsWith('paddle_forehand_right: stroke #12'));
});

/** C-3 seed 9002, 38.8 .. 42.3 s: the gaze track goes first, the two-handed bump joins it (the engine's run keeps the gaze
 * track's id in its watch reports). */
const C3_JOIN = [
  { t_wall: 1000.0, t: 39.27, kind: 'reasoning/tool_status', call_id: 'g1', tool_id: 'jev_execute', state: 'starting',
    arguments: { motion: { anchor: 'gaze_track' }, bindings: { gaze: 'obj:balloon' } } },
  trace('decision', { t_wall: 1000.01, t: 39.28, context: 'execute', motion: 'gaze_track', arm: null, object_ref: 'obj:balloon', rt: true,
    decision: { values: {}, dimensions: [], confidence: {}, min_confidence: 1.0, reason: 'rules: the first value of each dimension' } }),
  trace('plan', { t_wall: 1000.02, t: 39.28, channel: 'gaze', motion: 'gaze_track', duration_s: 0.0, reedit: false, rt: true, loop: true,
    track: 'gaze' }),
  trace('watch', { t_wall: 1000.03, t: 39.28, motion: 'gaze_track', entry: { t: 39.28, phase: 0.0, p: 0.0, intervene: false,
    why: 'real-time lane: 1 track', rt: true, stands: true, step_ms: 0.0 } }),
  { t_wall: 1000.04, t: 39.29, kind: 'lab/tool_result', call_id: 'g1', tool_id: 'jev_execute', result: { success: true, accepted: true,
    motion: 'gaze_track', execute: { accepted: true, motion: 'gaze_track', joined: false, rt: { tracks: ['gaze'], channels: ['gaze'] } },
    status: { motion: 'gaze_track', running: true } } },
  { t_wall: 1001.1, t: 40.38, kind: 'reasoning/tool_status', call_id: 'b1', tool_id: 'jev_execute', state: 'starting',
    arguments: { motion: { anchor: 'bump_up_both' }, bindings: { hands: 'obj:balloon' },
      insight: 'Raise both hands under the hanging balloon to let it go, then send it gently straight up each time it comes down.' } },
  trace('decision', { t_wall: 1001.11, t: 40.4, context: 'execute', motion: 'bump_up_both', arm: 'left', object_ref: 'obj:balloon', rt: true,
    decision: { values: { height: 'mid', power: 'normal', spread: 'narrow', aim: 'straight' }, height: 'mid', power: 'normal',
      spread: 'narrow', aim: 'straight', dimensions: ['height', 'power', 'spread', 'aim'], min_confidence: 1.0 } }),
  { t_wall: 1001.12, t: 40.4, kind: 'lab/tool_result', call_id: 'b1', tool_id: 'jev_execute', result: { success: true, accepted: true,
    motion: 'bump_up_both', execute: { accepted: true, motion: 'bump_up_both', joined: true,
      rt: { tracks: ['gaze', 'hands'], channels: ['gaze', 'left_hand', 'right_hand'] } }, status: { motion: 'gaze_track', running: true } } },
  { ...rtPlan(40.48, 1001.2, false), motion: 'bump_up_both', arm: 'left', object_ref: 'obj:balloon', duration_s: 0.65, loop: true,
    track: 'hands' },
  trace('rt', { t_wall: 1001.9, t: 42.18, event: 'bump', motion: 'bump_up_both', track: 'hands', n: 1, arm: 'both' }),
  trace('watch', { t_wall: 1002.0, t: 42.28, motion: 'gaze_track', entry: { t: 42.28, phase: 0.0, p: 0.0, intervene: false, rt: true,
    stands: true, why: 'real-time lane: 1 bumps, 1 hits (1 with both hands), 0 abandoned, launch 0.79 of the push, lead 0.186 s' } }),
];

test('C-3 rows: hands that join a gaze track that went first name the run; the gaze stays bound beside them', () => {
  const s = initialState();
  for (const r of C3_JOIN) reduce(s, r);
  const run = s.engine.run;
  assert.equal(run.motion, 'bump_up_both');
  assert.equal(run.channel, 'hand');
  assert.deepEqual(run.joined, ['gaze']);
  assert.equal(run.joined_bind, 'gaze → obj:balloon');
  assert.deepEqual([s.memory.active, ...s.memory.also], ['bump_up_both', 'gaze_track']);
  assert.equal(s.jev.decision.motion, 'bump_up_both');
  assert.equal(rtCountText(run), 'bumps 1', 'a moment of the hands counts on the run they joined');
  assert.equal(watchLine(s).text, '1 bumps, 1 hits (1 with both hands), 0 abandoned, launch 0.79 of the push, lead 0.186 s',
    'the gaze track\'s reports are the run\'s');
  assert.equal(engineStatus(s), 'Running bump_up_both');
});

test('the balloon\'s events are feed lines; a duration goal reads in seconds', () => {
  const s = initialState();
  reduce(s, { kind: 'scene', scene: { name: 'papers/c3_balloon_keepup', task: { name: 'papers', goals: [
    { key: 'goal_0', kind: 'component', component: 'balloon_judge', at_least: 60, status_key: 'aloft_s' }] } } });
  assert.deepEqual(pillsOf(s), ['#aloft 0.0/60 s', 'hold']);
  reduce(s, status(45, { goal_0: false, hold: false }, 'waiting | aloft_s 5.01/60'));
  assert.deepEqual(pillsOf(s), ['#aloft 5.0/60 s', 'hold']);
  assert.equal(taskPills(s.episode)[0].width, 'aloft 60.0/60 s'.length);
  for (const [r, text] of [
    [comp('balloon', 'balloon_judge', 'release', { hand: 'left', pad_z: 0.8055 }), 'the balloon is let go (a left hand under it)'],
    [comp('balloon', 'balloon_judge', 'hit', { n: 2, arm: 'right', apex: 1.48 }), 'balloon hit #2 (right hand)'],
    [comp('balloon', 'balloon_judge', 'grounded', { where: 'floor' }), 'the balloon came down on the floor'],
  ]) {
    reduce(s, r);
    assert.equal(s.feed[s.feed.length - 1].text, text);
  }
});

// the plan overlay at 5 Hz (three.js from web/node_modules; skipped without it)
let PlanOverlay = null;
let PlanOverlays = null;
let secondPlan = null;
let SwingOverlay = null;
let THREE = null;
try {
  THREE = await import('three');
  ({ PlanOverlay, PlanOverlays, secondPlan, SwingOverlay } = await import('../src/viewport/overlays.js'));
} catch (e) {
  skip('the plan overlay at 5 Hz', `three.js is not installed here (${e.message})`);
}
if (PlanOverlay) {
  test('the plan overlay at 5 Hz: one glide at a time from the curve as drawn, the tube always shown, no trace left behind', () => {
    const ov = new PlanOverlay(new THREE.Scene(), { theme: 'dark' });
    const first = { ...planRow(10, 1000, false), motion: 'reach_side_right' };
    const shifted = (k, extra = {}) => ({ ...first, ...extra, reedit: true, t_wall: 1000 + 0.2 * k,
      edited: first.edited.map(([x, y, z]) => [x + 0.005 * k, y, z]) });
    ov.setPlan(first, 0);
    assert.equal(ov._anim.hold, 500, 'a new motion holds on its ghost first');
    assert.equal(ov.tube.visible, false);
    ov.setPlan(shifted(1), 200);                  // a re-edit inside the hold: the edit at once, not a hold again
    assert.equal(ov._anim, null);
    assert.equal(ov.tube.visible, true);
    for (let k = 2; k <= 16; k++) {
      const now = 200 * k;
      ov.setPlan(shifted(k), now);
      assert.equal(ov._anim.hold, 0, `re-edit ${k} glides`);
      assert.equal(ov._anim.morphMs, 180);
      assert.equal(ov.tube.visible, true);
      assert.equal(ov.trace.visible, false, 'no trace piles up');
      ov.update(now + 90);
      const mid = ov._shown[ov._shown.length - 1].x;
      assert.ok(mid > first.edited[31][0] + 0.005 * (k - 1) - 1e-9 && mid < first.edited[31][0] + 0.005 * k + 1e-9, 'half way');
      ov.update(now + 190);
      assert.equal(ov._anim, null, 'settled before the next re-edit');
      assert.ok(Math.abs(ov._shown[31].x - (first.edited[31][0] + 0.005 * k)) < 1e-6);
    }
    // a re-edit two seconds later keeps the full choreography: the hold, then the morph, the previous edit as a trace
    ov.setPlan(shifted(30), 5400);
    assert.equal(ov._anim.hold, 500);
    assert.equal(ov.trace.visible, true);
    // the real-time lane's re-plans glide whatever their pace
    ov.update(7000);
    ov.update(9000);
    ov.setPlan(shifted(40, { rt: true }), 20000);
    assert.equal(ov._anim.hold, 0);
    ov.dispose();
  });

  test('C-6\'s arc: a dotted line through the predicted period, a ring at the meeting; gone for null', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scores', 'c6_h4_s23_medium.json'), 'utf8'));
    const plan = fx.rows.find((r) => r.trace_kind === 'plan' && r.channel === 'hand' && r.meeting);
    const ov = new SwingOverlay(new THREE.Scene());
    assert.equal(ov.set({ path: plan.predicted_path, meeting: plan.meeting.p_contact }), true);
    assert.equal(ov.arc.visible, true);
    assert.equal(ov.arc.material.isLineDashedMaterial, true, 'dotted');
    assert.ok(ov.arc.geometry.getAttribute('lineDistance'), 'its dashes are laid along it');
    assert.ok(ov.arc.geometry.getAttribute('position').count > plan.predicted_path.length, 'smoothed through the samples');
    assert.equal(ov.meet.visible, true);
    assert.deepEqual(ov.meet.position.toArray().map((v) => +v.toFixed(4)), plan.meeting.p_contact);
    assert.equal(ov.set({ path: plan.predicted_path, meeting: plan.meeting.p_contact }), false, 'the same arc: nothing to redraw');
    ov.set({ path: plan.predicted_path, meeting: null });
    assert.equal(ov.meet.visible, false);
    assert.equal(ov.arc.visible, true);
    assert.equal(ov.set(null), true);
    assert.equal(ov.arc.visible, false);
    ov.dispose();
  });

  test('both arms: a plan with `second` draws the right hand\'s curves beside the left\'s, each with its marker', () => {
    const plan = C2_MODIFY.find((r) => r.trace_kind === 'plan');
    const sec = secondPlan(plan);
    assert.equal(sec.arm, 'right');
    assert.equal(sec.motion, 'tilt_tray_both');
    assert.deepEqual(sec.goal, plan.second.goal);
    assert.equal(sec.second, null);
    assert.equal(secondPlan({ ...plan, second: undefined }), null);
    const ov = new PlanOverlays(new THREE.Scene(), { theme: 'dark' });
    assert.equal(ov.setPlan(plan, 0), true);
    assert.equal(ov.first.plan.arm, 'both');
    assert.equal(ov.second.plan.arm, 'right');
    ov.update(5000);
    assert.equal(ov.first.tube.visible, true);
    assert.equal(ov.second.tube.visible, true);
    assert.ok(Math.abs(ov.second.goal.position.y - plan.second.goal[1]) < 1e-9, 'the second goal ring at the right hand\'s goal');
    ov.setProgress(0.5);
    assert.equal(ov.second.marker.visible, true);
    ov.setPlan({ ...plan, second: undefined, t_wall: plan.t_wall + 1 }, 6000);
    assert.equal(ov.second.plan, null, 'a plan without it clears the second arm');
    ov.floorZ = 0.01;
    assert.equal(ov.second.floorZ, 0.01);
    ov.dispose();
  });
}

// ---- the first real group-C bundles (the lead's polish pass, 2026-11-13): rows cut from web/episodes/group_c ------------------
/** C-1 seed 9001, 28.4 .. 31.3 s: the left snatch starts (an RT watch report before its plan), arms, a gaze track joins it
 * under its own jev_execute, the target is lost and the lane says so (the arrays of the plan cut short). */
const C1_JOIN = [
  { t_wall: 1794622508.436, t: 28.94, kind: 'reasoning/tool_status', call_id: '6c23', tool_id: 'jev_execute', state: 'starting',
    arguments: { motion: { anchor: 'snatch_side_left', allowed: ['snatch_side_right'] }, bindings: { hands: 'obj:item_07' },
      insight: 'The green bottle rides the belt from right to left; take it from the side as it passes and lift it clear.' } },
  { t_wall: 1794622508.481, t: 28.94, kind: 'research/jev_trace', trace_kind: 'decision', context: 'execute', motion: 'snatch_side_left',
    arm: 'left', object_ref: 'obj:item_07', n_probed: 0, n_reachable: 0, decider: 'rules', change: null, rt: true,
    decision: { values: { pace: 'normal', close: 'near', pad: 'clip', side: 'early' }, pace: 'normal', close: 'near', pad: 'clip',
      side: 'early', dimensions: ['pace', 'close', 'pad', 'side'], confidence: { pace: 1.0, close: 1.0, pad: 1.0, side: 1.0 },
      min_confidence: 1.0, reason: 'rules: the first value of each dimension', decider: 'rules' } },
  { t_wall: 1794622508.484, t: 28.98, kind: 'research/jev_trace', trace_kind: 'watch', motion: 'snatch_side_left',
    entry: { t: 28.98, phase: 0.0, p: 0.0, intervene: false, rt: true, stands: true,
      why: 'real-time lane: track left: going to the ready point; attempts 0, captures 0, step 0.0 ms' } },
  { t_wall: 1794622508.499, t: 29.0, kind: 'lab/tool_result', call_id: '6c23', tool_id: 'jev_execute',
    result: { success: true, accepted: true, motion: 'snatch_side_left', execute: { accepted: true, motion: 'snatch_side_left',
      duration_s: 4.7, joined: false, rt: { tracks: ['hands'], channels: ['left_hand'] }, plan: {} },
    status: { motion: 'snatch_side_left', running: true, phase: 0.0 } } },
  { t_wall: 1794622508.754, t: 29.24, kind: 'research/jev_trace', trace_kind: 'plan', channel: 'hand', motion: 'snatch_side_left',
    arm: 'left', object_ref: 'obj:item_07', entry_s: 0.0, truncated_at_s: null, grasp_s: 1.0, duration_s: 4.7, D: 0.0,
    goal: [0.2996, 0.2102, 0.704], ghost: [[0.0175, 0.1754, 0.5033], [0.0321, 0.1711, 0.5105], [0.2996, 0.2102, 0.704]],
    edited: [[0.0175, 0.1754, 0.5033], [0.0321, 0.1711, 0.5105], [0.2996, 0.2102, 0.704]],
    path: [[0.0375, 0.1782, 0.5047], [0.0548, 0.1777, 0.5164]], points: [[0.0175, 0.1754, 0.5033], [0.0485, 0.1702, 0.5214]],
    roles: ['start', 'via'], reedit: false, rt: true, state: 'to_ready', loop: false, track: 'hands' },
  { t_wall: 1794622510.096, t: 30.6, kind: 'research/jev_trace', trace_kind: 'rt', event: 'armed', motion: 'snatch_side_left',
    track: 'hands', n: 0, arm: 'left', binding: 'obj:item_07', why: 'at the ready point, waiting for the target to come into view' },
  { t_wall: 1794622510.476, t: 30.98, kind: 'research/jev_trace', trace_kind: 'watch', motion: 'snatch_side_left',
    entry: { t: 30.98, phase: 0.5672, p: 0.0, intervene: false, rt: true, stands: true,
      why: 'real-time lane: track left: waiting at the ready point; attempts 0, captures 0, step 4.0 ms; armed: hands (waiting for the target)' } },
  { t_wall: 1794622510.739, t: 31.24, kind: 'reasoning/tool_status', call_id: 'f92b', tool_id: 'jev_execute', state: 'starting',
    arguments: { motion: { anchor: 'gaze_track' }, bindings: { gaze: 'obj:item_07' }, insight: null } },
  { t_wall: 1794622510.741, t: 31.24, kind: 'research/jev_trace', trace_kind: 'decision', context: 'execute', motion: 'gaze_track',
    arm: null, object_ref: 'obj:item_07', decider: 'rules', change: null, rt: true,
    decision: { values: {}, dimensions: [], confidence: {}, min_confidence: 1.0, reason: 'rules: the first value of each dimension' } },
  { t_wall: 1794622510.742, t: 31.24, kind: 'research/jev_trace', trace_kind: 'plan', channel: 'gaze', motion: 'gaze_track',
    points: [[0.5, -0.7], [0.5, -0.7]], duration_s: 0.0, reedit: false, rt: true, loop: true, track: 'gaze' },
  { t_wall: 1794622510.744, t: 31.24, kind: 'lab/tool_result', call_id: 'f92b', tool_id: 'jev_execute',
    result: { success: true, accepted: true, motion: 'gaze_track', execute: { accepted: true, motion: 'gaze_track', duration_s: null,
      joined: true, rt: { tracks: ['gaze', 'hands'], channels: ['left_hand', 'gaze'] }, plan: {} },
    status: { motion: 'snatch_side_left', running: true, phase: 0.5672 } } },
  { t_wall: 1794622510.778, t: 31.28, kind: 'research/jev_event', event: 'scene_changed', object: 'obj:item_07', displacement_m: 0.0,
    change: 'lost', paused: true, motion: 'snatch_side_left', diagnostics: { motion: 'snatch_side_left', binding: 'obj:item_07',
      unseen_s: 2.34, lost_s: 1.0 } },
  { t_wall: 1794622510.778, t: 31.28, kind: 'research/jev_trace', trace_kind: 'watch', motion: 'snatch_side_left',
    entry: { t: 31.28, phase: 0.5672, p: 0.0, intervene: true, rt: true, change: 'lost',
      why: 'the target has not been perceived for lost_s: the hands hold their ready pose until jev_modify (resume) or jev_stop' } },
];

test('C-1 rows: a gaze track that joined the hands\' run keeps the run and its plan; the RT watch is the watch line, no step', () => {
  const s = initialState();
  const steps = [];
  for (const r of C1_JOIN) {
    const before = s.step_seq;
    reduce(s, r);
    for (const x of s.jev.steps) if (x.id > before) steps.push(x);
  }
  const run = s.engine.run;
  assert.equal(run.motion, 'snatch_side_left');
  assert.equal(run.channel, 'hand');
  assert.deepEqual(run.joined, ['gaze'], 'the run line reads "hand + gaze"');
  assert.equal(s.jev.plan.motion, 'snatch_side_left', 'the overlays keep the hands\' plan the gaze command had cleared');
  assert.equal(s.jev.plan.channel, 'hand');
  assert.deepEqual(steps.map((x) => x.text), [
    'LLM chose snatch_side_left · with an insight', 'decided · conf 1.00', 'edited to the scene · D 0.00 · 4.7 s → handed to the engine',
    'LLM chose gaze_track', 'aimed gaze_track → joined snatch_side_left',
  ], 'no step for the lane\'s reports, the intervening one included, nor for the joined gaze\'s empty decision');
  assert.equal(s.jev.decision.motion, 'snatch_side_left', 'the card keeps the hands\' decision');
  assert.equal(run.joined_bind, 'gaze → obj:item_07');
  assert.deepEqual(s.memory.also, ['gaze_track'], 'the memory strip shows both motions running');
  const texts = s.feed.map((l) => l.text);
  assert.ok(texts.includes('decides snatch_side_left on obj:item_07: pace normal · close near · pad clip · side early (conf 1.00) · rules'));
  assert.ok(texts.includes('accepted gaze_track · joined snatch_side_left'));
  assert.ok(texts.includes('snatch_side_left: armed (left)'));
  assert.ok(texts.includes('scene changed · obj:item_07 out of sight · paused for a decision'));
  assert.ok(!texts.some((t) => /^watch \d/.test(t)), 'the lane\'s reports are no feed lines');
  assert.equal(engineStatus(s), 'Paused: object lost · the LLM decides');
  assert.equal(run.pause.text, 'obj:item_07 out of sight');
  const line = watchLine(s);
  assert.equal(line.text, 'the target has not been perceived for lost_s: the hands hold their ready pose until jev_modify (resume) or jev_stop');
  assert.equal(line.intervene, true);
  assert.deepEqual(run.watch_marks, [], 'the lane\'s reports put no marks on the phase bar');
  reduce(s, { ...C1_JOIN[6], t_wall: 1794622511.47, entry: { ...C1_JOIN[6].entry, t: 31.98 } });
  assert.equal(watchLine(s).text, 'track left: waiting at the ready point');
  assert.equal(rtCountText(run), 'armed', 'armed while nothing came after it');
});

/** An `rt` key moment as the lane writes it. */
const moment = (motion, event, n, extra = {}) => trace('rt', { t: 40 + n, t_wall: 1040 + n, event, motion, track: 'hands', n, ...extra });

test('the run line counts what a viewer follows: "launches 1 · captures 1 · lifted", "cells 12 · solved", "strokes 11"', () => {
  const rows = (motion, list) => {
    const s = initialState();
    reduce(s, { ...C1_JOIN[4], motion });
    for (const r of list) reduce(s, r);
    return s;
  };
  // C-1 seed 9001's second run: armed, then the launch, the hands closing, the capture, the lift
  const c1 = rows('snatch_side_right', [moment('snatch_side_right', 'armed', 0, { arm: 'right' }),
    moment('snatch_side_right', 'launch', 1, { arm: 'right', t_meet: 76.2419, window_s: 0.9 }),
    moment('snatch_side_right', 'close', 1, { arm: 'right', why: 'seen between the pads' }),
    moment('snatch_side_right', 'capture', 1, { arm: 'right', holding: true, load_n: -2.721 }),
    moment('snatch_side_right', 'lifted', 1, { arm: 'right', holding: true })]);
  assert.equal(rtCountText(c1.engine.run), 'launches 1 · captures 1 · lifted');
  assert.deepEqual(c1.feed.slice(-5).map((l) => l.text), ['snatch_side_right: armed (right)', 'snatch_side_right: launch #1 (right)',
    'snatch_side_right: close (right)', 'snatch_side_right: capture #1 (right)', 'snatch_side_right: lifted (right)']);
  // C-2: the board grasped and lifted, the ball through twelve cells, solved; a two-handed motion
  const cells = ['A2', 'B2', 'C2', 'D2', 'D3', 'D4', 'C4', 'B4', 'B5', 'C5', 'D5', 'E5'];
  const c2 = rows('tilt_tray_both', [moment('tilt_tray_both', 'grasp', 1, { arm: 'both' }), moment('tilt_tray_both', 'lift', 1, { arm: 'both' }),
    ...cells.map((c, i) => moment('tilt_tray_both', 'cell', i + 1, { arm: 'both', cell: c, prev: i ? cells[i - 1] : 'A1' })),
    moment('tilt_tray_both', 'solved', 1, { arm: 'both' })]);
  assert.equal(rtCountText(c2.engine.run), 'cells 12 · solved');
  assert.equal(c2.engine.run.arm, 'both');
  assert.ok(c2.feed.some((l) => l.text === 'tilt_tray_both: cell #3 C2 (both hands)'));
  // the steer's re-edits (change kinds approach, close, lift, level, tilt) make no step or line
  const steps = c2.jev.steps.length;
  reduce(c2, trace('reedit', { t: 60, t_wall: 1060, motion: 'tilt_tray_both', installed: true, phase: 0.7083, rt: true,
    change: { kind: 'tilt' }, n_edits: 3 }));
  assert.equal(c2.jev.steps.length, steps);
  assert.equal(c2.engine.run.phase, 0.7083);
  // C-4: strokes; a state that came twice, a moment the page does not know
  const c4 = rows('paddle_forehand_right', Array.from({ length: 11 }, (_, i) => moment('paddle_forehand_right', 'stroke', i + 1,
    { arm: 'right', ball: `obj:ball_${i}` })));
  assert.equal(rtCountText(c4.engine.run), 'strokes 11');
  reduce(c4, moment('paddle_forehand_right', 'blocked', 1));
  reduce(c4, moment('paddle_forehand_right', 'blocked', 2));
  reduce(c4, moment('paddle_forehand_right', 'bounce', 1));
  reduce(c4, moment('paddle_forehand_right', 'bounce', 2));
  assert.equal(rtCountText(c4.engine.run), 'strokes 11 · blocked 2 · bounce 2');
});

test('goal pills from the scene dict: "lifted", "placed", a component goal\'s counter by its key; without the field goal_<i>', () => {
  const withGoals = (goals) => {
    const s = initialState();
    reduce(s, { kind: 'scene', scene: { name: 'papers/x', task: { name: 'papers', goals } } });
    return s;
  };
  const c1 = withGoals([{ key: 'goal_0', kind: 'lift', object: 'item_07' }]);
  assert.deepEqual(pillsOf(c1), ['lifted', 'hold'], 'from the start, before any status row');
  assert.equal(taskPills(c1.episode)[0].title, 'goal_0 · lift item_07: does not hold');
  reduce(c1, status(78, { goal_0: true, hold: false }, 'waiting (goal_0)'));
  assert.deepEqual(pillsOf(c1), ['lifted+', 'hold']);
  const c4 = withGoals([{ key: 'goal_0', kind: 'component', component: 'launcher', at_least: 10, status_key: 'returned' }]);
  assert.deepEqual(pillsOf(c4), ['#returned 0/10', 'hold'], 'nothing counted yet');
  reduce(c4, status(52, { goal_0: false, hold: false }, 'waiting | returned 4/10'));
  assert.deepEqual(pillsOf(c4), ['#returned 4/10', 'hold']);
  const b3 = withGoals([{ key: 'goal_0', kind: 'place', object: 'block', region: 'plate_0' },
    { key: 'goal_1', kind: 'place', object: 'treasure', region: 'goal_0' }]);
  assert.deepEqual(pillsOf(b3), ['placed block', 'placed treasure', 'hold'], 'two goals that would read the same say what');
  const mixed = withGoals([{ key: 'goal_0', kind: 'lift', object: 'item_07' },
    { key: 'goal_1', kind: 'component', component: 'belt', at_least: 3, status_key: 'taken' },
    { key: 'goal_2', kind: 'robot_in_region', region: 'finish' }, { key: 'goal_3', kind: 'region_clear', region: 'goal_0' }]);
  reduce(mixed, status(5, { goal_0: false, goal_1: false, goal_2: true, goal_3: true, hold: false }, 'waiting (goal_2, goal_3) | taken 1/3'));
  assert.deepEqual(pillsOf(mixed), ['lifted', '#taken 1/3', 'in region+', 'clear+', 'hold'], 'the counter stands for its goal');
  // a bundle exported before the scene dict named the goals keeps the predicates' names
  const old = initialState();
  reduce(old, { kind: 'scene', scene: { name: 'papers/a11_teleport_grasp' } });
  reduce(old, status(142, { goal_0: true, hold: false }, 'waiting (goal_0)'));
  assert.deepEqual(pillsOf(old), ['goal_0+', 'hold']);
});

test('a real-time decision shows its own dimensions; a long text binding is shortened, its title keeps it whole', () => {
  const d = C1_JOIN[1].decision;
  assert.deepEqual(decisionFields(d).map((f) => `${f.label} ${f.value}`), ['pace normal', 'close near', 'pad clip', 'side early']);
  assert.deepEqual(decisionFields({ close: 'near', dimensions: ['close'] }), [], 'a change record without values: as before');
  const b = { hands: 'obj:maze', ball: 'obj:ball', path: 'A1 A2 B2 C2 D2 D3 D4 C4 B4 B5 C5 D5 E5' };
  assert.equal(bindingsText(b), 'hands → obj:maze · ball → obj:ball · path → A1 … E5 (13)');
  assert.equal(bindingsText(b, true), 'hands → obj:maze · ball → obj:ball · path → A1 A2 B2 C2 D2 D3 D4 C4 B4 B5 C5 D5 E5');
  assert.equal(bindingsText({ hands: 'obj:ball_*', tool: 'obj:paddle' }), 'hands → obj:ball_* · tool → obj:paddle');
  const s = initialState();
  reduce(s, comp('pan_toss', 'toss', 'toss', { n: 5, counted: false, kept: 8, of: 8, apex_min_m: 0.071, tosses: 4 }));
  assert.equal(s.feed[s.feed.length - 1].text, 'toss 5: 8 of 8 back in the pan · not counted (the lowest piece rose 7.1 cm)');
});

// the nine bundles of group C, when present: replayed as the page plays them, the lane's reports and re-edits make no step
const GROUP_C = path.join(HERE, '..', 'episodes', 'group_c');
// (the C-4 bundle of seed 9001 was exported again on 2026-11-13 23:57 from papers_c4_r3, a run with eleven strokes before
// the verdict; the expectation of twelve was the earlier run's)
const GROUP_C_RUNS = { c1_conveyor_pick_s9001_claude: ['launches 1 · captures 1 · lifted', ['lifted+', 'hold+']],
  c2_ball_maze_s9001_claude: ['cells 12 · solved', ['#solved 1/1+', 'hold+']],
  c4_paddle_return_s9001_claude: ['strokes 11', ['#returned 10/10+', 'hold+']],
  c2_ball_maze_s9002_claude: ['cells 10 · solved', ['#solved 1/1+', 'hold+']] };
for (const [id, [line, pills]] of Object.entries(GROUP_C_RUNS)) {
  const file = path.join(GROUP_C, id, 'episode.json');
  if (!fs.existsSync(file)) {
    skip(`group C ${id}`, 'its bundle is not here');
    continue;
  }
  test(`group C ${id}: the run line, the pills, no step for the lane's reports or re-edits`, () => {
    const b = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = initialState();
    reduce(s, { kind: 'scene', scene: b.scene });
    const shape = taskShape(b.rows);
    if (shape) reduce(s, shape);
    const kinds = [];
    for (const r of createPlayer({ meta: { t0_wall: b.t0_wall }, rows: b.rows, frames: null }).rows) {
      const before = s.step_seq;
      reduce(s, r);
      for (const x of s.jev.steps) if (x.id > before) kinds.push(x.kind);
    }
    assert.ok(!kinds.includes('reedit') && !kinds.includes('watch'), kinds.join(','));
    assert.equal(rtCountText(s.engine.run), line);
    assert.deepEqual(pillsOf(s), pills);
    if (b.scene.view) assert.ok(Number.isFinite(b.scene.view.az), 'the bundle carries its scene\'s default view');
  });
}

// ---- the scorecard (contract H4, 2026-11-15) ------------------------------------------------------------------------------
const SCORES = path.join(HERE, 'fixtures', 'scores');
const readScore = (name) => JSON.parse(fs.readFileSync(path.join(SCORES, name), 'utf8'));
const headOf = (card) => ({ sentence: card.task, protocol: card.protocol, pass_rule: card.pass_rule,
  primary: { key: card.primary.key, label: card.primary.label, of: card.primary.of, unit: card.primary.unit,
    better: card.primary.better } });

/** A state as a replay seeds it: the scene dict with the task's goals and the card's head, then the bundle's card. */
function scoredState(head, card = null, goals = []) {
  const s = initialState();
  reduce(s, { kind: 'scene', scene: { name: 'papers/x', task: { name: 'papers', goals, ...head } } });
  if (card) reduce(s, { kind: 'score', card });
  return s;
}
const passedGoal = (component) => [{ key: 'goal_0', kind: 'component', component, at_least: 1, status_key: 'passed' }];
const episodeEnd = (t, extra = {}) => ({ kind: 'task/episode_end', t, t_wall: 2000 + t, episode: 1, task: 'papers',
  status: 'success', message: 'all predicates hold', predicates: { goal_0: true, hold: true }, ...extra });

/** C-4's card in the shape scenes/ball_launcher.py keeps it: ten balls, every row with the running `value` and its `ok`. */
function launcherCard() {
  const went = [true, true, false, true, false, true, true, true, false, true];
  let v = 0;
  const trials = went.map((ok, i) => {
    if (ok) v += 1;
    return { n: i + 1, t: 10 + 4 * i, t_task: 9 + 4 * i, ball: `ball_${i}`, cross_y_m: i === 0 ? 0.2104 : -0.0812,
      touched: ok, miss_dist_m: ok ? 0.0 : 0.0512, returned: ok, land_along_m: ok ? 0.6231 : null,
      outcome: ok ? 'returned' : 'missed', reason: ok ? null : 'not_touched', value: v, ok };
  });
  return { task: 'Return the balls the ball machine lobs over the net.', protocol: '10 balls, one at a time.',
    primary: { key: 'returned', label: 'balls returned', value: 7, of: 10, unit: 'balls', better: 'higher' },
    pass_rule: 'at least 7 of the 10 balls returned', done: true, passed: true,
    metrics: { launched: 10, returned: 7, spread: 'L2', cross_y_min_m: -0.0812, miss_dist_median_m: null, t_done_s: 49.123,
      n_execute: 2, ended_by: 'success', board_tilt_max_deg: 3.4, ball_speed_max_mps: 0.2217, cells_entered_n: 12 },
    trials, component: 'launcher', success: true, reason: null, t_task_s: 52.1, final: true };
}

test('a count card: the chip counts the rows up to the playhead and nothing beyond, the verdict once the episode ended', () => {
  const card = launcherCard();
  const s = scoredState(headOf(card), card, passedGoal('launcher'));
  assert.deepEqual(pillsOf(s), ['hold'], 'the chip replaces the pill "passed 0/1"');
  const at = (t) => scoreView(s.episode, t);
  assert.equal(at(5).text, '0/10 balls', 'before the first row: 0 of the maximum');
  assert.equal(at(5).rows.length, 0);
  assert.equal(at(10).text, '1/10 balls', 'a row decided at the playhead counts');
  assert.equal(at(21.9).text, '2/10 balls');
  assert.equal(at(21.9).rows.length, 3, 'the miss at 18 s is there, the ball at 22 s is not');
  assert.ok(at(21.9).rows.every((r) => r.t <= 21.9));
  assert.equal(at(21.9).mark, null, 'no verdict while the episode runs');
  assert.equal(at(1000).text, '7/10 balls');
  assert.equal(at(1000).mark, null, 'past the last row but before the end: still no verdict');
  reduce(s, episodeEnd(60));
  const end = scoreView(s.episode, 59);
  assert.equal(end.text, '7/10 balls');
  assert.equal(end.mark, 'passed');
  assert.equal(end.rows.length, 10);
  assert.match(end.title, /at least 7 of the 10 balls returned/);
  const lines = trialLines(end.card, end.rows);
  assert.equal(lines.length, 10);
  assert.deepEqual([lines[0].label, lines[0].ok, lines[0].fields],
    ['ball 1', true, ['returned', 'came 0.21 m left of centre', 'landed 0.62 m past the net']]);
  assert.deepEqual([lines[2].label, lines[2].ok, lines[2].fields],
    ['ball 3', false, ['missed: never touched', 'came 0.08 m right of centre', '5 cm from the blade']]);
  assert.match(lines[0].title, /cross_y_m: 0.2104/, 'the line\'s title is the row behind it');
  const ticks = scoreTicks(card, (t) => t - 1);
  assert.deepEqual(ticks.map((k) => [k.t, k.ok]).slice(0, 3), [[9, true], [13, true], [17, false]]);
  assert.equal(ticks.length, 10);
  assert.equal(levelText(card), 'level L2', 'the level in the header\'s scene line');
  const metrics = Object.fromEntries(metricRows(card.metrics).map(([label, text]) => [label, text]));
  assert.equal(metrics['cross y min'], '-0.0812 m');
  assert.equal(metrics['miss dist median'], '–');
  assert.equal(metrics['t done'], '49.123 s');
  assert.equal(metrics['execute count'], '2');
  assert.equal(metrics['ended by'], 'success');
  assert.equal(metrics['board tilt max'], '3.4 deg');
  assert.equal(metrics['ball speed max'], '0.2217 m/s');
  assert.equal(metrics['cells entered'], '12');
});

test('a time card without a maximum (Q1\'s scripted C-2 run): an en dash until the end, a line per cell, the maze named', () => {
  const fx = readScore('c2_q1_s9101.json');
  const s = scoredState(fx.task, fx.score, [{ key: 'goal_0', kind: 'component', component: 'maze_judge', at_least: 1,
    status_key: 'solved' }]);
  assert.deepEqual(pillsOf(s), ['#solved 0/1', 'hold'], 'the goal on `solved` is not the primary: its pill stays');
  assert.equal(scoreView(s.episode, 15).text, '–');
  const mid = scoreView(s.episode, 25);
  assert.equal(mid.rows.length, fx.score.trials.filter((r) => r.t <= 25).length);
  assert.equal(mid.text, '–', 'the time to solve is not known before the cup');
  for (const r of fx.rows) reduce(s, r);
  const end = scoreView(s.episode, 31);
  assert.equal(end.text, '29.4 s');
  assert.equal(end.mark, 'passed');
  assert.equal(end.final, true, 'a card stored before `final` existed was kept at the verdict');
  assert.deepEqual(pillsOf(s), ['#solved 1/1+', 'hold+']);
  const lines = trialLines(end.card, end.rows);
  assert.equal(lines.length, 12);
  assert.deepEqual([lines[0].label, lines[0].ok, lines[0].fields], ['cell A2', null, ['first visit', 'on the shortest route']]);
  assert.equal(levelText(fx.score), 'maze s2');
  assert.ok(s.feed.some((l) => l.text === 'the ball rests in the cup: the maze is solved'));
  // twelve trials, none of which says it went one way or the other: every tick is drawn, a faint one
  const ticks = scoreTicks(fx.score, (t) => t);
  assert.equal(ticks.length, 12);
  assert.ok(ticks.every((k) => k.ok === null));
});

test('grouped rows (R11\'s five tosses of eight pieces): one line per toss that opens to its rows; the game\'s events read', () => {
  const fx = readScore('c5_r11_s9001.json');
  // as recorded: the rows predate `value` and `ok`; a toss is still one line of eight rows
  let lines = trialLines(normCard(fx.card), normCard(fx.card).trials);
  assert.equal(lines.length, 5);
  assert.deepEqual([lines[0].label, lines[0].fields, lines[0].rows.length], ['toss 1', ['8 rows'], 8]);
  // with the two keys pan_toss.py now writes (the toss's running total on each of its rows, the row's point)
  let total = 0;
  const card = { ...fx.card, trials: fx.card.trials.map((r) => ({ ...r })) };
  for (let n = 1; n <= 5; n++) {
    const rows = card.trials.filter((r) => r.n === n);
    total += rows.filter((r) => r.point).length;
    for (const r of rows) Object.assign(r, { value: total, ok: r.point });
  }
  assert.equal(total, fx.card.primary.value);
  const s = scoredState(headOf(card), card, passedGoal('toss'));
  assert.deepEqual(pillsOf(s), ['hold']);
  const t3 = card.trials.find((r) => r.n === 3).t;
  const mid = scoreView(s.episode, t3);
  assert.equal(mid.text, `${card.trials.find((r) => r.n === 3).value}/40 pieces`);
  lines = trialLines(normCard(card), mid.rows);
  assert.equal(lines.length, 3, 'nothing of the fourth toss');
  assert.deepEqual([lines[0].label, lines[0].fields, lines[0].ok], ['toss 1', ['8 of 8'], true]);
  assert.deepEqual([lines[1].fields, lines[1].ok], [['5 of 8'], true], 'at least half of the pieces scored');
  assert.equal(groupOk([{ ok: true }, { ok: false }, { ok: false }]), false);
  assert.deepEqual([lines[0].rows[0].label, lines[0].rows[0].fields], ['veg_1 carrot', ['turned and caught', 'turned 90°', 'rose 8 cm']]);
  assert.equal(scoreTicks(card, (t) => t).length, 5, 'one tick per toss');
  // the toss events as feed lines (the game's wording) and the game's end
  const f = initialState();
  for (const r of fx.events) reduce(f, r);
  const texts = f.feed.map((l) => l.text);
  assert.equal(texts[0], 'toss 1 of 5: 8 turned, 8 of 8 in the pan — 8 points so far');
  assert.equal(texts[4], `toss 5 of 5: ${fx.events[4].turned} turned, 8 of 8 in the pan — 32 points in all`);
  assert.equal(texts[5], 'the game is over: 32 points in 5 tosses, 8 pieces kept — passed');
  assert.equal(f.feed[5].tone, 'ok');
  const shake = { ...fx.events[0], number: null, shake: true, counted: false, points: 0, turned: 0 };
  reduce(f, shake);
  assert.equal(f.feed[f.feed.length - 1].text, 'a shake: the pieces hopped too little to count as a toss');
  assert.equal(f.feed[f.feed.length - 1].tone, 'quiet');
  assert.equal(rowActor(shake), null, 'a shake makes no tick');
  assert.equal(rowActor(fx.events[0]), 'world');
});

test('a card kept unfinished reads "(unfinished)"; the picker shows an index entry\'s score beside its title', () => {
  const card = { ...launcherCard(), passed: false, success: false, reason: 'unfinished', final: false,
    primary: { ...launcherCard().primary, value: 4 } };
  const s = scoredState(headOf(card), card);
  reduce(s, episodeEnd(60, { status: 'timeout' }));
  const v = scoreView(s.episode, 60);
  assert.deepEqual([v.text, v.mark, v.final], ['4/10 balls', 'failed', false]);
  assert.match(v.title, /unfinished/);
  assert.equal(pickerScore({ label: 'balls returned', value: 8, of: 10, unit: 'balls', better: 'higher', passed: true,
    final: true }), '8/10 balls returned ✓');
  assert.equal(pickerScore({ label: 'time to solve', value: 29.4, of: null, unit: 's', better: 'lower', passed: true,
    final: true }), 'time to solve 29.4 s ✓');
  assert.equal(pickerScore({ label: 'seconds aloft', value: 61.0, of: 60.0, unit: 's', passed: true }), '61/60 seconds aloft ✓');
  assert.equal(pickerScore({ label: 'balls returned', value: 4, of: 10, unit: 'balls', passed: false, final: false }),
    '4/10 balls returned ✗ (unfinished)');
  assert.equal(pickerScore({ label: 'time to solve', value: null, of: null, unit: 's', passed: false }), 'time to solve – ✗');
  assert.equal(pickerScore(undefined), '');
  assert.equal(fmtPrimary(5.02, 60, 's'), '5.0/60 s');
  assert.equal(fmtPrimary(null, 10, 'balls'), '–');
  assert.deepEqual(unitField('tap_interval_median_s', 1.25), ['tap interval median', '1.25 s']);
});

test('an episode stopped before its verdict (Q1\'s C-3 run at a 40 s wall limit): the rows\' value, then "(unfinished)" at the recording\'s end', () => {
  const fx = readScore('c3_q1_unfinished_s9101.json');
  assert.equal(fx.score.final, false);
  const s = scoredState(fx.task, fx.score, [{ key: 'goal_0', kind: 'component', component: 'balloon_judge', at_least: 60,
    status_key: 'aloft_s' }]);
  for (const r of fx.rows) reduce(s, r);
  assert.ok(!fx.rows.some((r) => r.kind === 'task/episode_end'), 'the run never reached its verdict');
  const row = fx.score.trials.filter((r) => r.t <= 20).pop();
  const mid = scoreView(s.episode, 20);
  assert.equal(mid.text, `${row.value.toFixed(1)}/60 s`, 'the last row\'s own value, not the counter');
  assert.equal(mid.mark, null);
  const late = scoreView(s.episode, 1e6);
  assert.deepEqual([late.mark, late.final], [null, true], 'past the last row the episode still runs: nothing told ahead');
  const end = scoreView(s.episode, 1e6, { atEnd: true });
  assert.deepEqual([end.text, end.mark, end.final, end.ended], ['33.8/60 s', 'failed', false, true]);
  const ticks = scoreTicks(fx.score, (t) => t);
  assert.equal(ticks.length, fx.score.trials.length, 'twenty-seven taps: every one a tick');
  assert.ok(ticks.every((k) => k.ok === true));
});

test('a bundle without a card looks as it did: no score, its pills, the scene machines\' ticks', () => {
  const s = fresh();
  for (const r of ROWS) reduce(s, r);
  assert.equal(scoreView(s.episode, 1e9), null);
  assert.equal(s.episode.score_head, null);
  const c4 = initialState();
  reduce(c4, { kind: 'scene', scene: { name: 'papers/c4_paddle_return', task: { name: 'papers', goals: passedGoal('launcher') } } });
  assert.deepEqual(pillsOf(c4), ['#passed 0/1', 'hold'], 'without a card the pill stays');
  assert.equal(scoreView(c4.episode, 10), null);
  const rows = [{ kind: 'scene/component', t: 30, t_wall: 1030, component: 'launcher', trace_kind: 'ball_launcher',
    event: 'returned', ball: 'ball_2', n: 3 }, { ...episodeEnd(40), t_wall: 1040 }];
  assert.deepEqual(createPlayer({ meta: {}, rows, frames: null }).ticks.map((k) => k.who), ['world', 'task']);
  assert.deepEqual(createPlayer({ meta: {}, rows, frames: null, score: launcherCard() }).ticks.map((k) => k.who), ['task'],
    'with a card the machine\'s ticks would tell the game ahead: the card\'s own ticks, clipped at the playhead, stand in');
});

test('rows without their value (Q1\'s scripted C-3 run): the chip runs on the task\'s counter, up to the playhead', () => {
  const fx = readScore('c3_q1_s9101.json');
  const s = scoredState(fx.task, fx.score, [{ key: 'goal_0', kind: 'component', component: 'balloon_judge', at_least: 60,
    status_key: 'aloft_s' }]);
  assert.deepEqual(pillsOf(s), ['hold'], 'the chip shows what the aloft counter would');
  assert.equal(scoreView(s.episode, 5).text, '0.0/60 s', 'nothing counted yet: 0 of the maximum, a duration as the pill reads it');
  const upTo = fx.rows.filter((r) => r.kind !== 'task/episode_end' && r.t <= 40);
  for (const r of upTo) reduce(s, r);
  const last = upTo.filter((r) => r.kind === 'task/status').pop();
  const counted = Number(/aloft_s (\S+)\//.exec(last.hud_line)[1]);
  assert.equal(scoreView(s.episode, 40).text, `${counted.toFixed(1)}/60 s`);
  assert.equal(scoreView(s.episode, 40).rows.length, fx.score.trials.filter((r) => r.t <= 40).length);
  assert.equal(fx.score.trials.length > TICKS_ALL_MAX, true);
  assert.deepEqual(scoreTicks(fx.score, (t) => t), [], 'forty-nine taps that say nothing either way: no ticks');
  for (const r of fx.rows.filter((x) => !upTo.includes(x))) reduce(s, r);
  const end = scoreView(s.episode, 80);
  assert.deepEqual([end.text, end.mark], ['61.0/60 s', 'passed']);
  const lines = trialLines(end.card, end.rows);
  assert.deepEqual([lines[1].label, lines[1].fields], ['tap 2', ['by the paddle', 'at 1.21 m', 'rose to 1.4 m', '0.77 s after the last']]);
});

test('the feed tells the new events: C-1\'s target passes, C-4\'s decided balls, C-6\'s banana; the balloon\'s stay its own', () => {
  const s = initialState();
  const c = (kind, event, o, t = 30) => ({ kind: 'scene/component', t, t_wall: 2000 + t, component: 'x', trace_kind: kind, event, ...o });
  const lines = (rows) => {
    const n = s.feed.length;
    for (const r of rows) reduce(s, r);
    return s.feed.slice(n).map((l) => l.text);
  };
  // C-1: the target comes round, passes by, comes round again and is taken; the other items' spawns are no news
  assert.deepEqual(lines([
    c('conveyor', 'spawn', { object: 'item_02', n: 1, target: false }),
    c('conveyor', 'spawn', { object: 'item_07', n: 2, target: true }),
    c('conveyor', 'retire', { object: 'item_07', reason: 'exit', target: true }),
    c('conveyor', 'pass', { object: 'item_07', n: 1, outcome: 'passed' }),
    c('conveyor', 'spawn', { object: 'item_07', n: 5, target: true }),
    c('conveyor', 'taken', { object: 'item_07', gripper: 'right' }),
    c('conveyor', 'pass', { object: 'item_07', n: 2, outcome: 'taken' }),
    c('conveyor', 'taken', { object: 'item_03', gripper: 'left' }),
  ]), ['the target comes round: pass 1', 'pass 1 of the target: passed by', 'the target comes round: pass 2',
    'pass 2 of the target: taken (right hand)', 'item_03 taken off the belt (left hand)']);
  // C-4: where the ball came and where it went; an older row as before
  assert.deepEqual(lines([
    c('ball_launcher', 'returned', { ball: 'ball_3', n: 4, along_m: 0.62, across_m: 0.1, cross_y_m: 0.2104, land_along_m: 0.6231 }),
    c('ball_launcher', 'missed', { ball: 'ball_4', n: 5, reason: 'not_touched', cross_y_m: -0.0812, land_along_m: null }),
    c('ball_launcher', 'missed', { ball: 'ball_5', n: 6, reason: 'own_half', cross_y_m: null }),
    c('ball_launcher', 'returned', { ball: 'ball_2', n: 3 }),
  ]), ['ball 4: returned — came 0.21 m left of centre, landed 0.62 m past the net',
    'ball 5: missed, never touched — came 0.08 m right of centre', 'ball 6: hit, but it bounced on the robot\'s own side',
    'ball 3 returned over the net']);
  // C-6: no line for a free turn; the robot's contacts and the banana's fate
  assert.deepEqual(lines([
    c('pendulum', 'turn', { n: 1, side: 'left', x: 0.28, y: 0.3, z: 0.75 }),
    c('pendulum', 'touch', { by: 'left', pinch: false }),
    c('pendulum', 'touch', { by: 'left', pinch: true }),
    c('pendulum', 'knock', { by: 'body' }),
    c('pendulum', 'knock', { by: 'right' }),
    c('pendulum', 'release', { load_n: 3.4217, held_by: 'left' }),
    c('pendulum', 'taken', { by: 'left' }),
    c('pendulum', 'dropped', {}),
  ]), ['the banana brushes the left hand', 'the left hand pinches the banana', 'the banana knocks against the body',
    'the banana knocks against the right arm', 'the banana comes off the cord (pulled with 3.4 N, left hand)',
    'the banana is taken (left hand)', 'the banana is dropped']);
  // the same event names of other machines keep their own words
  assert.deepEqual(lines([c('balloon', 'release', { hand: 'left', pad_z: 0.8 }), c('ball_launcher', 'touch', { n: 2, by: 'paddle' })]),
    ['the balloon is let go (a left hand under it)']);
  assert.equal(rowActor(c('pendulum', 'taken', { by: 'left' })), 'world', 'the take is a tick of the time bar');
});

test('relAt is the inverse of simAt: through the rows\' (wall, sim) pairs, and through frames placed on the playback clock', () => {
  const rows = [10, 20, 35, 50].map((t, i) => ({ kind: 'task/status', t, t_wall: 1000 + 2 * i * i + t, status: 'running' }));
  const pl = createPlayer({ meta: {}, rows, frames: null });
  for (const x of [0, 3.3, 17.5, 41, pl.duration]) assert.ok(Math.abs(pl.relAt(pl.simAt(x)) - x) < 1e-6, `at ${x}`);
  assert.equal(pl.relAt(null), null);
  const n = 100;
  const data = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) data.set([5 + 0.1 * i, 0], 2 * i);
  const frames = { n, nq: 1, stride: 2, data, t_first: 5, t_last: 5 + 0.1 * (n - 1), hz: 10, t_rel0: 0 };
  const pf = createPlayer({ meta: { duration_s: 9.9, t0_wall: 1000 }, rows: [{ kind: 'meta', t: 5, t_wall: 1000 }], frames });
  assert.ok(Math.abs(pf.relAt(7.25) - 2.25) < 1e-4);
  assert.ok(Math.abs(pf.simAt(pf.relAt(9.03)) - 9.03) < 1e-4);
});

test('live: the card comes with the episode\'s end (before it the chip cannot know: an en dash), a new episode starts without it', () => {
  const card = launcherCard();
  const s = scoredState(headOf(card), null, passedGoal('launcher'));
  assert.deepEqual(pillsOf(s), ['hold'], 'the head alone says a chip stands for the verdict');
  const before = scoreView(s.episode, 30);
  assert.deepEqual([before.text, before.label, before.card], ['–', 'balls returned', null]);
  reduce(s, episodeEnd(60, { extras: { score: card } }));
  const end = scoreView(s.episode, 60);
  assert.deepEqual([end.text, end.mark, end.rows.length], ['7/10 balls', 'passed', 10]);
  reduce(s, { kind: 'task/episode_start', t: 0.5, t_wall: 3000, episode: 2, task: 'papers' });
  assert.equal(s.episode.score_card, null);
  // a replay's card is the bundle's: an episode start row in its timeline keeps it
  const r = scoredState(headOf(card), card);
  reduce(r, { kind: 'task/episode_start', t: 0.5, t_wall: 3000, episode: 1, task: 'papers' });
  assert.ok(r.episode.score_card);
});

// ---- C-6's swing (contract H4 section 4): a scripted run's rows, medium swing, seed 23, the right hand -------------------------
test('C-6: the watch line says what the lane sees of the swing; the arc only while the fit is settled, the meeting from the launch on', () => {
  const fx = readScore('c6_h4_s23_medium.json');
  const s = scoredState(fx.task, fx.score);
  const rows = createPlayer({ meta: {}, rows: fx.rows, frames: null, score: fx.score }).rows;
  const at = (pred) => {
    for (; at.i < rows.length; at.i++) {
      reduce(s, rows[at.i]);
      if (pred(rows[at.i])) return rows[at.i++];
    }
    throw new Error('the row never came');
  };
  at.i = 0;
  const watchAt = (t) => (r) => r.trace_kind === 'watch' && Math.abs(r.t - t) < 0.01;
  // while the fit settles: the lane's own reasons, no arc
  let r = at(watchAt(12.38));
  assert.equal(r.entry.swing.settled, false);
  assert.equal(watchLine(s).text, `track right: watching the target swing: ${r.entry.swing.why}`);
  assert.equal(swingView(s, r.t), null, 'nothing drawn before the fit is settled');
  // settled and waiting at the ready point: the sentence whole, the meeting time after it, the arc of the next period
  r = at(watchAt(13.38));
  assert.match(watchLine(s).text, /^track right: the target swings: a period of 2\.9 s, 0\.30 m to each side; it will stand still at its right turn in 2\.7 s · meets it in [\d.]+ s$/);
  let v = swingView(s, r.t);
  assert.equal(v.path.length, 24);
  assert.deepEqual(v.path[0], r.entry.predicted_path[0]);
  assert.equal(v.meeting, null, 'no meeting planned on the page before the launch');
  // the launch: the feed names the turn, the arc gets its meeting
  r = at((x) => x.trace_kind === 'rt' && x.event === 'launch');
  assert.equal(s.feed[s.feed.length - 1].text, `snatch_side_right: launch #1 at its right turn in ${(r.t_contact - r.t).toFixed(1)} s (right)`);
  v = swingView(s, r.t);
  assert.deepEqual(v.meeting, r.p_contact);
  // the hand plans while it rides carry the arc and the meeting; the mark stays until just after the contact
  r = at((x) => x.trace_kind === 'plan' && x.channel === 'hand' && x.state === 'closing');
  assert.deepEqual(swingView(s, r.t).meeting, r.meeting.p_contact);
  assert.equal(swingView(s, r.meeting.t_contact + SWING_MEET_LINGER_S + 0.01).meeting, null);
  // the fit breaks once the hand holds the banana: the arc goes with the first hand plan without it
  r = at((x) => x.trace_kind === 'plan' && x.channel === 'hand' && !x.predicted_path);
  assert.equal(swingView(s, r.t), null);
  assert.equal(s.jev.swing, null);
  // the banana's fate in the feed, then the run's end and the card
  for (; at.i < rows.length; at.i++) reduce(s, rows[at.i]);
  const texts = s.feed.map((l) => l.text);
  for (const line of ['the right hand touches the banana', 'the right hand pinches the banana',
    'the banana comes off the cord (pulled with 4.8 N, right hand)', 'the banana is taken (right hand)']) {
    assert.ok(texts.includes(line), line);
  }
  assert.ok(!texts.some((t) => /turn/.test(t) && /swing|banana/.test(t) && !/launch/.test(t)), 'no line for a free turn');
  const end = scoreView(s.episode, 1e6);
  assert.deepEqual([end.text, end.mark], ['11 swings', 'passed']);
  const lines = trialLines(end.card, end.rows);
  assert.deepEqual([lines[0].label, lines[0].ok], ['turn 1', null]);
  assert.deepEqual([lines[lines.length - 1].label, lines[lines.length - 1].ok], ['taken', true]);
  assert.equal(levelText(fx.score), 'swing medium');
  assert.equal(swingView(s, 1e6), null, 'nothing of the arc after the run');
});

test('C-6: a run that ends removes its arc; another track\'s plans leave it; the helpers refuse what is not a settled fit', () => {
  const fx = readScore('c6_h4_s23_medium.json');
  const settled = fx.rows.find((r) => r.trace_kind === 'watch' && r.entry.swing && r.entry.swing.settled === true);
  assert.equal(swingArc(settled.entry).length, 24);
  assert.equal(swingArc({ ...settled.entry, swing: { ...settled.entry.swing, settled: false } }), null);
  assert.equal(swingArc({ swing: true, predicted_path: settled.entry.predicted_path }), null, 'a `swing: true` flag is no fit');
  assert.equal(swingMeeting({ p_contact: [1, 2] }), null);
  assert.deepEqual(swingMeeting({ meeting: { turn: 'left', t_contact: 3, p_contact: [0.1, 0.2, 0.7] } }), { p: [0.1, 0.2, 0.7], t: 3, turn: 'left' });
  const s = initialState();
  const upTo = fx.rows.slice(0, fx.rows.indexOf(settled) + 1);
  for (const r of upTo) reduce(s, r);
  assert.ok(swingView(s, settled.t), 'the arc is up');
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'plan', t: settled.t + 0.1, t_wall: settled.t_wall + 0.1, channel: 'gaze',
    motion: 'gaze_track', rt: true, reedit: true, track: 'gaze', points: [[0.5, -0.7], [0.5, -0.7]] });
  assert.ok(swingView(s, settled.t + 0.1), 'a gaze re-plan leaves the arc');
  reduce(s, { kind: 'research/jev_trace', trace_kind: 'run_end', t: settled.t + 0.2, t_wall: settled.t_wall + 0.2,
    motion: 'snatch_side_right', channel: 'hand', outcome: 'stopped' });
  assert.equal(swingView(s, settled.t + 0.2), null, 'the run ended');
  assert.equal(rtWatchText({ why: 'real-time lane: track left: waiting at the ready point, meets it in 4.8 s; pace normal; 0 attempts' }),
    'track left: waiting at the ready point, meets it in 4.8 s', 'a belt\'s report reads as before');
});

// ---- why the hand did not take it (contract H4 pass 2): rows cut from the lead's group_c_v2 bundles -----------------------------
const REASONS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'scores', 'c1_c6_reasons_v2.json'), 'utf8')).bundles;

/** Reduce a cut bundle's rows in replay order up to sim time `until`; returns the state and the feed lines it added. */
function reasonsUpTo(id, until = Infinity, s = initialState()) {
  const lines = [];
  for (const r of createPlayer({ meta: {}, rows: REASONS[id].rows, frames: null }).rows) {
    if (r.t != null && r.t > until) break;
    const n = s.feed.length;
    reduce(s, r);
    lines.push(...s.feed.slice(n));
  }
  return { s, lines: lines.map((l) => l.text) };
}

test('C-1 v005 s9001 / s9002: an abandoned reach says why in the feed and on the Engine block until the next launch', () => {
  const { s, lines } = reasonsUpTo('c1_conveyor_pick_v005_s9001', 59.2);
  assert.equal(lines[lines.length - 1],
    'snatch_top_right: gave up the reach (right) — the target would ride out of the arm\'s reach before the jaws close');
  const run = s.engine.run;
  assert.equal(rtReasonLine(run).text,
    'Last attempt: gave up the reach — the target would ride out of the arm\'s reach before the jaws close');
  assert.match(rtReasonLine(run).title, /the lane: the target rides out of the arm's zone before the jaws can close/);
  assert.equal(rtCountText(run), 'launches 1 · misses 1');
  // a paused replay a few seconds later still explains itself, and the lane's report reads in plain words
  const later = reasonsUpTo('c1_conveyor_pick_v005_s9001', 62);
  assert.ok(rtReasonLine(later.s.engine.run), 'the reason stands until the next launch');
  assert.equal(watchLine(later.s).text,
    'track right: waiting at the ready point, no meeting: the target\'s predicted path does not come within the arm\'s reach in time');
  const b = reasonsUpTo('c1_conveyor_pick_v005_s9002');
  assert.ok(b.lines.includes('snatch_side_left: gave up the reach (left) — the target would ride out of the arm\'s reach before the jaws close'));
});

test('C-1 v020 s9009: out of sight, a pass without an attempt (short ride), then the launch clears the reason', () => {
  const lost = reasonsUpTo('c1_conveyor_pick_v020_s9009', 125.0);
  assert.equal(rtReasonLine(lost.s.engine.run), null, 'the target out of sight is no reason the hand failed: a quiet line only');
  assert.equal(lost.s.feed.find((l) => /lost sight/.test(l.text)).tone, 'quiet');
  const { s, lines } = reasonsUpTo('c1_conveyor_pick_v020_s9009', 126);
  assert.ok(lines.includes('snatch_side_right: armed (right)'), 'the start at the ready point as before');
  assert.ok(lines.includes('snatch_side_right: armed (right) — lost sight of the target, waiting for it to come back'));
  assert.equal(lines[lines.length - 1],
    'snatch_side_right: no attempt this pass (right) — the target does not stay within the arm\'s reach long enough for a grasp');
  assert.equal(rtReasonLine(s.engine.run).text,
    'Last pass: no attempt — the target does not stay within the arm\'s reach long enough for a grasp');
  const after = reasonsUpTo('c1_conveyor_pick_v020_s9009', 129.4);
  assert.equal(rtReasonLine(after.s.engine.run), null, 'the launch at 129.3 s clears it');
  const end = reasonsUpTo('c1_conveyor_pick_v020_s9009');
  assert.ok(end.lines.includes('snatch_side_right: capture #1 (right)'));
  assert.equal(rtReasonLine(end.s.engine.run), null);
});

test('C-6 gentle s9001: passes on a swing say their cause once (no repeats), a missed grasp, the waiting hand brushed quietly', () => {
  const { s, lines } = reasonsUpTo('c6_banana_swing_gentle_s9001', 21.21);
  const notSettled = 'snatch_side_right: no attempt this pass (right) — it had not watched the target long enough to predict where to meet it';
  assert.deepEqual(lines.filter((x) => /no attempt/.test(x)), [notSettled], 'two passes 0.3 s apart, one line');
  assert.equal(rtReasonLine(s.engine.run).text,
    'Last pass: no attempt — it had not watched the target long enough to predict where to meet it (2 passes in a row)');
  const all = reasonsUpTo('c6_banana_swing_gentle_s9001').lines;
  assert.ok(all.includes('snatch_side_right: missed the grasp (right) — the jaws closed on nothing'));
  assert.ok(all.includes('snatch_side_right: no attempt this pass (right) — its turn on this side lies too far ahead for this arm '
    + '(0.33 m ahead; it reaches 0.14-0.34 m)'));
  assert.equal(all.filter((x) => /too far ahead/.test(x)).length, 1, 'the same cause again after a pause: no repeat');
  assert.equal(all.filter((x) => x === 'the right hand touches the banana').length, 2, 'the two touches of the attempt');
  assert.deepEqual(all.filter((x) => /brushes/.test(x)), ['the banana brushes the right hand'], 'outside the attempt: once, quietly');
  assert.ok(all.some((x) => /^paused · object moved — The target obj:banana went by 2 times/.test(x)), 'the pauses keep their advice');
});

test('the reasons\' words: every miss and cause the lane writes, the other arm, an unknown text as the lane wrote it', () => {
  assert.deepEqual(missWords('the jaws closed and hold nothing (timed out)'), ['missed the grasp', 'the jaws closed on nothing (they ran out of time)']);
  assert.deepEqual(missWords('the pads hold but the hand rose only 0.1 cm of 10 cm; the arm\'s body rule refused 63 steps of the take-off (a against b)'),
    ['could not lift it', 'the hand rose only 0.1 cm of 10 cm, its own body in the way']);
  assert.deepEqual(missWords('the hold was lost during the take-off'), ['lost it on the lift', 'it slipped out of the hand']);
  assert.deepEqual(missWords('the arm cannot follow the riding curve (the IK\'s residual beyond rt.ik_pos_tol_m)'),
    ['gave up the reach', 'the arm could not follow the target\'s path']);
  assert.deepEqual(missWords('a reason of tomorrow'), ['gave up', 'a reason of tomorrow']);
  assert.equal(noMeetingWords({ cause: 'short ride', why: 'this arm\'s turn holds no ride inside its zone', arm: 'right', other_arm_meets: true }),
    'its turn on this side leaves the hand too short a ride to close on it; the left hand could have met it');
  assert.equal(noMeetingWords({ cause: 'too near', x_m: 0.12, reach_x_m: [0.1375, 0.3375], why: 'the predicted path never lies …' }),
    'the target passes too close to the body for this arm (0.12 m ahead; it reaches 0.14-0.34 m)');
  assert.equal(noMeetingWords({ cause: 'ride too fast' }), 'the target moves faster than the arm can follow');
  assert.equal(noMeetingWords({ cause: 'late', why: 'late: waiting for the second turn on this arm\'s side' }),
    'it waits for a later turn (the decision says late)');
  assert.equal(noMeetingWords({ cause: 'something new', why: 'a sentence the page does not know' }), 'a sentence the page does not know');
  assert.equal(meetWhyWords('the arm\'s zone holds the ride for less than rt.track.meet.min_window_s'),
    'the target stays within the arm\'s reach too briefly to close on it');
  assert.equal(armedWords('at the ready point, waiting for the target to come into view'), null);
  // C-4: whether the paddle touched it, from the card's row of the same ball
  const card = launcherCard();
  card.trials[2] = { ...card.trials[2], reason: 'off_table', touched: true };
  card.trials[4] = { ...card.trials[4], reason: 'off_table', touched: false };
  const c4 = scoredState(headOf(card), card);
  reduce(c4, { kind: 'scene/component', t: 18, t_wall: 2018, trace_kind: 'ball_launcher', event: 'missed', ball: 'ball_2', n: 3,
    reason: 'off_table', cross_y_m: -0.11 });
  reduce(c4, { kind: 'scene/component', t: 26, t_wall: 2026, trace_kind: 'ball_launcher', event: 'missed', ball: 'ball_4', n: 5,
    reason: 'off_table', cross_y_m: 0.17 });
  assert.deepEqual(c4.feed.slice(-2).map((l) => l.text), ['ball 3: hit, but it went off the table — came 0.11 m right of centre',
    'ball 5: missed, never touched (it went off the table) — came 0.17 m left of centre']);
  assert.deepEqual(trialLines(normCard(card), card.trials).slice(2, 5).filter((x) => !x.ok).map((x) => x.fields[0]),
    ['hit, but it went off the table', 'missed: never touched (it went off the table)']);
});

// ---- report -------------------------------------------------------------------------------------------------------------
let failed = 0;
for (const [ok, name, err] of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) {
    failed += 1;
    console.log(`     ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n     ')}`);
  }
}
for (const [name, why] of skipped) console.log(`skip ${name}: ${why}`);
console.log(`\n${results.length - failed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ''} (${ROWS.length} fixture rows)`);
if (failed) process.exitCode = 1;
