// The pipeline reducer over a recorded episode (docs/design/WEB_HUD.md section 9, "JavaScript"):
//
//   node web/tests/test_pipeline.mjs
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
  EVENTS_MAX, PULSES_MAX, STEPS_MAX } from '../src/model/pipeline.js';
import { SPEEDS, createPlayer } from '../src/transport/replay.js';
import { engineStatus, engineTag, watchLine, jevBadges, runCountsText, spliceChanged } from '../src/hud/panel.js';
import { pickMimeType, recordingName } from '../src/util/recorder.js';

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
