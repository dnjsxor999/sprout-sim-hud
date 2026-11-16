// The pipeline reducer: timeline rows -> the HUD state (docs/design/WEB_HUD.md section 8.3).
//
// A row is one record of the experiment timeline (sprout_sim/recorder/timeline.py): `kind`, `t` (sim seconds or
// null), `t_wall` (Unix seconds) and the payload's own keys. Live and replay deliver the same rows, so this one pure
// function drives the page in both modes. It is deterministic (no clocks, no randomness: time comes only from the rows
// and from `tick`), and O(1) per row apart from small bounded lists, because a replay seek re-reduces every row up to
// the target time. Pseudo-rows let the transports hand over what is not a timeline record: `{kind: 'library', items}`
// (the motion memory), `{kind: 'scene', scene, seed}` (the scene dict or name), `{kind: 'robot', mode, state}` (the
// robot's control mode from the live state stream), `{kind: 'viewer', text}` (the viewer's own action in a live run,
// a dragged object, so the reaction that follows reads as one story), `{kind: 'hold', motion, t, t_wall, why, phase}`
// (a replay only: the playhead held while the engine asked the decider, see `holdRows`), `{kind: 'task_shape', keys,
// counters}` (a replay only: the task's pills the recording will show, see `taskShape`) and `{kind: 'score', card}` (a
// replay only: the bundle's scorecard, which model/score.js reveals up to the playhead).

import { num, isObj, clamp, short, decisionWords, decisionFields, decisionConfidence, bindingsText, shortBinding, fmtCm, fmtP }
  from '../util/format.js';
import { CHANNELS } from '../util/colors.js';
import { scoreHead, cameWords } from './score.js';

export const FEED_MAX = 500;            // feed lines kept (the feed is the page's only full record)
export const EVENTS_MAX = 50;           // engine events kept
export const PULSES_MAX = 40;           // pulses kept for the panel to animate
// a real-time motion is re-edited several times a second: its re-edits travel the JEV -> engine wire as the standard
// engine's do, one pulse per this much of the recording (half a pulse's travel: a steady stream, not a blur)
export const RT_PULSE_GAP_S = 0.75;
export const TEXT_MAX = 400;            // characters of the LLM's last words
export const THINK_FEED_MIN_S = 2.0;    // a gap between a tool answer and the next call this long gets a feed line
export const MARKS_MAX = 64;            // watch / re-edit marks kept on the phase bar
export const STEPS_MAX = 8;             // JEV's steps kept for the current command (the panel shows the last five)
// an extrapolated phase stops short of the end: a motion's last stretch (a grasp closing, a hand settling) can outlast
// its plan, and the bar reads 100 % only when the engine reports the run's end
export const PHASE_EXTRAPOLATION_CAP = 0.99;

const PERCEIVE_TOOLS = new Set(['get_camera_image', 'detect_objects', 'get_depth_at', 'get_robot_state', 'get_contacts',
  'get_task_status']);
const CHOOSE_TOOLS = new Set(['jev_execute', 'jev_modify', 'jev_declare_target', 'jev_stop']);
const DECISION_KEYS = ['face', 'pinch', 'pad_from_top_m', 'elevation_deg', 'yaw_deg', 'via_lift_m', 'clearance_m',
  'point', 'level', 'speed', 'waist', 'min_confidence', 'confidence', 'dimensions', 'exempt', 'reason', 'values'];
// the fields a step names when it sums a decision up: the grasp's pose, or where and how a held object is set down
const GIST_GRASP = ['pad_from_top_m', 'elevation_deg', 'yaw_deg'];
const GIST_PLACE = ['clearance_m', 'point', 'level', 'yaw_deg'];
// a step is a sentence, so the card's abbreviated labels are spelled out where they would read as jargon
const STEP_LABEL = { elev: 'elevation', clear: 'clearance' };
// why a decision was taken again, by the change record's kind
const CHANGE_WORDS = { collision: 'collision predicted', modify: 'the LLM modified it', watch: 'the watch asked' };
// a scene change in words, by the engine's change kind: a pause's cause, a hold's, a re-edit's (H1, 2026-11-09)
const KIND_WORDS = { moved: 'object moved', shape: 'shape changed', body: 'body moved', off_goal: 'off goal',
  pushed: 'object pushed', lost: 'object lost', stalled: 'hand stalled' };
// the counts a hand run's end carries (the engine's records of 2026-11-09): the outcome line sums the run up with them
const COUNT_KEYS = ['n_reedits', 'n_reedits_follow', 'n_reedits_body', 'n_reedits_off_goal', 'n_reedits_decision',
  'n_watch_passes', 'n_watch_changes', 'splice_latency_max_s', 'n_redecisions_async', 'redecision_latency_max_s',
  'held_total_s'];
// the rows of one engine tick carry the same sim time: a re-edit or a pause this close to a landed re-decision is its outcome
const SAME_TICK_S = 1e-3;
// the time bar's predicate pills (section 8.1): the classic tasks' four, always shown for them (and for a task the page
// knows nothing about yet); a `papers` task names its goals `goal_<i>` and its success hold `hold` (tasks/paper_task.py)
export const CLASSIC_PREDICATES = ['in_region', 'at_rest', 'on_surface', 'released'];
const GOAL_KEY = /^goal_(\d+)$/;
const HOLD_KEY = 'hold';
// a scene component's events (scenes/components.py, the `scene/component` rows) that a viewer cares about get a World
// feed line; the judge's own counts among them also get a tick on the time bar. Every other event is left out: the
// noisy ones (a belt's spawn and retire, the maze ball's cell, a speed change, a touch) and those the page does not know
const COMPONENT_TICK_EVENTS = new Set(['solved', 'toss', 'returned', 'taken']);
// a real-time run's phase that falls back by more than this has wrapped (a loop's next cycle), not re-entered its curve
const LOOP_WRAP = 0.5;
// the real-time lane's key moments (`rt` traces) by event (rtCountText): `count`, the plural a counted moment takes on the
// run line; `state`, a moment that is a state the run reached (named without its count when it came once); `stage`, a step
// on the way to a key moment (a feed line only)
const RT_MOMENTS = {
  launch: { count: 'launches' }, capture: { count: 'captures' }, cell: { count: 'cells' }, stroke: { count: 'strokes' },
  toss: { count: 'tosses' }, catch: { count: 'catches' }, strike: { count: 'strikes' }, hit: { count: 'hits' },
  bump: { count: 'bumps' }, tap: { count: 'taps' }, miss: { count: 'misses' },
  lifted: { state: true }, solved: { state: true }, blocked: { state: true }, armed: { state: true },
  close: { stage: true }, open: { stage: true }, grasp: { stage: true }, lift: { stage: true }, track_ended: { stage: true },
  // a pass of the target without a meeting in the arm's zone (C-6's swing, a belt item): a feed line, not a count to follow
  no_meeting: { stage: true },
};
// the states a later moment contradicts: the maze's ball `blocked` until it reaches the next cell (or the run resumes)
const RT_ENDS = { cell: ['blocked'] };

/** The LLM phase a starting tool call puts the planner in (section 8.3, "Phase rules"). */
export function phaseOfTool(tool) {
  if (PERCEIVE_TOOLS.has(tool)) return 'perceiving';
  if (tool === 'jev_query_options') return 'asking';
  if (CHOOSE_TOOLS.has(tool)) return 'choosing';
  if (tool === 'jev_wait_turn') return 'waiting';
  return 'acting';
}

export function initialState() {
  return {
    seq: 0,        // pulse ids (monotonic: the panel animates each id once)
    feed_seq: 0,   // feed line ids (monotonic: the feed appends what it has not drawn)
    step_seq: 0,   // JEV step ids (monotonic: the panel reveals each id once, in order)
    episode: {
      scene: null, seed: null, task: null, n: null, clock_mode: null, status: 'idle', status_key: null,
      predicates: {}, hud_line: '', outcome: null, message: '', t_start: null, t_elapsed: null,
      t: null, t_wall: null, t0_wall: null,
      closed: false, // the episode ended: until the next starts, the rows that only report the shutdown are left out
      regions: [],   // the scene dict's region names (a mover row about one names "the target")
      // the task's predicate names in the order the rows first gave them (the pills never reorder or vanish), and a
      // `papers` task's component counters read off its HUD line: `{key, text, value, at_text, at_least}`; the goals as
      // the scene dict describes them (`task.goals`: `{key, kind, object, region, component, status_key, at_least}`)
      pred_keys: [], counters: [], goals: [],
      // the scorecard (model/score.js): its head as the scene dict describes it (known from the start), and the judge's
      // card -- a replay's from the bundle (`score_seeded`: it outlives an episode start row), a live run's from the
      // episode's end
      score_head: null, score_card: null, score_seeded: false,
      // the conveyor's target (C-1): its names from the spawns that say so, the passes it began, the hand that took it
      targets: [], target_passes: 0, target_taken_by: null,
      // contacts already told once outside an attempt (C-6: the swinging banana brushing a waiting hand every swing)
      quiet_keys: [],
    },
    llm: {
      phase: 'idle', thinking_s: 0, thinking_total_s: 0, thinking_closed_s: 0, gap_t_wall: null,
      text: '', text_t_wall: null, tool: null, calls: [], n_calls: 0,
      image: null, detect: null, choice: null, turn: null,
    },
    jev: {
      busy: null, query: null, menu: null, command: null, decision: null, n_redecisions: 0, refusal: null,
      accepted: null, watch: null, watch_dm: null, rt_pulse_tw: null, plan: null, plan_seq: 0,
      // the running motion's re-edits: `reedits` counts the follows of a moved object, `splices` the changed decisions
      // spliced in, `chain` the mid-run runs of older recordings; `landing` is the engine's own re-decision that just
      // landed, whose outcome (re-edited, paused, the decision stands) comes with the rows of the same tick
      reedits: 0, splices: 0, chain: 0, landing: null,
      // the current command's steps (section 11.2): `{id, t_wall, t, kind, text, tone, decision?, refusal?}`, the newest
      // last; `steps_total` counts the steps the command made (older ones fall off the list), `steps_cmd_t_wall` is
      // when the command started (the steps' time column counts from it)
      steps: [], steps_total: 0, steps_cmd_t_wall: null,
      // a swinging target as the real-time lane predicts it (contract H4 section 4, C-6): the arc of its next period
      // (`path`, world points) while the lane's periodic fit is settled, and the meeting it plans (`meeting`: `{p, t,
      // turn}`, the pads' contact); null when there is none, the fit broke or the run ended. `swing_seq` counts changes
      // (the viewport redraws on them).
      swing: null, swing_seq: 0,
    },
    engine: { run: null, mode: null, control: null, mode_change: null, events: [], fault: null },
    // `also`: the motions of the tracks that joined the running one (a gaze track beside the hands), running too
    memory: { items: [], added: [], active: null, also: [], candidates: [] },
    pulses: [],
    feed: [],
  };
}

// ---- small helpers ------------------------------------------------------------------------------------------------
function feed(s, who, text, tw, t = null, tone = null) {
  if (!text) return;
  s.feed_seq += 1;
  s.feed.push({ n: s.feed_seq, t_wall: tw, t, who, text, tone });
  if (s.feed.length > FEED_MAX) s.feed.shift();
}

function pulse(s, from, to, label, tw) {
  s.seq += 1;
  s.pulses.push({ id: s.seq, from, to, label, t_wall: tw });
  if (s.pulses.length > PULSES_MAX) s.pulses.shift();
}

/** A new command (a question or an execute) begins: its steps start from an empty list. */
function resetSteps(s, tw) {
  s.jev.steps = [];
  s.jev.steps_total = 0;
  s.jev.steps_cmd_t_wall = tw;
  s.jev.landing = null;
}

/** One step of JEV's work on the current command (section 11.2). `tone`: null or 'ok' (teal), 'warn' (amber: a
 * re-decision, a re-edit, an intervention), 'fail' (red: a refusal). `extra` carries the snapshots the decision card
 * and the refusal pill show while this step is the one revealed. */
function addStep(s, kind, text, tw, t, tone = null, extra = null) {
  const j = s.jev;
  s.step_seq += 1;
  j.steps.push({ id: s.step_seq, t_wall: tw, t, kind, text, tone, ...(extra || {}) });
  j.steps_total += 1;
  if (j.steps.length > STEPS_MAX) j.steps.shift();
}

function engineEvent(s, ev, tw, t) {
  s.engine.events.push({ t_wall: tw, t, event: ev.event, motion: ev.motion ?? null, reason: ev.reason ?? null });
  if (s.engine.events.length > EVENTS_MAX) s.engine.events.shift();
}

function trimDecision(d) {
  if (!isObj(d)) return null;
  const o = {};
  for (const k of DECISION_KEYS) if (k in d) o[k] = d[k];
  // a decision over dimensions of its own (a real-time motion's pace, side, tilt, ...) keeps them, so the card can show
  // them (format.js decisionFields)
  for (const k of Array.isArray(d.dimensions) ? d.dimensions : []) {
    const key = String(k);
    if (!(key in o) && key in d) o[key] = d[key];
  }
  return o;
}

function kv(args, skip = []) {
  const parts = [];
  for (const [k, v] of Object.entries(isObj(args) ? args : {})) {
    if (skip.includes(k) || v == null) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : short(JSON.stringify(v), 40)}`);
  }
  return short(parts.join(' '), 90);
}

/** A channel guess from a motion id, for motions the library does not list (display only). */
function channelGuess(motion) {
  const m = String(motion ?? '');
  if (/^(look|scan)_/.test(m)) return 'gaze';
  if (/^(walk|turn|strafe|crawl)_/.test(m)) return 'base';
  if (/^lean_/.test(m)) return 'root';
  return 'hand';
}

/** The channel of a motion: the library's when it lists the id, else a guess from the id. */
export function channelOf(state, motion) {
  const it = state.memory.items.find((x) => x.id === motion);
  return it ? it.channel : channelGuess(motion);
}

function normItem(it) {
  const id = String(it.id);
  return {
    id,
    channel: CHANNELS.includes(it.channel) ? it.channel : channelGuess(id),
    intent: it.intent ?? null,
    description: it.description ?? '',
    duration_s: num(it.duration_s),
    success_rate: num(it.success_rate),
    accumulated_from: it.accumulated_from ?? null,
    modes: Array.isArray(it.modes) ? it.modes.slice(0, 8).map(String) : [],
  };
}

function setItems(s, items) {
  if (!Array.isArray(items)) return;
  const next = items.filter((it) => isObj(it) && it.id != null).map(normItem);
  // children learned this episode that the new list does not carry yet (a library message can lag a run end)
  for (const id of s.memory.added) {
    if (!next.some((x) => x.id === id)) {
      const old = s.memory.items.find((x) => x.id === id);
      if (old) next.push(old);
    }
  }
  s.memory.items = next;
}

function addLearned(s, id, parent, channel, tw) {
  if (!s.memory.added.includes(id)) s.memory.added.push(id);
  if (!s.memory.items.some((x) => x.id === id)) {
    const p = s.memory.items.find((x) => x.id === parent);
    s.memory.items.push({
      id,
      channel: CHANNELS.includes(channel) ? channel : (p ? p.channel : channelGuess(parent)),
      intent: p ? p.intent : null,
      description: `kept from a successful run of ${parent}`,
      duration_s: null,
      success_rate: 1,
      accumulated_from: parent ?? null,
      modes: p ? p.modes : [],
      learned_t_wall: tw,
    });
  }
}

// ---- the thinking gap: from a tool answer to the next call ----------------------------------------------------------
function openGap(s, tw) {
  if (tw == null || s.llm.calls.length > 0 || s.llm.phase === 'done') return;
  s.llm.gap_t_wall = tw;
  s.llm.thinking_s = 0;
}

function closeGap(s, tw) {
  if (s.llm.gap_t_wall == null || tw == null) return null;
  const g = Math.max(0, tw - s.llm.gap_t_wall);
  s.llm.thinking_closed_s += g;
  s.llm.thinking_s = g;
  s.llm.thinking_total_s = s.llm.thinking_closed_s;
  s.llm.gap_t_wall = null;
  return g;
}

function setPhase(s, phase) {
  if (s.llm.phase !== 'done') s.llm.phase = phase;
}

// ---- the engine's run -------------------------------------------------------------------------------------------------
function startRun(s, f, tw) {
  const entry = num(f.entry_s, 0);
  const phase = num(f.phase, entry);
  const run = {
    motion: f.motion ?? null,
    channel: CHANNELS.includes(f.channel) ? f.channel : channelOf(s, f.motion),
    arm: f.arm ?? null,
    object_ref: f.object_ref ?? null,
    t_start: num(f.t_start),
    t_wall_start: tw,
    duration_s: num(f.duration_s),
    entry_s: entry,
    phase,
    anchor_t: num(f.t_start),
    anchor_t_wall: tw,
    anchor_phase: phase,
    paused: false,
    pause: null,
    outcome: null,
    reason: null,
    ended: false,
    ended_t_wall: null,
    n_watch: 0,
    n_intervene: 0,   // the decider checks of this run that asked to intervene (the watch line's verdict after the run)
    watch_marks: [],
    reedit_marks: [],
    splice_marks: [],   // the changed decisions spliced in: `{phase, text}` (a mark's tooltip is its step's text)
    held: null,         // the playhead holds while the engine asks the decider (a replay's `hold` row): `{why, since}`
    counts: null,       // the run end's counts (re-edits, the watch, the engine's own re-decisions) when it carries them
    accumulated: null,
    source: f.source ?? null,
    // a real-time motion (the curve engine's real-time lane): its plan says `rt`, and a looping one repeats until it is
    // stopped, so its phase is the loop's own (it wraps from 1 back to 0) and nothing extrapolates it toward an end
    rt_plan: f.rt === true,
    loop: f.loop === true,
    rt: null,           // the lane's key moments by event (`rt` traces): {strike: 12, catch: 3}
    track: null,        // a real-time run's track (`hands`) and the channels of the tracks that joined it (`gaze`)
    joined: [],
    motions: f.motion != null ? [f.motion] : [],   // its motion and those of the tracks that joined it (runHas)
    joined_bind: null,  // what a joined track is bound to, in words ("gaze → obj:ball_*")
    hands_plan: null,   // its hands' latest plan, which the overlays keep while another track re-plans
    rt_over: [],        // the states of `rt` that a later record ended (`blocked` once the ball moves on or the run resumes)
    choice: null,       // the command (bindings, insight) and the decision the run started with; a jev_modify changes them
    decision: null,
    with_episode: null, // the episode's outcome when the episode ended while the run was still going
    // a real-time hand run's last reason for not taking the target (an abandoned attempt, a pass without one, the target
    // out of sight; rtReason) until its next launch, and whether an attempt is under way (from a launch to its end)
    last_reason: null,
    rt_attempt: false,
  };
  s.engine.run = run;
  s.memory.active = run.motion;
  s.memory.also = [];
  return run;
}

/** The run that is still going (optionally: of `motion`), or null. */
function liveRun(s, motion = null) {
  const r = s.engine.run;
  if (!r || r.ended) return null;
  if (motion != null && r.motion != null && !runHas(r, motion)) return null;
  return r;
}

/** Whether a run is the run of `motion`: its own, or one of the real-time tracks that joined it (a gaze track beside the
 * hands; the hands that joined a gaze track, whose motion then names the run). */
function runHas(run, motion) {
  return run.motion === motion || (Array.isArray(run.motions) && run.motions.includes(motion));
}

function anchor(run, phase, t, tw) {
  const p = num(phase);
  if (p == null) return;
  // a real-time motion whose phase falls back by more than half a cycle has wrapped from its end to its start: it loops
  if (run.rt_plan && !run.loop && p < run.phase - LOOP_WRAP) run.loop = true;
  run.phase = clamp(p, 0, 1);
  run.anchor_phase = run.phase;
  run.anchor_t = num(t, run.anchor_t);
  run.anchor_t_wall = tw ?? run.anchor_t_wall;
}

function pushMark(list, phase) {
  const p = num(phase);
  if (p == null) return;
  list.push(clamp(p, 0, 1));
  if (list.length > MARKS_MAX) list.shift();
}

// ---- the menu ----------------------------------------------------------------------------------------------------------
function normCandidate(c) {
  return {
    motion: String(c.motion),
    feasible: c.feasible === true ? true : c.feasible === false ? false : null,
    reason: c.reason ?? null,
    decision: trimDecision(c.decision),
    confidence: num(c.confidence),
    duration_s: num(c.duration_s),
    deviation_needed: num(c.deviation_needed),
    success_rate: num(c.success_rate),
  };
}

function setMenu(s, intent, target, candidates, tw) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => isObj(c) && c.motion != null).map(normCandidate);
  s.jev.menu = { intent: intent ?? null, target: target ?? null, candidates: list, building: false, t_wall: tw };
  s.memory.candidates = list.map((c) => c.motion);
}

function menuText(menu) {
  const n = menu.candidates.length;
  const fit = menu.candidates.filter((c) => c.feasible).map((c) => c.motion);
  return `menu: ${fit.length} of ${n} fit${fit.length ? ` · ${fit.slice(0, 5).join(', ')}${fit.length > 5 ? ', …' : ''}` : ''}`;
}

/** A scene change's kind in words: "moved" -> "object moved", "off_goal" -> "off goal" (a pause's cause, a hold's). */
export function changeWords(kind) {
  if (kind == null || kind === '') return 'the scene changed';
  return KIND_WORDS[kind] || String(kind).replace(/_/g, ' ');
}

/** A refusal reason in plain words: "out_of_reach" -> "out of reach", "collision_predicted" -> "collision". */
function reasonWords(reason) {
  if (reason == null || reason === '') return 'refused';
  if (reason === 'collision_predicted') return 'collision';
  return String(reason).replace(/_/g, ' ');
}

/**
 * The menu in one line (section 11.4): `judged 14 candidates for “reach” on obj:cylinder_0 · 2 fit · 3 undecided ·
 * 9 out of reach`. Fit means feasible; undecided means the decider could not choose confidently (an insight settles
 * it); the rest are counted by their reason, the largest group first.
 */
export function menuSummary(menu) {
  if (!menu) return '';
  const list = menu.candidates || [];
  let fit = 0;
  let undecided = 0;
  const rest = new Map();
  for (const c of list) {
    if (c.feasible === true) fit += 1;
    else if (c.reason === 'undecided') undecided += 1;
    else {
      const w = c.feasible === false ? reasonWords(c.reason) : 'not judged';
      rest.set(w, (rest.get(w) || 0) + 1);
    }
  }
  const groups = [...rest.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w, n]) => ` · ${n} ${w}`);
  const n = list.length;
  const what = `${menu.intent ? ` for “${menu.intent}”` : ''}${menu.target ? ` on ${menu.target}` : ''}`;
  return `judged ${n} candidate${n === 1 ? '' : 's'}${what} · ${fit} fit${undecided ? ` · ${undecided} undecided` : ''}${groups.join('')}`;
}

// ---- step wording (section 11.2) ------------------------------------------------------------------------------------------
/** A field with its label for a step: "elevation 0°". The words of the set-down point and of the level speak for
 * themselves ("centre", "level"), as in the feed. */
function stepField(f, value = f.value) {
  return f.key === 'point' || f.key === 'level' ? value : `${STEP_LABEL[f.label] || f.label} ${value}`;
}

/** A decision summed up for a step: "side grasp · pad 2.4 cm · elevation 0° · yaw 0° · conf 0.66". */
function decisionGist(decision) {
  const fields = decisionFields(decision);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const bits = [];
  if (byKey.face) bits.push(`${byKey.face.value} grasp`);
  for (const k of byKey.face || byKey.pinch ? GIST_GRASP : GIST_PLACE) if (byKey[k]) bits.push(stepField(byKey[k]));
  const c = decisionConfidence(decision);
  if (c != null) bits.push(`conf ${c.toFixed(2)}`);
  return bits.join(' · ');
}

/** The fields whose values differ between two decisions: "elevation 0° → 30° · lift 0 cm → 3 cm". */
function decisionDiff(prev, next) {
  if (!isObj(prev) || !isObj(next)) return '';
  const before = new Map(decisionFields(prev).map((f) => [f.key, f.value]));
  return decisionFields(next)
    .filter((f) => before.has(f.key) && before.get(f.key) !== f.value)
    .map((f) => stepField(f, `${before.get(f.key)} → ${f.value}`))
    .join(' · ');
}

/** The dimensions a spliced decision changed, in the words of a re-decision's step: "elevation 30° → 45° · yaw 0° → 15°".
 * The change record holds only the dimensions the engine compared, and values that came out equal are left out. A
 * dimension the decision card does not show (the close policy, the waist) is named only when nothing the card shows
 * changed, so the step never ends without its cause. */
function changeDiff(change) {
  const from = isObj(change.from) ? change.from : {};
  const to = isObj(change.to) ? change.to : {};
  const declared = (o) => ({ ...o, dimensions: Object.keys(o) });
  const shown = decisionDiff(declared(from), declared(to));
  if (shown) return shown;
  const words = (v) => (v == null ? '–' : String(v).replace(/_/g, ' '));
  return Object.keys(to).filter((k) => JSON.stringify(from[k]) !== JSON.stringify(to[k]))
    .map((k) => `${k.replace(/_/g, ' ')} ${words(from[k])} → ${words(to[k])}`).join(' · ');
}

/** The step a spliced decision makes: who changed it, how soon it ran in the motion, what changed ("watch changed the
 * decision → spliced in 0.59 s · elevation 30° → 45° · yaw 0° → 15°"; a jev_modify's reads "LLM changed the decision"). */
function spliceText(r) {
  const c = r.change;
  const who = c.source === 'watch' ? 'watch' : c.source === 'modify' ? 'LLM' : null;
  const lat = num(r.splice_latency_s);
  const diff = changeDiff(c);
  return `${who ? `${who} changed the decision` : 'the decision changed'} → spliced${lat != null ? ` in ${lat.toFixed(2)} s` : ''}`
    + `${diff ? ` · ${diff}` : ''}`;
}

/** The step any other installed re-edit makes: a moved object's follow ("object moved 4.8 cm → re-edited at phase
 * 0.31"), or a re-edit named by its change ("body moved → re-edited", "off goal → re-edited"). */
function reeditText(r, kind) {
  if (kind) return `${changeWords(kind)} → re-edited`;
  const moved = num(r.object_moved_m);
  return `${moved != null ? `object moved ${fmtCm(moved)} → ` : ''}re-edited at phase ${fmtP(r.phase)}`;
}

/** The first clause of a diagnostic sentence (before a parenthesis, a colon or a semicolon): the step names the cause,
 * the feed and the pill's title keep the whole advice. */
function firstClause(text) {
  const s = String(text ?? '').trim();
  const cut = [' (', ': ', '; ', ' — '].map((m) => s.indexOf(m)).filter((i) => i > 0);
  return cut.length ? s.slice(0, Math.min(...cut)) : s;
}

/** The step a `plan` record makes: what JEV gave the engine. `anchor` is the command's motion (named only when the
 * edited motion is another one). */
function planText(r, anchor) {
  const motion = r.motion ?? 'the motion';
  if (r.channel === 'hand') {
    const D = num(r.D);
    const dur = num(r.duration_s);
    return `edited${anchor && r.motion === anchor ? '' : ` ${motion}`} to the scene${D != null ? ` · D ${D.toFixed(2)}` : ''}`
      + `${dur != null ? ` · ${dur.toFixed(1)} s` : ''} → handed to the engine`;
  }
  if (r.channel === 'gaze') return `aimed ${motion} → handed to the engine`;
  const g = Array.isArray(r.goal) ? r.goal.map((v) => num(v, 0)) : [];
  const moves = [];
  if (Math.abs(g[0] ?? 0) >= 0.005) moves.push(`dx ${g[0].toFixed(2)} m`);
  if (Math.abs(g[1] ?? 0) >= 0.005) moves.push(`dy ${g[1].toFixed(2)} m`);
  if (Math.abs(g[2] ?? 0) >= 0.0087) moves.push(`turn ${Math.round((g[2] * 180) / Math.PI)}°`);
  return `planned ${motion}${moves.length ? ` · ${moves.join(' · ')}` : ''} → handed to the engine`;
}

/** The landed re-decision a row of the same engine tick answers (the same motion, the same sim time), or null. */
function landingOf(j, r) {
  const L = j.landing;
  const t = num(r.t);
  if (!L || t == null || L.t == null || Math.abs(t - L.t) > SAME_TICK_S) return null;
  return L.motion == null || r.motion == null || L.motion === r.motion ? L : null;
}

/** The landed re-decision's outcome, told by a row of its tick: "re-decided in 2.4 s · held 2.8 s → re-edited". */
function settleLanding(s, L, outcome) {
  const step = s.jev.steps.find((x) => x.id === L.id);
  if (step) step.text = `${L.text} → ${outcome}`;
  s.jev.landing = null;
}

/**
 * The engine's own re-decision landed (asked in a job; its trace is written when the answer lands, nothing when it is
 * asked). The step reads how long the decider took and how long the playhead held for it ("re-decided in 1.9 s · held
 * 2.4 s", or "while the motion played on" when the plan went on); its outcome comes with the rows of the same tick (a
 * re-edit, a pause) and is added to the step then. An answer that landed once the grasp had begun is not applied. A
 * hold ends here: the playhead plays on from where it stood.
 */
function landingStep(s, r, d, tw, t) {
  const j = s.jev;
  const run = liveRun(s, r.motion);
  if (run && run.held) {
    run.held = null;
    anchor(run, run.phase, t, tw);
  }
  const lat = num(r.redecision_latency_s);
  const held = num(r.held_s, 0);
  const text = `re-decided${lat != null ? ` in ${lat.toFixed(1)} s` : ''}`
    + `${held > 0 ? ` · held ${held.toFixed(1)} s` : ' while the motion played on'}`;
  if (r.dropped === 'late') {
    addStep(s, 'redecision', `${text} → not applied (the grasp had begun)`, tw, t, 'warn');
    j.landing = null;
    return;
  }
  addStep(s, 'redecision', text, tw, t, 'warn', { decision: d });
  j.landing = { id: s.step_seq, motion: r.motion ?? null, t, text };
}

/**
 * A changed decision spliced into the running motion (the watch's or a jev_modify's, re-edited from the hand while the
 * run goes on). It is a step of its own with a mark of its own on the phase bar, and the decision card takes its values
 * (kind `splice`: the fields it changed glow).
 */
function spliceStep(s, r, run, tw, t) {
  const j = s.jev;
  const prev = j.decision;
  const same = !!prev && prev.motion === r.motion;
  const decision = trimDecision(r.decision);
  const named = isObj(r.decision) && r.decision.decider ? (r.decision.decider === 'rules' ? 'rules' : 'model') : null;
  const d = decision ? {
    motion: r.motion ?? null, arm: same ? prev.arm : (run ? run.arm : null), object_ref: r.target ?? (same ? prev.object_ref : null),
    decision, decider: named ?? (same ? prev.decider : 'rules'), model_name: modelNameOf(r) ?? (same ? prev.model_name ?? null : null),
    context: r.change.source ?? null, kind: 'splice',
    change: r.change, n_reachable: null, n_probed: null, insight: same ? prev.insight : null, t_wall: tw,
  } : null;
  if (d) j.decision = d;
  j.splices += 1;
  const text = spliceText(r);
  if (run) {
    run.splice_marks.push({ phase: clamp(num(r.phase, run.phase), 0, 1), text });
    if (run.splice_marks.length > MARKS_MAX) run.splice_marks.shift();
    anchor(run, r.entry_s ?? r.phase, t, tw);
  }
  pulse(s, 'jev', 'engine', 'spliced', tw);
  const lat = num(r.splice_latency_s);
  const diff = changeDiff(r.change);
  feed(s, 'jev', `splices a changed decision into ${r.motion ?? ''} at phase ${fmtP(r.phase)} (${r.change.source ?? '?'}`
    + `${lat != null ? `, ${lat.toFixed(2)} s` : ''})${diff ? ` · ${diff}` : ''}`, tw, t);
  addStep(s, 'splice', text, tw, t, 'warn', d ? { decision: d } : null);
}

/** The refusal step: "refused · collision_predicted · the head is turned into the arm's way". */
function refusalStep(s, refusal, tw, t) {
  const why = refusal.why ? firstClause(refusal.why) : '';
  addStep(s, 'refusal', `refused · ${refusal.reason}${why ? ` · ${why}` : ''}`, tw, t, 'fail', { refusal });
}

/** The head moved at `tw` (a gaze run ended, `look_at` or `set_head` answered): an older camera image is stale. */
function headMoved(s, tw) {
  const img = s.llm.image;
  if (img && tw != null && img.t_wall != null && tw > img.t_wall) img.stale = true;
}

/** The latest decision of `motion` among the current command's steps (the one a re-decision changes), or null. */
function stepDecisionOf(j, motion) {
  for (let i = j.steps.length - 1; i >= 0; i--) {
    const d = j.steps[i].decision;
    if (d && d.motion === motion) return d;
  }
  return null;
}

/**
 * The step a decision record makes: the command's own motion decided ("decided · side grasp · …"), another motion
 * of the command decided after the first could not run ("fell back to …"), or a decision taken again, naming the
 * fields that changed from the previous decision of the same motion ("collision predicted → re-decided · elevation
 * 0° → 30° · conf 0.17"; the change's kind and "same values" when no value changed). `d` is the new card snapshot,
 * `prev` the one it replaces.
 */
function decisionStep(s, d, prev, tw, t) {
  const j = s.jev;
  const conf = decisionConfidence(d.decision);
  const confText = conf != null ? ` · conf ${conf.toFixed(2)}` : '';
  if (d.kind === 'decision' && d.context === 'modify') {
    // a real-time motion decided again from a jev_modify's insight: the values it changed (the card takes them)
    const before = prev && prev.motion === d.motion ? prev : stepDecisionOf(j, d.motion);
    const diff = decisionDiff(before && before.decision, d.decision);
    addStep(s, 'modify', `LLM changed the decision · ${diff || 'same values'}`, tw, t, 'warn', { decision: d });
    return;
  }
  if (d.kind === 'redecision') {
    const before = prev && prev.motion === d.motion ? prev : (stepDecisionOf(j, d.motion) ?? prev);
    const diff = decisionDiff(before && before.decision, d.decision);
    const kind = d.change && d.change.kind ? String(d.change.kind) : null;
    const cause = kind ? (CHANGE_WORDS[kind] || kind.replace(/_/g, ' ')) : null;
    const what = diff ? ` · ${diff}` : before ? ' · same values' : '';
    addStep(s, 'redecision', `${cause ? `${cause} → ` : ''}re-decided${what}${confText}`, tw, t, 'warn', { decision: d });
    return;
  }
  const anchor = j.command ? j.command.motion : null;
  if (d.context === 'execute' && anchor != null && d.motion != null && d.motion !== anchor) {
    addStep(s, 'fallback', `fell back to ${d.motion} · decided${conf != null ? ` conf ${conf.toFixed(2)}` : ''}`, tw, t, null,
      { decision: d });
    return;
  }
  const gist = decisionGist(d.decision);
  addStep(s, 'decision', `decided${gist ? ` · ${gist}` : ''}`, tw, t, null, { decision: d });
}

/**
 * A jev_modify on a running real-time motion (a new route for the maze's ball, a quicker pace from its insight): each
 * binding it changes is a step ("LLM changed the route → B2 … A5 (9)"), an insight alone one step too, and the LLM
 * block's command takes the new bindings and insight. The decision record that follows is a step of its own
 * (`decisionStep`). A modify of any other run is the engine's re-decision, as before.
 */
function modifyRunning(s, args, tw, t) {
  const run = liveRun(s);
  if (!run || !run.rt_plan) return;
  const prev = run.choice && run.choice.motion === run.motion ? run.choice
    : s.llm.choice && s.llm.choice.motion === run.motion ? s.llm.choice : null;
  const before = prev && isObj(prev.bindings) ? prev.bindings : {};
  const asked = isObj(args.bindings) ? args.bindings : {};
  const changed = Object.entries(asked).filter(([k, v]) => v != null && JSON.stringify(before[k]) !== JSON.stringify(v));
  for (const [k, v] of changed) {
    addStep(s, 'modify', `LLM changed ${k === 'path' ? 'the route' : `the ${k.replace(/_/g, ' ')}`} → ${shortBinding(v)}`, tw, t, 'warn');
  }
  const insight = typeof args.insight === 'string' && args.insight.trim() ? args.insight.trim() : null;
  if (!changed.length && insight) addStep(s, 'modify', 'LLM gave the running motion an insight', tw, t, 'warn');
  const next = { ...(prev || { motion: run.motion, allowed: [], wait: null }), motion: run.motion,
    bindings: { ...before, ...asked }, insight: insight ?? (prev ? prev.insight : null), modified: true, t_wall: tw };
  s.llm.choice = next;
  run.choice = next;
}

// ---- feed wording (report.py merged_rows, shorter) ------------------------------------------------------------------------
function callText(tool, a) {
  switch (tool) {
    case 'get_camera_image': return `looks through the ${a.camera || 'head'} camera`;
    case 'detect_objects': return `finds the objects in the image${a.method ? ` (${a.method})` : ''}`;
    case 'get_depth_at': {
      const n = Array.isArray(a.pixels) ? a.pixels.length : 1;
      return `measures depth at ${n} pixel${n === 1 ? '' : 's'}`;
    }
    case 'get_robot_state': return 'reads the robot state';
    case 'get_contacts': return 'checks what the hands touch';
    case 'get_task_status': return 'asks whether the task is done';
    case 'jev_memory': return 'lists the motion memory';
    case 'jev_query_options':
      return `asks JEV which motions fit “${a.intent ?? '?'}”${a.target ? ` on ${a.target}` : ''}`;
    case 'jev_execute': {
      const c = parseChoice(a, null);
      const bind = bindingsText(c.bindings);
      return `chooses ${c.motion ?? '?'}${c.allowed.length ? ` (else ${c.allowed.join(', ')})` : ''}`
        + `${bind ? ` · ${bind}` : ''}${c.insight ? ` · “${short(c.insight, 140)}”` : ''}`;
    }
    case 'jev_modify': return `modifies the running motion${kv(a) ? ` · ${kv(a)}` : ''}`;
    case 'jev_stop': return 'stops the motion';
    case 'jev_wait_turn': return `waits for a turn${num(a.max_s) != null ? ` (≤ ${num(a.max_s)} s)` : ''}`;
    case 'jev_declare_target': return `declares the target${kv(a) ? ` · ${kv(a)}` : ''}`;
    default: return `${tool}${kv(a) ? ` ${kv(a)}` : ''}`;
  }
}

function parseChoice(a, tw) {
  const m = a.motion;
  const motion = typeof m === 'string' ? m : isObj(m) ? (m.anchor ?? m.id ?? null) : (a.item_id ?? null);
  const allowed = (isObj(m) && Array.isArray(m.allowed) ? m.allowed : Array.isArray(a.allowed) ? a.allowed : []).map(String);
  return {
    motion: motion == null ? null : String(motion),
    allowed,
    bindings: isObj(a.bindings) ? a.bindings : {},
    insight: typeof a.insight === 'string' && a.insight.trim() ? a.insight.trim() : null,
    wait: typeof a.wait === 'boolean' ? a.wait : null,
    t_wall: tw,
  };
}

function deciderOf(row) {
  if (isObj(row.model) && num(row.model.requests, 0) > 0) return 'model';
  // a real-time motion's decision names its decider itself (`decider: decisions`: the model decider, asked one choice
  // per dimension; its exchange is in the decision's evidence, not in a `model` record)
  const named = row.decider ?? (isObj(row.decision) ? row.decision.decider : null);
  return row.rt === true && (named === 'decisions' || named === 'model') ? 'model' : 'rules';
}

/** The model that decided, by name ("gpt-6-luna"): the row's or the decision's `model`, else the name its reason opens
 * with ("model gpt-6-luna: cell ..."); null for the rules or when no name is recorded. */
export function modelNameOf(row) {
  if (!isObj(row)) return null;
  const d = isObj(row.decision) ? row.decision : {};
  for (const v of [row.model, isObj(row.model) ? row.model.name : null, d.model]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const m = /^model ([^\s:]+):/.exec(typeof d.reason === 'string' ? d.reason : '');
  return m ? m[1] : null;
}

/**
 * A watch check's verdict in words, from the entry's flags (never from the tail of its `why`, which is the decider's
 * reasoning): "decision stands", "→ spliced in 0.59 s", "change refused (out of reach)", "budget spent" (the command's
 * changed decisions are spent), "held" (it landed while the playhead held for the engine's own re-decision), "not
 * applied (the grasp had begun)", "no answer" (the check failed), else "carry on" / "intervened".
 */
export function watchVerdict(e) {
  if (!isObj(e)) return 'carry on';
  if (e.error != null && num(e.p) == null) return 'no answer';
  if (e.held) return 'held';
  if (e.late) return `not applied (${typeof e.late === 'string' ? e.late : 'the grasp had begun'})`;
  if (e.spliced) {
    const lat = num(e.splice_latency_s);
    return `→ spliced${lat != null ? ` in ${lat.toFixed(2)} s` : ''}`;
  }
  if (e.refused === 'chain_exhausted') return 'budget spent';
  if (e.refused) return `change refused (${reasonWords(e.refused)})`;
  if (e.stands || e.kept) return 'decision stands';
  return e.intervene ? 'intervened' : 'carry on';
}

/** A line and its watch verdict: "check 5 · p 0.61 · decision stands", a splice without the dot ("p 0.61 → spliced"). */
export function withVerdict(head, verdict) {
  return String(verdict).startsWith('→') ? `${head} ${verdict}` : `${head} · ${verdict}`;
}

// ---- the task's progress: the time bar's pills (section 8.1) -------------------------------------------------------------
/**
 * The component counters at the end of a `papers` task's HUD line, or null for a line without them. While the episode
 * runs, `PaperTask.hud_line` appends ` | ` and every component goal as `<key> <value>/<at_least>` (the value `-` before
 * its first evaluation): "waiting (goal_0) | tosses 3/5, solved -/1" -> `[{key: 'tosses', text: '3', value: 3,
 * at_text: '5', at_least: 5}, {key: 'solved', text: '-', value: null, at_text: '1', at_least: 1}]`.
 */
export function hudCounters(line) {
  const s = typeof line === 'string' ? line : '';
  const i = s.indexOf(' | ');
  if (i < 0) return null;
  const out = [];
  for (const part of s.slice(i + 3).split(', ')) {
    const m = /^(.+) (\S+)\/(\S+)$/.exec(part.trim());
    const at = m ? num(m[3]) : null;
    if (at == null) continue;
    out.push({ key: m[1], text: m[2], value: num(m[2]), at_text: m[3], at_least: at });
  }
  return out.length ? out : null;
}

/** The predicate names of a row, appended in their first-seen order (a pill, once there, keeps its place). */
function notePredKeys(e, predicates) {
  if (!isObj(predicates)) return;
  for (const k of Object.keys(predicates)) if (!e.pred_keys.includes(k)) e.pred_keys.push(k);
}

/** The counters of a HUD line into the episode, by key (a line without them, the verdict's, keeps the last values). */
function noteCounters(e, list) {
  if (!Array.isArray(list)) return;
  const next = e.counters.slice();
  for (const c of list) {
    const i = next.findIndex((x) => x.key === c.key);
    if (i >= 0) next[i] = { ...c };
    else next.push({ ...c });
  }
  e.counters = next;
}

/**
 * The pills a replay knows from the start: every predicate name of the recording's `task/status` and
 * `task/episode_end` rows and the counters of its HUD lines (their values unknown yet), as a `task_shape` pseudo-row,
 * or null when the recording has none. Without it a pill set would appear only with the first status row, which a
 * recording often has late (the task publishes a status when something changes).
 */
export function taskShape(rows) {
  const e = { pred_keys: [], counters: [] };
  for (const r of rows || []) {
    if (!isObj(r) || (r.kind !== 'task/status' && r.kind !== 'task/episode_end')) continue;
    notePredKeys(e, r.predicates);
    for (const c of hudCounters(r.hud_line) || []) {
      // before the first status row nothing has been counted yet: the pill starts at 0
      if (!e.counters.some((x) => x.key === c.key)) e.counters.push({ ...c, text: '0', value: 0 });
    }
  }
  return e.pred_keys.length || e.counters.length ? { kind: 'task_shape', keys: e.pred_keys, counters: e.counters } : null;
}

function onTaskShape(s, r) {
  const e = s.episode;
  if (Array.isArray(r.keys)) notePredKeys(e, Object.fromEntries(r.keys.map((k) => [String(k), false])));
  for (const c of Array.isArray(r.counters) ? r.counters : []) {
    if (isObj(c) && c.key != null && !e.counters.some((x) => x.key === c.key)) e.counters.push({ ...c });
  }
}

/** Whether the episode's task is a `papers` one (its rows say so, or its scene is one of the papers presets, which all
 * run that task): before its first status row such a task shows no pills rather than the classic four. */
function isPapersTask(e) {
  return e.task === 'papers' || /^papers\//.test(String(e.scene ?? ''));
}

function predPill(key, preds, label = key, what = key) {
  const on = preds[key] === true;
  return { key, label, kind: 'pred', on, title: `${what}: ${on ? 'holds' : 'does not hold'}` };
}

/** A `papers` goal kind in a word, for its pill (a component goal is a counter instead). */
const GOAL_WORDS = { lift: 'lifted', place: 'placed', robot_in_region: 'in region', region_clear: 'clear' };

/** A scene goal (the scene dict's `task.goals`) in words for a title: "goal_0 · lift item_07", "goal_1 · place block on
 * plate_0". */
function goalWhat(g) {
  const on = g.region != null ? (g.kind === 'place' ? ` on ${g.region}` : ` ${g.region}`) : '';
  return `${g.key} · ${String(g.kind ?? 'goal').replace(/_/g, ' ')}${g.object != null ? ` ${g.object}` : ''}${on}`;
}

/**
 * The pills of a `papers` task whose goals the scene dict describes (`task.goals`, the preset's, in its order): a
 * component goal is the counter of its status key (`returned 4/10`; 0 until the HUD line gives a value), any other
 * goal a pill named by its kind ("lifted", "placed", "in region", "clear"; with its object or region when two goals
 * would read the same), then `hold`. The goals stand from the start, before any status row.
 */
function describedPills(e, goals, preds, counters) {
  const words = goals.map((g) => GOAL_WORDS[g.kind] ?? String(g.kind ?? g.key).replace(/_/g, ' '));
  const pills = goals.filter((g) => !chipReplaces(e, g)).map((g) => {
    const i = goals.indexOf(g);
    if (g.kind === 'component') {
      const at = num(g.at_least, 1);
      const atText = Number.isInteger(at) ? String(at) : String(+at.toPrecision(6));
      const c = counters.find((x) => x.key === g.status_key)
        || { key: String(g.status_key ?? g.component ?? 'count'), text: '0', value: 0, at_text: atText, at_least: at };
      return counterPill(g.key, c, preds);
    }
    const twin = words.some((w, k) => k !== i && w === words[i]);
    const label = twin ? `${words[i]} ${g.object ?? g.region ?? i}` : words[i];
    return predPill(g.key, preds, label, goalWhat(g));
  });
  // a counter the goals do not name (it should not happen) is a pill of its own
  for (const c of counters) {
    if (!goals.some((g) => g.kind === 'component' && g.status_key === c.key)) pills.push(counterPill(null, c, preds));
  }
  pills.push(predPill(HOLD_KEY, preds));
  return pills;
}

/** Whether the score chip (model/score.js) shows what a goal's pill would: a fixed-protocol scene's goal on its judge's
 * `passed` flag (`passed 0/1`, the chip's verdict) or a component goal on the scorecard's own primary (`aloft 5.0/60 s`).
 * Only an episode with a scorecard has a chip; every other keeps its pills. */
function chipReplaces(e, g) {
  if (!g || g.kind !== 'component' || (!e.score_head && !e.score_card)) return false;
  const primary = e.score_head ? e.score_head.primary : isObj(e.score_card.primary) ? e.score_card.primary : {};
  return g.status_key === 'passed' || (primary.key != null && g.status_key === primary.key);
}

/** A component goal's counter pill: `taken 2/3`, filled to 2/3; on once the goal holds (its own predicate when the pill
 * stands for a goal, else the count reaching `at_least`). `width`: the characters its widest label takes (the count at
 * `at_least`), so the pill keeps its size while the count grows. */
function counterPill(goal, c, preds) {
  const v = c.value;
  const at = c.at_least;
  const on = goal ? preds[goal] === true : v != null && v >= at;
  const frac = at > 0 ? clamp(num(v, 0) / at, 0, 1) : on ? 1 : 0;
  // a duration (a status key in seconds, `aloft_s`) reads "aloft 3.0/60 s"; a count as the HUD line writes it
  const secs = /_s$/.test(c.key);
  const name = secs ? c.key.slice(0, -2) : c.key;
  const unit = secs ? ' s' : '';
  const atText = c.at_text ?? String(at);
  const vText = secs && v != null ? v.toFixed(1) : (c.text ?? '-');
  const label = `${name} ${vText}/${atText}${unit}`;
  const widest = `${name} ${secs ? Number(at).toFixed(1) : atText}/${atText}${unit}`;
  const count = v == null ? 'not counted yet' : `${vText} of at least ${atText}${unit}`;
  return { key: goal ?? `counter:${c.key}`, label, kind: 'counter', on, frac, width: Math.max(label.length, widest.length),
    title: `${goal ? `${goal} · ` : ''}${c.key}: ${count}${on ? ' (holds)' : ''}` };
}

/**
 * The time bar's task pills, from the status rows (`[{key, label, kind: 'pred' | 'counter', on, title, frac?,
 * width?}]`). A classic task (or one the page knows nothing about yet): today's four predicates. A `papers` task: one
 * pill per goal (`goal_0` ...), then `hold`; a component goal's pill is a counter (`taken 2/3`, filled as the count
 * grows). The status row does not say which goal a counter of its HUD line belongs to: when there is one counter per
 * goal every goal is a component goal and each takes its counter (both are in the task's order); otherwise the
 * counters follow the goals as pills of their own. A task with other predicates (`grasped`, `lifted`) shows its own.
 */
export function taskPills(e) {
  const preds = isObj(e.predicates) ? e.predicates : {};
  const counters = Array.isArray(e.counters) ? e.counters : [];
  const described = Array.isArray(e.goals) ? e.goals : [];
  if (described.length) return describedPills(e, described, preds, counters);
  const keys = Array.isArray(e.pred_keys) ? e.pred_keys : [];
  const goals = keys.filter((k) => GOAL_KEY.test(k)).sort((a, b) => Number(GOAL_KEY.exec(a)[1]) - Number(GOAL_KEY.exec(b)[1]));
  if (!goals.length && !counters.length) {
    if (!keys.length) return isPapersTask(e) ? [] : CLASSIC_PREDICATES.map((k) => predPill(k, preds));
    if (keys.every((k) => CLASSIC_PREDICATES.includes(k))) return CLASSIC_PREDICATES.map((k) => predPill(k, preds));
    return keys.map((k) => predPill(k, preds));
  }
  const merged = counters.length === goals.length;
  const pills = goals.map((k, i) => (merged ? counterPill(k, counters[i], preds) : predPill(k, preds)));
  if (!merged) pills.push(...counters.map((c) => counterPill(null, c, preds)));
  for (const k of keys) if (!GOAL_KEY.test(k) && k !== HOLD_KEY) pills.push(predPill(k, preds));
  if (keys.includes(HOLD_KEY)) pills.push(predPill(HOLD_KEY, preds));
  return pills;
}

// ---- the row handlers ---------------------------------------------------------------------------------------------------
function onMeta(s, r, tw, t) {
  if (r.scene != null) s.episode.scene = String(r.scene);
  if (r.seed != null) s.episode.seed = r.seed;
  if (r.clock_mode != null) s.episode.clock_mode = String(r.clock_mode);
  feed(s, 'run', `simulator up · ${r.scene ?? '?'} · seed ${r.seed ?? '?'}${r.clock_mode ? ` · ${r.clock_mode} clock` : ''}`, tw, t);
}

function onEpisodeStart(s, r, tw, t) {
  const e = s.episode;
  e.n = r.episode ?? e.n;
  if (r.seed != null) e.seed = r.seed;
  e.task = r.task ?? e.task;
  e.t_start = num(r.t, t);
  e.status = 'running';
  e.outcome = null;
  e.message = '';
  e.closed = false;
  e.status_key = null;
  // a live run's card belongs to the episode that ended (a replay's bundle card is the episode's own and stays)
  if (!e.score_seeded) e.score_card = null;
  e.targets = [];
  e.target_passes = 0;
  e.target_taken_by = null;
  e.quiet_keys = [];
  // a new episode: what the blocks show belongs to the old one; the memory (and what it learned) carries over
  Object.assign(s.jev, { busy: null, query: null, menu: null, command: null, decision: null, n_redecisions: 0,
    refusal: null, accepted: null, watch: null, watch_dm: null, rt_pulse_tw: null, reedits: 0, splices: 0, chain: 0,
    landing: null, plan: null,
    plan_seq: s.jev.plan_seq + 1, steps: [], steps_total: 0, steps_cmd_t_wall: null, swing: null,
    swing_seq: s.jev.swing_seq + (s.jev.swing ? 1 : 0) });
  s.engine.run = null;
  s.memory.active = null;
  s.memory.also = [];
  s.memory.candidates = [];
  s.llm.choice = null;
  s.llm.turn = null;
  if (s.llm.phase === 'done') s.llm.phase = 'idle';
  feed(s, 'task', `episode ${r.episode ?? ''} starts${r.task ? ` · ${r.task}` : ''}`.replace('  ', ' '), tw, t);
}

function onTaskStatus(s, r, tw, t) {
  const e = s.episode;
  if (r.status != null) e.status = String(r.status);
  if (isObj(r.predicates)) e.predicates = { ...r.predicates };
  notePredKeys(e, r.predicates);
  noteCounters(e, hudCounters(r.hud_line));
  e.hud_line = r.hud_line ?? e.hud_line;
  e.t_elapsed = num(r.t_elapsed, e.t_elapsed);
  e.message = r.message ?? e.message;
  const key = `${r.status}|${r.hud_line}`;
  if (key !== e.status_key) {
    e.status_key = key;
    feed(s, 'task', `${r.status}${r.hud_line ? ` · ${r.hud_line}` : r.message ? ` · ${r.message}` : ''}`, tw, t);
  }
}

function onEpisodeEnd(s, r, tw, t) {
  const e = s.episode;
  e.outcome = r.status != null ? String(r.status) : 'ended';
  e.status = e.outcome;
  e.message = r.message ?? '';
  if (r.task != null) e.task = r.task;
  if (isObj(r.predicates)) e.predicates = { ...r.predicates };
  notePredKeys(e, r.predicates);
  e.t_elapsed = num(r.t_elapsed, e.t_elapsed);
  e.closed = true;
  // the judge's card comes with the episode's end (tasks/paper_task.py): a live run's only source; a replay keeps the
  // bundle's, which also carries the run's own metrics
  if (!e.score_card && isObj(r.extras) && isObj(r.extras.score)) e.score_card = r.extras.score;
  closeGap(s, tw);
  s.llm.phase = 'done';
  // a run still going when the episode ends (a looping real-time motion: the runner stops the episode at the verdict)
  // ends with it: its counts stay, and nothing reads as running any more
  const run = liveRun(s);
  if (run) {
    run.ended = true;
    run.ended_t_wall = tw;
    run.outcome = 'ended';
    run.with_episode = e.outcome;
    run.paused = false;
    run.held = null;
    s.memory.active = null;
    s.memory.also = [];
    s.jev.busy = null;
    s.jev.landing = null;
  }
  setSwing(s, null, null);
  feed(s, 'task', `episode end · ${e.outcome}${e.message ? ` — ${short(e.message, 120)}` : ''}`, tw, t,
    e.outcome === 'success' ? 'ok' : 'fail');
}

/**
 * A row that, once the episode has ended, only reports the shutdown: the engine and the scene winding down (traces,
 * events, a run's end as the server stops), a call cancelled or failing because the server stops, and the answer of the
 * LLM's last wait for a turn. They are no pipeline events of the episode (no state, no feed line, no tick); the LLM's
 * own words and calls after the verdict still are.
 */
export function shutdownRow(row) {
  if (!isObj(row)) return false;
  const kind = String(row.kind ?? '');
  if (kind.startsWith('research/') || kind.startsWith('scene/') || kind === 'motor_control/fault' || kind === 'hold') return true;
  if (kind === 'reasoning/tool_status') return row.state !== 'starting';
  // the player's client seeing the server go away ("connection closed before the tool call was answered")
  if (kind === 'player/tool_result') return row.is_error === true;
  return kind === 'lab/tool_result' && String(row.tool_id ?? '') === 'jev_wait_turn';
}

function onToolStatus(s, r, tw, t) {
  const tool = String(r.tool_id ?? '');
  const state = String(r.state ?? '');
  const args = isObj(r.arguments) ? r.arguments : {};
  if (state === 'starting') {
    const gap = closeGap(s, tw);
    if (gap != null && gap >= THINK_FEED_MIN_S) feed(s, 'llm', `thinks ${gap.toFixed(1)} s`, tw == null ? null : tw - 1e-6, null);
    const call = { id: tool, call_id: r.call_id ?? null, args, t_wall: tw };
    s.llm.calls.push(call);
    if (s.llm.calls.length > 8) s.llm.calls.shift();
    s.llm.tool = call;
    s.llm.n_calls += 1;
    setPhase(s, phaseOfTool(tool));
    onCallStart(s, tool, args, call, tw, t);
    feed(s, 'llm', callText(tool, args), tw, t);
    return;
  }
  if (state === 'error' || state === 'canceled') {
    endCall(s, r.call_id);
    if (tool.startsWith('jev_')) s.jev.busy = null;
    openGap(s, tw);
    if (!s.llm.calls.length) setPhase(s, 'thinking');
    const msg = r.error_message ? `: ${short(r.error_message, 140)}` : '';
    feed(s, tool.startsWith('jev_') ? 'jev' : 'llm', `${tool} ${state}${msg}`, tw, t);
  }
}

function endCall(s, callId) {
  const calls = s.llm.calls;
  let i = callId != null ? calls.findIndex((c) => c.call_id === callId) : -1;
  if (i < 0 && calls.length) i = 0;
  if (i >= 0) calls.splice(i, 1);
  s.llm.tool = calls.length ? calls[calls.length - 1] : null;
}

function onCallStart(s, tool, args, call, tw, t) {
  const j = s.jev;
  if (tool === 'jev_query_options') {
    const intent = args.intent ?? null;
    const target = args.target ?? args.object_id ?? null;
    j.query = { intent, target, call_id: call.call_id, t_wall: tw };
    j.menu = { intent, target, candidates: [], building: true, t_wall: tw };
    j.busy = 'menu';
    // a new question opens a new cycle: the previous command's decision, refusal, re-decisions and steps are history now
    j.decision = null;
    j.n_redecisions = 0;
    j.refusal = null;
    resetSteps(s, tw);
    s.memory.candidates = [];
    pulse(s, 'llm', 'jev', intent ? `intent · ${intent}` : 'intent', tw);
    pulse(s, 'memory', 'jev', 'candidates', tw);
  } else if (tool === 'jev_execute') {
    const c = parseChoice(args, tw);
    // the menu the LLM chose from (if the motion is on it): an undecided candidate is one the insight has to settle
    const cand = j.menu && !j.menu.building ? j.menu.candidates.find((x) => x.motion === c.motion) : null;
    const undecided = !!cand && cand.feasible === false && cand.reason === 'undecided';
    s.llm.choice = c;
    j.busy = 'deciding';
    j.command = { motion: c.motion, call_id: call.call_id, t_wall: tw, refused: false, started: false };
    j.decision = null;
    j.n_redecisions = 0;
    j.refusal = null;
    j.accepted = null;
    j.plan = null;
    j.plan_seq += 1;
    resetSteps(s, tw);
    addStep(s, 'command', `LLM chose ${c.motion ?? 'a motion'}${c.insight ? ' · with an insight' : ''}`
      + `${undecided ? ' · undecided on the menu' : ''}`, tw, t);
    pulse(s, 'llm', 'jev', `chose ${c.motion ?? 'a motion'}${c.insight ? ' · insight' : ''}`, tw);
  } else if (tool === 'jev_modify') {
    j.busy = 'deciding';
    j.command = { motion: j.command?.motion ?? s.engine.run?.motion ?? null, call_id: call.call_id, t_wall: tw,
      refused: false, started: true };
    pulse(s, 'llm', 'jev', 'modify', tw);
    modifyRunning(s, args, tw, t);
  } else if (tool === 'jev_stop') {
    pulse(s, 'llm', 'jev', 'stop', tw);
  } else if (tool === 'jev_declare_target') {
    pulse(s, 'llm', 'jev', 'target', tw);
  }
}

function onToolResult(s, r, tw, t) {
  const tool = String(r.tool_id ?? '');
  const res = isObj(r.result) ? r.result : {};
  endCall(s, r.call_id);
  let phase = 'thinking';
  switch (tool) {
    case 'get_camera_image': {
      const png = res._png;
      const b64 = isObj(png) && typeof png.b64 === 'string' && png.b64 ? png.b64 : null;
      const kind = res.kind ?? (isObj(r.arguments) ? r.arguments.kind : null) ?? 'rgb';
      if (b64 && kind !== 'depth') {
        const img = isObj(res.image) ? res.image : {};
        // `stale`: the head moved after this image was taken (section 11.5); a new image is fresh by definition
        s.llm.image = { b64, t_wall: tw, camera: res.camera ?? null, kind, width: num(img.width), height: num(img.height),
          stale: false };
      }
      if (res.success !== false) pulse(s, 'world', 'llm', 'camera image', tw);
      else feed(s, 'llm', `camera failed: ${res.reason ?? '?'}`, tw, t);
      break;
    }
    case 'detect_objects': {
      const pick = (list) => (Array.isArray(list) ? list : []).filter(isObj).map((o) => ({
        id: String(o.id ?? o.label ?? '?'), bbox: Array.isArray(o.bbox) ? o.bbox.slice(0, 4) : null, occluded: !!o.occluded,
      }));
      const objects = pick(res.objects);
      const regions = pick(res.regions);
      s.llm.detect = { objects, regions, image_size: Array.isArray(res.image_size) ? res.image_size.slice(0, 2) : null,
        camera: res.camera ?? null, t_wall: tw };
      const ids = [...objects, ...regions].map((o) => o.id);
      feed(s, 'llm', ids.length ? `sees ${ids.join(' · ')}` : 'sees nothing it can name', tw, t);
      break;
    }
    case 'jev_memory': {
      if (Array.isArray(res.items) && res.items.length && !s.memory.items.length) setItems(s, res.items);
      feed(s, 'memory', `${num(res.n_items, Array.isArray(res.items) ? res.items.length : 0)} motions in memory`, tw, t);
      break;
    }
    case 'jev_query_options': {
      const j = s.jev;
      if (j.menu && j.menu.building) {
        // no options event reached the timeline: the answer's own list is the menu
        setMenu(s, j.query?.intent ?? res.intent, j.query?.target ?? res.target, res.candidates ?? res.options, tw);
        pulse(s, 'jev', 'llm', `menu · ${j.menu.candidates.length}`, tw);
        feed(s, 'jev', menuText(j.menu), tw, t);
        addStep(s, 'menu', menuSummary(j.menu), tw, t);
      }
      j.query = null;
      j.busy = null;
      break;
    }
    case 'jev_execute': phase = onExecuteResult(s, res, tw, t); break;
    case 'jev_wait_turn': {
      const evs = (Array.isArray(res.events) ? res.events : []).filter(isObj);
      const names = evs.map((e) => `${e.event}${e.reason ? `:${e.reason}` : ''}`);
      s.llm.turn = { n: res.turn ?? null, reason: res.reason ?? null, events: names,
        advice: (Array.isArray(res.advice) ? res.advice : []).slice(0, 3).map(String), waited_s: num(res.waited_s), t_wall: tw };
      const waited = num(res.waited_s);
      const run = s.engine.run;
      if (res.reason === 'progress' && !evs.length) {
        // a looping real-time run reports how it goes every so often: a quiet line with its counts, and the LLM reads it
        phase = 'reading';
        const counts = run && !run.ended ? rtCountText(run) : '';
        feed(s, 'engine', `progress report${counts ? ` · ${counts}` : ''}`, tw, t);
        break;
      }
      // a real-time pause that did not say what happened gets the turn's advice
      if (run && run.rt_plan && run.paused && run.pause && !run.pause.full && s.llm.turn.advice.length) {
        run.pause.full = s.llm.turn.advice[0];
        run.pause.text = firstSentence(run.pause.full);
      }
      phase = evs.length ? 'deciding' : 'thinking';
      feed(s, 'engine', `turn${res.turn != null ? ` ${res.turn}` : ''} · ${names.join(', ') || res.reason || 'no events'}${waited != null ? ` · waited ${waited.toFixed(1)} s` : ''}`, tw, t);
      break;
    }
    case 'jev_modify': {
      // the modify is answered (applied or refused): JEV is no longer deciding, it watches the run again
      s.jev.busy = null;
      if (res.success === false) {
        feed(s, 'llm', `jev_modify failed${res.reason ? `: ${res.reason}` : ''}${res.message ? ` — ${short(res.message, 100)}` : ''}`, tw, t);
      }
      break;
    }
    case 'look_at':
    case 'set_head': {
      // the head turned after the LLM's last image: what the inset shows is no longer what the camera sees
      headMoved(s, tw);
      if (res.success === false) {
        feed(s, 'llm', `${tool} failed${res.reason ? `: ${res.reason}` : ''}${res.message ? ` — ${short(res.message, 100)}` : ''}`, tw, t);
      }
      break;
    }
    default: {
      if (res.success === false) {
        feed(s, 'llm', `${tool} failed${res.reason ? `: ${res.reason}` : ''}${res.message ? ` — ${short(res.message, 100)}` : ''}`, tw, t);
      }
    }
  }
  openGap(s, tw);
  if (!s.llm.calls.length) setPhase(s, phase);
}

function onExecuteResult(s, res, tw, t) {
  const j = s.jev;
  const ex = isObj(res.execute) ? res.execute : res;
  const accepted = ex.accepted === true || res.accepted === true;
  const motion = ex.motion ?? res.motion ?? j.command?.motion ?? null;
  j.busy = null;
  if (!accepted) {
    const reason = ex.reason ?? res.reason ?? 'refused';
    const diag = isObj(ex.diagnostics) ? ex.diagnostics : {};
    if (!j.command || !j.command.refused) {
      // no refusal event reached the timeline (older recordings): the answer's own reason is the refusal
      j.refusal = { reason, why: diag.why ?? diag.message ?? null, motion, t_wall: tw };
      pulse(s, 'jev', 'llm', `refused: ${reason}`, tw);
      feed(s, 'jev', `refused ${motion ?? ''}: ${reason}${diag.why ? ` — ${short(diag.why, 120)}` : ''}`, tw, t, 'fail');
      refusalStep(s, j.refusal, tw, t);
    }
    if (j.command) j.command.refused = true;
    // a command refused beside a real-time run that goes on (a gaze track it could not bind) took nothing from it: the
    // overlays get the run's hands back, which the command's start had cleared
    const running = liveRun(s);
    if (!j.plan && running && running.hands_plan) {
      j.plan = running.hands_plan;
      j.plan_seq += 1;
    }
    return 'thinking';
  }
  const plan = isObj(ex.plan) ? ex.plan : {};
  const decision = trimDecision(ex.decision);
  j.accepted = { motion, t_wall: tw, duration_s: num(plan.duration_s, num(ex.duration_s)) };
  if (decision && !j.decision) {
    const by = decision.decider ?? (isObj(ex.decision) ? ex.decision.decider : null);
    j.decision = { motion, arm: ex.arm ?? null, object_ref: null, decision,
      decider: by === 'decisions' || by === 'model' ? 'model' : (by ?? null), model_name: modelNameOf({ decision: ex.decision }),
      context: 'execute', kind: 'decision', change: null, n_reachable: null, n_probed: null, insight: null, t_wall: tw };
  }
  const status = isObj(res.status) ? res.status : {};
  // a real-time track that joined the run going on (a gaze track beside the hands) starts no run of its own: the engine's
  // status names the run it joined
  const joined = ex.joined === true ? liveRun(s, status.motion ?? null) : null;
  let run = joined || liveRun(s, motion);
  const finished = s.engine.run && s.engine.run.motion === motion && s.engine.run.ended
    && (s.engine.run.ended_t_wall ?? 0) >= (j.command?.t_wall ?? 0);
  if (!run && !finished && status.running !== false) {
    // no plan record started this run (older recordings): the answer of an accepted command starts it
    run = startRun(s, { motion, channel: channelOf(s, motion), t_start: num(ex.t_start, t),
      duration_s: num(plan.duration_s, num(ex.duration_s)), entry_s: num(plan.entry_s, num(status.phase, 0)),
      source: 'result', rt: plan.kind === 'rt', loop: plan.loop === true }, tw);
    pulse(s, 'jev', 'engine', 'edited motion', tw);
  }
  // a real-time motion's answer says so (`rt`: its tracks) and may say whether it loops
  if (run && !run.ended && (plan.kind === 'rt' || isObj(ex.rt))) run.rt_plan = true;
  if (run && !run.ended && plan.loop === true) run.loop = true;
  if (j.command) j.command.started = true;
  const words = decision ? decisionWords(decision) : '';
  const dur = j.accepted.duration_s;
  feed(s, 'jev', `accepted ${motion ?? ''}${joined && joined.motion !== motion ? ` · joined ${joined.motion}` : ''}`
    + `${words ? ` · ${words}` : ''}${dur != null ? ` · ${dur.toFixed(1)} s plan` : ''}`, tw, t);
  return run && !run.ended ? 'executing' : 'thinking';
}

function onJevEvent(s, r, tw, t) {
  const ev = String(r.event ?? '');
  const j = s.jev;
  switch (ev) {
    case 'options': {
      setMenu(s, j.query?.intent ?? r.intent, j.query?.target ?? r.target, r.candidates, tw);
      pulse(s, 'jev', 'llm', `menu · ${j.menu.candidates.length}`, tw);
      feed(s, 'jev', menuText(j.menu), tw, t);
      addStep(s, 'menu', menuSummary(j.menu), tw, t);
      return;
    }
    case 'success': {
      let run = liveRun(s, r.motion);
      if (!run) run = startRun(s, { motion: r.motion, t_start: null, duration_s: num(r.duration_s), source: 'event' }, tw);
      run.outcome = 'success';
      run.phase = 1;
      j.busy = null;
      engineEvent(s, r, tw, t);
      pulse(s, 'engine', 'llm', 'success', tw);
      const seen = Array.isArray(r.seen) && r.seen.length ? ` · sees ${r.seen.join(', ')}` : '';
      feed(s, 'engine', `success · ${r.motion ?? ''}${seen}`, tw, t, 'ok');
      return;
    }
    case 'fail': {
      const diag = isObj(r.diagnostics) ? r.diagnostics : {};
      const motion = r.motion ?? diag.motion ?? j.command?.motion ?? null;
      const run = liveRun(s);
      engineEvent(s, { ...r, motion }, tw, t);
      if (j.busy !== 'deciding' && run) {
        // the running motion failed
        run.outcome = 'fail';
        run.reason = r.reason ?? null;
        pulse(s, 'engine', 'llm', `fail · ${r.reason ?? ''}`.trim(), tw);
        feed(s, 'engine', `failed · ${run.motion ?? motion ?? ''}: ${r.reason ?? '?'}${diag.why ? ` — ${short(diag.why, 100)}` : ''}`, tw, t, 'fail');
        return;
      }
      // JEV refused the command before anything moved
      j.refusal = { reason: r.reason ?? 'refused', why: diag.why ?? diag.message ?? null, motion, t_wall: tw };
      j.busy = null;
      if (j.command) j.command.refused = true;
      pulse(s, 'jev', 'llm', `refused: ${r.reason ?? ''}`, tw);
      feed(s, 'jev', `refused ${motion ?? ''}: ${r.reason ?? '?'}${diag.why ? ` — ${short(diag.why, 120)}` : ''}`, tw, t, 'fail');
      refusalStep(s, j.refusal, tw, t);
      return;
    }
    case 'stalled': {
      engineEvent(s, r, tw, t);
      feed(s, 'engine', `stalled${r.motion ? ` · ${r.motion}` : ''}${num(r.phase) != null ? ` at phase ${num(r.phase).toFixed(2)}` : ''}`, tw, t);
      return;
    }
    case 'scene_changed': {
      engineEvent(s, r, tw, t);
      const run = liveRun(s);
      const disp = num(r.displacement_m);
      const diag = isObj(r.diagnostics) ? r.diagnostics : {};
      // a lost target has no displacement (the real-time lane's `lost`: not perceived for a while)
      const what = r.change === 'lost' ? `${r.object ?? 'the target'} out of sight`
        : `${r.object ?? 'an object'}${disp != null ? ` moved ${fmtCm(disp)}` : ' moved'}`;
      // a real-time behaviour that pauses says what happened in its own words (the maze's ball blocked between two
      // cells, a target lost, no meeting): its advice, else its why, in the place of a moved distance
      const own = run && run.rt_plan && r.paused ? (diag.advice || diag.why || null) : null;
      if (r.paused && run) {
        run.paused = true;
        run.held = null;
        // `decider`: why the engine asked no decider before pausing ("not asked: the grasp stage had begun", "no answer")
        run.pause = { object: r.object ?? null, displacement_m: disp, change: r.change ?? null,
          decider: typeof diag.decider === 'string' ? diag.decider : null,
          text: own ? firstSentence(own) : diag.reason ? short(diag.reason, 120) : what, full: own ?? null, t_wall: tw };
      }
      if (r.paused) {
        pulse(s, 'engine', 'llm', own ? changeWords(r.change) : 'scene changed', tw);
        const land = landingOf(j, r);
        if (land) settleLanding(s, land, 'paused');
      }
      feed(s, 'engine', own ? `paused · ${changeWords(r.change)} — ${firstSentence(own, 140)}`
        : `scene changed · ${what}${r.paused ? ' · paused for a decision' : ''}`, tw, t);
      return;
    }
    case 'mode_change': {
      onModeChange(s, r, tw, t);
      return;
    }
    default: {
      engineEvent(s, r, tw, t);
      feed(s, 'engine', `event ${ev}${r.motion ? ` · ${r.motion}` : ''}`, tw, t);
    }
  }
}

function onModeChange(s, r, tw, t) {
  const status = String(r.status ?? '');
  s.engine.mode_change = { from: r.from_mode ?? null, to: r.to_mode ?? null, status, motion: r.motion ?? null, t_wall: tw };
  if (status === 'done' && r.to_mode) s.engine.mode = String(r.to_mode);
  feed(s, 'engine', `mode ${r.from_mode ?? '?'} → ${r.to_mode ?? '?'} · ${status || 'change'}`, tw, t);
}

function onTrace(s, r, tw, t) {
  const k = String(r.trace_kind ?? '');
  const j = s.jev;
  switch (k) {
    case 'decision':
    case 'redecision': {
      if (r.context === 'options') {
        // one candidate of the menu being decided: folded into the menu that is being built
        const m = j.menu;
        if (m && m.building && r.motion != null && !m.candidates.some((c) => c.motion === r.motion)) {
          m.candidates.push({ motion: String(r.motion), feasible: null, reason: null, decision: null, confidence: null,
            duration_s: null, deviation_needed: null, success_rate: null, pending: true });
          s.memory.candidates.push(String(r.motion));
        }
        return;
      }
      const prev = j.decision;
      const d = {
        motion: r.motion ?? null, arm: r.arm ?? null, object_ref: r.object_ref ?? null, decision: trimDecision(r.decision),
        decider: deciderOf(r), model_name: deciderOf(r) === 'model' ? modelNameOf(r) : null,
        context: r.context ?? null, kind: k, change: isObj(r.change) ? r.change : null,
        n_reachable: num(r.n_reachable), n_probed: num(r.n_probed), insight: r.insight ?? null, t_wall: tw,
      };
      // the engine's own re-decision, asked in a job, lands with this trace; one that landed once the grasp had begun
      // changed nothing, so the card keeps the decision in force
      const landed = k === 'redecision' && r.async === true;
      const late = landed && r.dropped === 'late';
      // a track that joins the real-time run going on (a gaze track: the gaze channel, or no dimensions to decide) takes
      // neither the card nor a step: the run's own decision stays, and the joined track is its plan's step
      const running = liveRun(s);
      const dims = isObj(r.decision) && Array.isArray(r.decision.dimensions) ? r.decision.dimensions : [];
      const joining = k === 'decision' && r.rt === true && r.context === 'execute' && !!running && running.rt_plan
        && r.motion != null && running.motion !== r.motion && (channelOf(s, r.motion) === 'gaze' || !dims.length);
      if (joining) {
        if (!j.decision && running.decision) j.decision = running.decision;
      } else {
        if (!late) j.decision = d;
        if (k === 'redecision') j.n_redecisions += 1;
        if (landed) landingStep(s, r, d, tw, t);
        else decisionStep(s, d, prev, tw, t);
      }
      const ch = isObj(r.change) && r.change.kind ? ` · after ${r.change.kind}` : '';
      const lat = num(r.redecision_latency_s);
      const job = landed ? ` · asked at phase ${fmtP(r.asked_phase)}${lat != null ? `, answered in ${lat.toFixed(1)} s` : ''}`
        + `${num(r.held_s, 0) > 0 ? `, held ${num(r.held_s).toFixed(1)} s` : ''}${late ? ', not applied (the grasp had begun)' : ''}` : '';
      feed(s, 'jev', `${k === 'redecision' ? 're-decides' : 'decides'} ${r.motion ?? ''}${r.object_ref ? ` on ${r.object_ref}` : ''}: `
        + `${decisionWords(r.decision) || '—'}${ch} · ${deciderOf(r)}`
        + `${deciderOf(r) === 'model' && modelNameOf(r) ? ` (${modelNameOf(r)})` : ''}${job}`, tw, t);
      return;
    }
    case 'plan': {
      // A real-time run plans each of its tracks and re-plans them several times a second. Another track's plan belongs
      // to the run on the page: a track of the same motion (another `track`, or another channel in a recording without
      // the field) or one that joined the run under a motion of its own (a `gaze` track beside the `hands`, its own
      // jev_execute). A plan that draws nothing (the gaze's) never takes the hands' place on the overlays.
      const live = liveRun(s, r.motion);
      const running = liveRun(s);
      // a real-time hand plan of a swinging target carries the lane's arc and the meeting it plans (the gaze's plans
      // never do and leave them as they are); one without a settled arc removes it
      if (r.rt === true && r.channel === 'hand') {
        const arc = swingArc(r);
        setSwing(s, r.motion, arc, arc && isObj(r.meeting) ? swingMeeting(r) : undefined, tw, t);
      }
      const rtLive = r.rt === true && !!running && running.rt_plan;
      const sameMotion = rtLive && r.motion != null && running.motion === r.motion;
      const otherTrack = rtLive && (r.track != null && running.track != null ? r.track !== running.track
        : sameMotion && r.channel !== running.channel);
      if (otherTrack && r.channel !== 'hand') {
        // the overlays keep the hands' plan (a new command cleared it: it comes back)
        const hp = running.hands_plan || null;
        if (hp && j.plan !== hp) {
          j.plan = hp;
          j.plan_seq += 1;
        }
      } else {
        j.plan = r;
        j.plan_seq += 1;
        if (r.channel === 'hand' && (otherTrack || (live && r.reedit))) (otherTrack ? running : live).hands_plan = r;
      }
      if (r.reedit) {
        // a re-edit replaces the plan the overlays show (above); the run keeps going
        if (live && num(r.duration_s) != null && !otherTrack) live.duration_s = num(r.duration_s);
        if (live && r.loop === true && !otherTrack) live.loop = true;
        return;
      }
      if (otherTrack) {
        if (r.motion != null && !running.motions.includes(r.motion)) running.motions.push(r.motion);
        const handsJoin = r.channel === 'hand' && running.channel !== 'hand' && !sameMotion;
        if (handsJoin) {
          // the hands joined a gaze track that went first: the run line names the hands' motion, the gaze joined it
          if (!running.joined.includes(running.channel)) running.joined.push(running.channel);
        } else if (r.channel !== running.channel && !running.joined.includes(r.channel)) running.joined.push(r.channel);
        const verb = r.channel === 'gaze' ? 'aims' : 'plans';
        if (sameMotion) {
          feed(s, 'jev', `${verb} ${r.motion} beside its ${running.channel ?? 'other'} track`, tw, t);
        } else {
          // its own command (the steps began with it): it joined the run that goes on, which keeps its decision on the
          // card; the memory strip shows both motions running, the card what the joined track is bound to
          if (!s.memory.also.includes(r.motion)) s.memory.also.push(r.motion);
          const c = s.llm.choice && s.llm.choice.motion === r.motion ? s.llm.choice : null;
          if (c && bindingsText(c.bindings)) running.joined_bind = bindingsText(c.bindings);
          if (!j.decision && running.decision) j.decision = running.decision;
          feed(s, 'jev', `${verb} ${r.motion ?? ''} beside ${running.motion}`, tw, t);
          addStep(s, 'plan', `${r.channel === 'gaze' ? 'aimed' : 'planned'} ${r.motion ?? 'the motion'} → joined ${running.motion}`,
            tw, t, 'ok');
          j.busy = null;
          if (j.command) j.command.started = true;
          if (s.llm.tool && CHOOSE_TOOLS.has(s.llm.tool.id)) setPhase(s, 'executing');
        }
        // the run line names the hands' track when the run has one
        if (r.channel === 'hand') {
          if (handsJoin) {
            s.memory.also = s.memory.also.filter((x) => x !== r.motion).concat(running.motion === r.motion ? [] : [running.motion]);
            running.motion = r.motion;
            s.memory.active = r.motion;
            // the gaze it joined is bound as its command said ("gaze → obj:balloon")
            running.joined_bind = running.choice && bindingsText(running.choice.bindings) ? bindingsText(running.choice.bindings) : null;
            if (j.decision && j.decision.motion === r.motion) running.decision = j.decision;
            if (s.llm.choice && s.llm.choice.motion === r.motion) running.choice = s.llm.choice;
          }
          running.channel = 'hand';
          running.arm = r.arm ?? running.arm;
          running.duration_s = num(r.duration_s, running.duration_s);
          running.hands_plan = r;
          running.track = r.track ?? running.track;
          if (r.loop === true) running.loop = true;
        }
        return;
      }
      const run = startRun(s, { motion: r.motion, channel: r.channel, arm: r.arm, object_ref: r.object_ref, t_start: t,
        duration_s: r.duration_s, entry_s: r.entry_s, source: 'plan', rt: r.rt, loop: r.loop }, tw);
      run.track = r.track ?? null;
      if (r.channel === 'hand') run.hands_plan = r;
      // the command and the decision the run was started with: a track that joins it later, or a jev_modify, starts from them
      if (s.llm.choice && s.llm.choice.motion === r.motion) run.choice = s.llm.choice;
      if (j.decision && j.decision.motion === r.motion) run.decision = j.decision;
      addStep(s, 'plan', planText(r, j.command?.motion ?? null), tw, t, 'ok');
      j.busy = null;
      if (j.command) j.command.started = true;
      if (s.llm.tool && CHOOSE_TOOLS.has(s.llm.tool.id)) setPhase(s, 'executing');
      pulse(s, 'jev', 'engine', r.channel === 'hand' ? 'edited motion' : `${r.channel ?? 'motion'} plan`, tw);
      const dur = num(r.duration_s);
      const verb = r.channel === 'hand' ? 'edits' : r.channel === 'gaze' ? 'aims' : 'plans';
      feed(s, 'jev', `${verb} ${r.motion ?? ''}${r.channel === 'hand' ? ' to the scene' : ''}${dur != null ? ` · ${dur.toFixed(1)} s` : ''}`, tw, t);
      return;
    }
    case 'watch': {
      const e = isObj(r.entry) ? r.entry : {};
      let run = liveRun(s, r.motion);
      if (!run && r.motion != null) {
        run = startRun(s, { motion: r.motion, t_start: num(e.t, t), phase: num(e.phase, 0), source: 'watch' }, tw);
      }
      let n = 1;
      const rtEntry = e.rt === true;
      if (rtEntry && (e.decider === 'decisions' || e.decider === 'model')) {
        // the model decider's check of a real-time run (once a second, in a job): a decider check as a standard run's is --
        // counted, a feed line, a step when it changed a value -- beside the lane's own report, which keeps the watch line
        if (run) {
          run.n_checks = (run.n_checks || 0) + 1;
          if (e.intervene) run.n_intervene += 1;
          run.rt_plan = true;
        }
        const k = run ? run.n_checks : 1;
        const verdict = e.intervene ? (e.why ?? 'changed') : e.held ? 'held until a key moment' : e.refused ? 'change not taken'
          : e.error != null && num(e.p) == null ? 'no answer' : 'decision stands';
        j.watch_dm = { motion: r.motion ?? null, n: k, p: num(e.p), intervene: !!e.intervene, verdict, why: e.why ?? null,
          wall_s: num(e.wall_s), t_wall: tw };
        feed(s, 'jev', withVerdict(`decider check ${k} · p ${fmtP(e.p)}`, verdict), tw, t);
        if (e.intervene) addStep(s, 'watch', `decider check · p ${fmtP(e.p)} → ${e.why ?? 'changed'}`, tw, t, 'warn');
        return;
      }
      if (run) {
        run.n_watch += 1;
        if (e.intervene) run.n_intervene += 1;
        n = run.n_watch;
        if (rtEntry) run.rt_plan = true;
        anchor(run, e.phase, num(e.t, t), tw);
        // a loop passes every phase again and again, and a real-time motion's checks are its lane's reports, not the
        // decider's: a mark would say nothing about when a check came
        if (!run.loop && !rtEntry) pushMark(run.watch_marks, e.phase);
      }
      j.watch = { motion: r.motion ?? null, p: num(e.p), intervene: !!e.intervene, applied: e.applied ?? null,
        why: e.why ?? null, verdict: watchVerdict(e), n, phase: num(e.phase), t_wall: tw };
      if (rtEntry) {
        // the real-time lane reports how its motion goes once a second (`p` 0, `stands`, and an "intervene" when the
        // target was lost, which the engine's own pause tells): the watch line shows its words, and it is neither a feed
        // line nor a step; a swinging target's report carries the lane's fit and the arc it predicts, drawn while the
        // fit is settled
        j.watch.rt = true;
        j.watch.text = rtWatchText(e);
        // a swing's report is a long sentence (what the fit sees, when the turn comes, when it meets it): it may wrap
        j.watch.swing = isObj(e.swing);
        if (run) {
          const arc = swingArc(e);
          setSwing(s, r.motion ?? run.motion, arc, arc && isObj(e.meeting) ? swingMeeting(e) : undefined, tw, t);
        }
        return;
      }
      feed(s, 'engine', withVerdict(`watch ${n} · p ${fmtP(e.p)}`, j.watch.verdict), tw, t);
      if (e.intervene && !e.spliced) {
        // only an intervention is a step (the checks that let the motion carry on blink on the watch line instead), and a
        // spliced one is the splice's own step, which its re-edit made just before this entry
        addStep(s, 'watch', `watch · p ${fmtP(e.p)} → ${j.watch.verdict}`, tw, t, 'warn');
      }
      return;
    }
    case 'reedit': {
      const run = liveRun(s, r.motion);
      const kind = isObj(r.change) && r.change.kind ? String(r.change.kind) : null;
      if (r.rt === true && r.installed) {
        // the real-time lane re-edits its motion several times a second, a follow of its predicted target or the next
        // stage of a steer (approach, close, lift, level, tilt): the phase it reports is the run's (a loop's own), and
        // nothing else of it is news (a line, a step, a pulse and a mark per re-edit would bury the rest)
        if (run) anchor(run, r.phase, t, tw);
        // ... but every one of them is JEV's edit handed to the engine, as a standard run's re-edit is: the same pulse
        // travels the wire, one per RT_PULSE_GAP_S of the recording (a seek back starts the stream again)
        if (tw != null && (j.rt_pulse_tw == null || tw - j.rt_pulse_tw >= RT_PULSE_GAP_S || tw < j.rt_pulse_tw)) {
          j.rt_pulse_tw = tw;
          pulse(s, 'jev', 'engine', 're-edited', tw);
        }
        return;
      }
      if (!r.installed) {
        feed(s, 'jev', `re-edit of ${r.motion ?? ''} refused: ${r.reason ?? '?'}${kind === 'decision' ? ' (a changed decision)' : ''}`, tw, t);
        return;
      }
      if (kind === 'decision') {
        spliceStep(s, r, run, tw, t);
        return;
      }
      // a moved object's follow carries no change kind and counts on the badge; a paused run's re-edit answers the pause
      // (a jev_modify), and the body's and the close gate's re-edits are named by their change
      if (!kind && !(run && run.paused)) j.reedits += 1;
      if (run) {
        pushMark(run.reedit_marks, r.phase);
        anchor(run, r.entry_s ?? r.phase, t, tw);
      }
      pulse(s, 'jev', 'engine', 're-edited', tw);
      const moved = num(r.object_moved_m);
      const cause = kind ? ` · ${changeWords(kind)}` : moved != null ? ` · object moved ${fmtCm(moved)}` : '';
      feed(s, 'jev', `re-edits ${r.motion ?? ''} at phase ${fmtP(r.phase)}${cause}${r.new_decision ? ' · new decision' : ''}`, tw, t);
      // the re-edit a landed re-decision installed completes that step; any other re-edit is a step of its own
      const land = landingOf(j, r);
      if (land) settleLanding(s, land, r.new_decision === false ? 'the decision stands' : 're-edited');
      else addStep(s, 'reedit', reeditText(r, kind), tw, t, 'warn');
      return;
    }
    case 'chain': {
      if (r.installed) {
        j.chain = num(r.n_runs, j.chain + 1);
        pulse(s, 'jev', 'engine', 're-decided', tw);
        feed(s, 'jev', `re-decides ${r.motion ?? ''} mid-run: run ${j.chain} from phase ${fmtP(r.entry_s)}`, tw, t);
        addStep(s, 'chain', `re-decided mid-run → run ${j.chain} from phase ${fmtP(r.entry_s)}`, tw, t, 'warn');
      } else {
        feed(s, 'jev', `mid-run re-decision of ${r.motion ?? ''} refused: ${r.reason ?? '?'}`, tw, t);
      }
      return;
    }
    case 'resume': {
      const run = liveRun(s, r.motion);
      if (run) {
        run.paused = false;
        run.pause = null;
        anchor(run, r.phase, t, tw);
        // a real-time run that resumes is no longer blocked (`by`: the target came back, or a jev_modify)
        if (r.rt === true && !(run.rt_over || []).includes('blocked')) run.rt_over = [...(run.rt_over || []), 'blocked'];
      }
      const by = r.by === 'target_back' ? 'the target came back' : r.by === 'modify' ? 'after the LLM\'s modify' : null;
      feed(s, 'engine', `resumes ${r.motion ?? ''}${by ? ` (${by})` : r.why ? ` (${short(r.why, 60)})` : ''}`, tw, t);
      return;
    }
    case 'run_end': {
      let run = s.engine.run;
      if (!run || run.ended || (r.motion != null && run.motion != null && !runHas(run, r.motion))) {
        run = startRun(s, { motion: r.motion, channel: r.channel, arm: r.arm, object_ref: r.object_ref,
          t_start: r.t_start, duration_s: r.duration_s, source: 'run_end' }, tw);
      }
      if (CHANNELS.includes(r.channel)) run.channel = r.channel;
      run.arm = r.arm ?? run.arm;
      run.outcome = r.outcome != null ? String(r.outcome) : (run.outcome ?? 'ended');
      run.reason = r.reason ?? null;
      run.phase = num(r.phase, run.phase);
      run.ended = true;
      run.paused = false;
      run.held = null;
      run.ended_t_wall = tw;
      run.run_s = num(r.duration_s);
      run.counts = runCounts(r);
      j.landing = null;
      setSwing(s, null, null);
      s.memory.active = null;
      s.memory.also = [];
  s.memory.also = [];
      j.busy = null;
      if (run.channel === 'gaze') headMoved(s, tw);
      const dur = num(r.duration_s);
      feed(s, 'engine',
        `run end · ${r.motion ?? ''} [${run.channel}] ${run.outcome}${r.reason ? ` (${r.reason})` : ''}${dur != null ? ` in ${dur.toFixed(1)} s` : ''}`,
        tw, t, run.outcome === 'success' ? 'ok' : 'fail');
      if (r.accumulated) {
        const id = String(r.accumulated);
        run.accumulated = id;
        addLearned(s, id, r.motion ?? null, run.channel, tw);
        pulse(s, 'engine', 'memory', `kept as ${id}`, tw);
        feed(s, 'memory', `kept as ${id} — a child of ${r.motion ?? '?'}`, tw, t, 'ok');
      }
      return;
    }
    case 'mode_change': {
      onModeChange(s, r, tw, t);
      return;
    }
    case 'rt': {
      onRtMoment(s, r, tw, t);
      return;
    }
    default:
      feed(s, 'jev', short(`${k} ${r.motion ?? ''}`, 120), tw, t);
  }
}

// ---- a swinging target (contract H4 section 4: C-6, the lane's periodic fit) -------------------------------------------------
/** The predicted arc a record carries (rt_track.py `watch_fields`: `swing`, the fit, and `predicted_path`, the next
 * period in world points), or null when the record has none or the fit is not settled: the page draws only what the lane
 * itself would act on. */
export function swingArc(rec) {
  if (!isObj(rec) || !isObj(rec.swing) || rec.swing.settled !== true || !Array.isArray(rec.predicted_path)) return null;
  const path = rec.predicted_path.filter((p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => num(v) != null))
    .map((p) => p.slice(0, 3).map(Number));
  return path.length >= 2 ? path : null;
}

/** The meeting a record plans (a hand `plan`'s `meeting {turn, t_contact, p_contact}`, the `launch` moment's `turn {side}`,
 * `t_contact`, `p_contact`) as `{p, t, turn}`, or null. */
export function swingMeeting(rec) {
  if (!isObj(rec)) return null;
  const m = isObj(rec.meeting) ? rec.meeting : rec;
  const p = Array.isArray(m.p_contact) && m.p_contact.length >= 3 && m.p_contact.slice(0, 3).every((v) => num(v) != null)
    ? m.p_contact.slice(0, 3).map(Number) : null;
  if (!p) return null;
  const turn = typeof m.turn === 'string' ? m.turn : isObj(m.turn) && typeof m.turn.side === 'string' ? m.turn.side : null;
  return { p, t: num(m.t_contact), turn };
}

/** The swing's arc changes: a settled fit's arc replaces it (keeping the meeting unless the record says another, `null`
 * for none), anything else of the run's hands removes it (the fit broke, the thing is held). */
function setSwing(s, motion, path, meeting, tw, t) {
  const j = s.jev;
  if (!path) {
    if (j.swing) {
      j.swing = null;
      j.swing_seq += 1;
    }
    return;
  }
  const keep = j.swing && j.swing.motion === motion ? j.swing.meeting : null;
  j.swing = { motion: motion ?? null, path, meeting: meeting === undefined ? keep : meeting, t_wall: tw, t };
  j.swing_seq += 1;
}

/** How long after the planned contact the meeting's mark stays on the arc (s): the pads press a little after it. */
export const SWING_MEET_LINGER_S = 0.5;

/** What the viewport draws of a swing at the playhead's sim time `tSim`: `{path, meeting}` (`meeting` the contact point
 * `[x, y, z]` until SWING_MEET_LINGER_S after its time, else null) while the run whose arc it is still goes, else null. */
export function swingView(s, tSim) {
  const sw = s && s.jev ? s.jev.swing : null;
  const run = s && s.engine ? s.engine.run : null;
  if (!sw || !run || run.ended || (sw.motion != null && !runHas(run, sw.motion))) return null;
  const m = sw.meeting;
  const t = num(tSim);
  const on = !!m && (m.t == null || t == null || t <= m.t + SWING_MEET_LINGER_S);
  return { path: sw.path, meeting: on ? m.p : null };
}

/**
 * A real-time lane's report for the watch line (`rtWhy`), with a swing's sentence kept whole: "track left: the target
 * swings: a period of 2.9 s, 0.22 m to each side; it will stand still at its left turn in 0.7 s" -- its own "; " is not
 * the end of what it sees -- and, while the fit settles, "track right: watching the target swing: 0.29 of 0.75 periods
 * seen" (the reasons as the fit gives them, `entry.swing.why`). The meeting, when the lane names it, follows: " · meets it
 * in 2.5 s". Any other report as `rtWhy` cuts it.
 */
export function rtWatchText(entry) {
  const e = isObj(entry) ? entry : {};
  const text = String(e.why ?? '').trim().replace(/^real-time lane:\s*/, '');
  const head = (/^(track \w+: )/.exec(text) || ['', ''])[1];
  const meets = /meets it in [\d.]+ s/.exec(text);
  const tail = meets ? ` · ${meets[0]}` : '';
  const settled = /the target swings: [^;]*(?:; it will stand still at [^;]*)?/.exec(text);
  if (settled) return short(`${head}${settled[0]}${tail}`, 170);
  if (/watching the target swing: /.test(text) && isObj(e.swing) && typeof e.swing.why === 'string') {
    return short(`${head}watching the target swing: ${e.swing.why}${tail}`, 170);
  }
  // "waiting at the ready point, no meeting: <the lane's reason>": the reason in plain words (pass 2)
  return rtWhy(e.why).replace(/(no meeting: )(.+)$/, (all, lead, why) => {
    const plain = meetWhyWords(why.replace(/…$/, ''));
    return plain && plain !== why.replace(/…$/, '') ? `${lead}${plain}` : all;
  });
}

/**
 * A real-time run's key moments on its run line, in the order they first came: a count by its plural ("launches 1 ·
 * captures 1"), a state by its name, with its count only when it came more than once ("lifted", "solved", "blocked 2");
 * `armed` (at the ready point, waiting for the target) only while nothing has come after it; a stage on the way to a key
 * moment (the hands closing, the board grasped or lifted) never (it is a feed line); a moment the page does not know by
 * its name and count as they are ("bounce 2"). '' for a run without any.
 */
export function rtCountText(run) {
  if (!run || !isObj(run.rt)) return '';
  const entries = Object.entries(run.rt).filter(([, n]) => n > 0);
  const shown = (ev) => !(RT_MOMENTS[ev] && RT_MOMENTS[ev].stage);
  const later = entries.some(([ev]) => ev !== 'armed' && shown(ev));
  const over = Array.isArray(run.rt_over) ? run.rt_over : [];
  return entries.filter(([ev]) => shown(ev) && !(ev === 'armed' && later) && !over.includes(ev)).map(([ev, n]) => {
    const m = RT_MOMENTS[ev];
    if (m && m.count) return `${m.count} ${n}`;
    if (m && m.state && n === 1) return ev;
    return `${ev} ${n}`;
  }).join(' · ');
}

/**
 * One key moment of a real-time motion (an `rt` trace: `{event: "launch" | "capture" | "stroke" ..., n, arm, motion,
 * track, ...numbers}`): an Engine feed line and a count on the run line (`rtCountText`). A counted moment carries its
 * number ("snatch_side_right: capture #1 (right)"), a state or a stage none ("snatch_side_right: armed (right)"); a cell
 * names the cell ("tilt_tray_both: cell #3 C2 (both hands)"). Any field may be missing: the motion is then the running
 * one's, the number the run's own count, the arm left out. A moment of a motion with no run on the page yet starts one,
 * as a watch check does.
 */
function onRtMoment(s, r, tw, t) {
  const ev = r.event != null && String(r.event).trim() ? String(r.event).trim() : 'moment';
  let run = liveRun(s, r.motion);
  if (!run && r.motion != null) run = startRun(s, { motion: r.motion, t_start: t, rt: true, source: 'rt' }, tw);
  let count = null;
  if (run) {
    run.rt_plan = true;
    run.rt = { ...(run.rt || {}), [ev]: ((run.rt && run.rt[ev]) || 0) + 1 };
    count = run.rt[ev];
    // a two-handed motion's plan names one arm; its moments say both
    if (r.arm === 'both') run.arm = 'both';
    // a state stands until a later moment contradicts it, and stands again when it comes again
    run.rt_over = (run.rt_over || []).filter((x) => x !== ev);
    for (const st of RT_ENDS[ev] || []) if (!run.rt_over.includes(st)) run.rt_over.push(st);
  }
  const m = RT_MOMENTS[ev];
  const motion = r.motion ?? (run ? run.motion : null);
  const n = m && (m.state || m.stage) ? null : num(r.n, count);
  const arm = r.arm != null && String(r.arm) ? String(r.arm) : null;
  let detail = ev === 'cell' && r.cell != null ? ` ${r.cell}` : '';
  // a launch at a swinging target names the turn it meets and how soon; the arc on the view gets the meeting's mark
  const meeting = ev === 'launch' ? swingMeeting(r) : null;
  if (meeting) {
    if (s.jev.swing) {
      s.jev.swing = { ...s.jev.swing, meeting };
      s.jev.swing_seq += 1;
    }
    const inS = meeting.t != null && t != null ? meeting.t - t : null;
    if (meeting.turn) detail = ` at its ${meeting.turn} turn${inS != null && inS >= 0 ? ` in ${inS.toFixed(1)} s` : ''}`;
  }
  const head = motion != null ? `${motion}: ` : '';
  // why the hand did not take it (contract H4 pass 2): an abandoned attempt and a pass without one say so in plain words,
  // and the run keeps the last such reason until its next launch (the Engine block's line under the phase bar)
  if (ev === 'miss' || ev === 'no_meeting') {
    rtReason(s, run, ev, r, head, arm, tw, t);
    return;
  }
  // the target lost from view (on a belt: every time it goes into the cabinet) is said, quietly; it is no reason the hand
  // failed, so the Engine block keeps the last one it has
  if (ev === 'armed' && armedWords(r.why)) {
    feed(s, 'engine', `${head}armed${arm ? ` (${arm === 'both' ? 'both hands' : arm})` : ''} — ${armedWords(r.why)}`, tw, t, 'quiet');
    return;
  }
  if (run && ev === 'launch') {
    run.last_reason = null;
    run.rt_attempt = true;
  }
  if (run && (ev === 'capture' || ev === 'lifted')) run.rt_attempt = false;
  feed(s, 'engine', `${head}${ev.replace(/_/g, ' ')}${n != null && n > 0 ? ` #${n}` : ''}${detail}`
    + `${arm ? ` (${arm === 'both' ? 'both hands' : arm})` : ''}`, tw, t);
}

// ---- why the hand did not take it (contract H4 pass 2: the real-time lane's `miss`, `no_meeting` and `armed` rows) -------------
// The lane's own words (research/jev/rt_track.py) are an engineer's; a visitor gets them in plain words. A text the tables
// below do not know is shown as the lane wrote it.

/** An abandoned attempt (`miss {why}`, rt_track.py `_miss`) in words: the verb (how far it got) and why. */
const MISS_RULES = [
  [/^the target rides out of the arm's zone before the jaws can close/, () => ['gave up the reach',
    "the target would ride out of the arm's reach before the jaws close"]],
  [/^the arm cannot follow the riding curve/, () => ['gave up the reach', "the arm could not follow the target's path"]],
  [/^the jaws closed and hold nothing( \(timed out\))?/, (m) => ['missed the grasp',
    `the jaws closed on nothing${m[1] ? ' (they ran out of time)' : ''}`]],
  [/^the pads hold but the hand rose only ([\d.]+) cm of ([\d.]+) cm(; the arm's body rule refused)?/, (m) => ['could not lift it',
    `the hand rose only ${m[1]} cm of ${m[2]} cm${m[3] ? ', its own body in the way' : ''}`]],
  [/^the hold was lost during the take-off/, () => ['lost it on the lift', 'it slipped out of the hand']],
];

/** `[verb, words]` of a `miss` row's `why`; an unknown one keeps the lane's text. */
export function missWords(why) {
  const text = String(why ?? '').trim();
  for (const [re, fn] of MISS_RULES) {
    const m = re.exec(text);
    if (m) return fn(m);
  }
  return ['gave up', text || 'the lane gave no reason'];
}

/** The lane's reasons for finding no meeting (`last_meet_why.why`, a `no_meeting` row's `why`; rt_track.py `_meeting`,
 * `_meeting_swing`, `_try_launch`) in plain words. */
const MEET_WHY_WORDS = [
  [/^the item carries no zone table for this arm/, 'this motion knows no reach for this arm'],
  [/^no target state yet/, 'the target has not been seen yet'],
  [/^the track has not settled/, 'it has not watched the target long enough to predict where to meet it'],
  [/^the target moves faster than the arm follows/, 'the target moves faster than the arm can follow'],
  [/^the predicted path never lies in the arm's zone/, "the target's predicted path does not come within the arm's reach in time"],
  [/^the arm's zone holds the ride for less than/, "the target stays within the arm's reach too briefly to close on it"],
  [/^this arm's turn holds no ride inside its zone/, "its turn on this arm's side lies outside the arm's reach"],
  [/^the ride at this turn is faster than the arm follows/, 'at its turn it moves faster than the arm can follow'],
  [/^late: waiting for the second turn/, 'it waits for the second turn on this side (the decision says late)'],
  [/^no turn on this arm's side within the horizon/, "no turn on this arm's side comes soon"],
  [/^armed: the target is not in view/, 'the target is not in view'],
];

/** A meeting failure's `why` in plain words, or the lane's own text for one the table does not know ('' for none). */
export function meetWhyWords(why) {
  const text = String(why ?? '').trim();
  const hit = MEET_WHY_WORDS.find(([re]) => re.test(text));
  return hit ? hit[1] : text;
}

/** A pass without a launch (`no_meeting {cause, why, x_m, reach_x_m, other_arm_meets, arm}`, rt_track.py `_end_pass`): its
 * cause in plain words -- on a belt the target's place and speed against this arm's reach, on a swing (the lane's `why`
 * names a turn) its turn against the arm's zone -- and the other arm when it would have met it. */
export function noMeetingWords(r) {
  const rec = isObj(r) ? r : {};
  const cause = String(rec.cause ?? '').trim();
  const swing = /turn/.test(String(rec.why ?? '')) || cause === 'too wide' || cause === 'late';
  const x = num(rec.x_m);
  const reach = Array.isArray(rec.reach_x_m) && rec.reach_x_m.length >= 2 ? rec.reach_x_m.map(Number) : null;
  const where = x != null && reach && reach.every(Number.isFinite)
    ? ` (${x.toFixed(2)} m ahead; it reaches ${reach[0].toFixed(2)}-${reach[1].toFixed(2)} m)` : '';
  const words = {
    // on a belt the lane says "short ride" whenever the target's place ahead is within reach but the zone holds no ride
    // long enough (its place across the belt, its speed): at 0.02 m/s too, so the words do not blame the speed
    'short ride': swing ? 'its turn on this side leaves the hand too short a ride to close on it'
      : "the target does not stay within the arm's reach long enough for a grasp",
    'out of reach': swing ? "no turn on this side comes within the arm's reach" : 'the target passes at a height this arm cannot reach',
    'beyond reach': `${swing ? 'its turn on this side lies too far ahead for this arm' : 'the target passes too far away for this arm'}${where}`,
    'too near': `${swing ? 'its turn on this side comes too close to the body' : 'the target passes too close to the body for this arm'}${where}`,
    'too wide': 'its turn lies too far to the side for this arm',
    'ride too fast': 'the target moves faster than the arm can follow',
    'not settled': 'it had not watched the target long enough to predict where to meet it',
    late: 'it waits for a later turn (the decision says late)',
  }[cause] ?? (meetWhyWords(rec.why) || cause.replace(/_/g, ' ') || 'no reason given');
  const other = rec.other_arm_meets === true
    ? `; the ${rec.arm === 'left' ? 'right' : rec.arm === 'right' ? 'left' : 'other'} hand could have met it` : '';
  return `${words}${other}`;
}

/** An `armed` row's reason worth telling (the target lost from view, so the hand waits for it again), or null for the
 * plain "at the ready point, waiting for it" of a run's start. */
export function armedWords(why) {
  return /^the target has not been seen for/.test(String(why ?? '')) ? 'lost sight of the target, waiting for it to come back' : null;
}

/**
 * A reason the hand did not take the target (an abandoned attempt, a pass without one): one feed line, and the run's
 * `last_reason` (`{kind, verb, text, passes, t, t_wall, lane}`), which the Engine block shows until the next launch. A
 * pass whose cause is the one already shown since the last launch makes no new line (on a swing two passes can end 20 ms
 * apart): it counts on the reason instead.
 */
function rtReason(s, run, ev, r, head, arm, tw, t) {
  const armText = arm ? ` (${arm === 'both' ? 'both hands' : arm})` : '';
  let reason;
  if (ev === 'miss') {
    const [verb, words] = missWords(r.why);
    reason = { kind: 'miss', verb, text: words, key: `miss|${r.why}`, passes: 0 };
  } else {
    reason = { kind: 'no_meeting', verb: 'no attempt this pass', text: noMeetingWords(r), key: `pass|${r.cause}|${r.other_arm_meets}`,
      passes: 1 };
  }
  const prev = run ? run.last_reason : null;
  if (run) {
    if (ev === 'miss') run.rt_attempt = false;
    run.last_reason = { ...reason, passes: prev && prev.key === reason.key ? prev.passes + reason.passes : reason.passes,
      t, t_wall: tw, lane: r.why ?? r.cause ?? null };
  }
  if (prev && prev.key === reason.key && ev === 'no_meeting') return;
  feed(s, 'engine', `${head}${reason.verb}${armText} — ${reason.text}`, tw, t);
}

/** The first sentence of a behaviour's words (an advice, a why), cut to `n` characters: what a pause line has room for
 * (the title keeps the whole text). */
function firstSentence(text, n = 170) {
  const t = String(text ?? '').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return short(m ? m[1] : t, n);
}

/** An RT watch entry's `why` for the watch line: the lane's own words without the "real-time lane:" prefix, up to the
 * first "; " and without the step's cost ("track right: waiting at the ready point, meets it in 4.8 s"). */
export function rtWhy(why) {
  let text = String(why ?? '').trim().replace(/^real-time lane:\s*/, '');
  const cut = text.indexOf('; ');
  if (cut > 0) text = text.slice(0, cut);
  return short(text.replace(/,\s*step [\d.]+ ms$/, '').replace(/ -> /g, ' → '), 120);
}

/** The counts a hand run's end carries (re-edits by kind, the watch's passes and changes, the engine's re-decisions in a
 * job), or null for a recording made before the run ends carried them. */
function runCounts(r) {
  if (num(r.n_reedits_follow) == null && num(r.n_watch_passes) == null && num(r.n_redecisions_async) == null) return null;
  const c = {};
  for (const k of COUNT_KEYS) c[k] = num(r[k]);
  return c;
}

/** The playhead holds while the engine asks the decider (a replay's pseudo-row, see `holdRows`): the phase bar stands
 * and the watch rests until the answer lands. */
function onHold(s, r, tw, t) {
  const run = liveRun(s, r.motion);
  if (!run) return;
  run.held = { why: r.why ?? null, since: t };
  if (num(r.phase) != null) anchor(run, r.phase, t, tw);
  feed(s, 'engine', `holds ${run.motion ?? ''} at phase ${fmtP(run.phase)} · asks the decider${r.why ? ` (${r.why})` : ''}`, tw, t);
}

function onFault(s, r, tw, t) {
  const rest = {};
  for (const [k, v] of Object.entries(r)) if (!['kind', 't', 't_wall'].includes(k)) rest[k] = v;
  const text = short(JSON.stringify(rest), 140);
  s.engine.fault = { text, t_wall: tw };
  feed(s, 'engine', `robot fault · ${text}`, tw, t, 'fail');
}

function onPlayer(s, r, tw) {
  const k = String(r.kind).slice('player/'.length);
  switch (k) {
    case 'system':
      if (s.llm.phase === 'idle') {
        s.llm.phase = 'thinking';
        openGap(s, tw);
      }
      if (r.subtype === 'init' || r.subtype == null) feed(s, 'llm', `session starts${r.model ? ` · ${r.model}` : ''}`, tw);
      return;
    case 'text': {
      const text = String(r.text ?? '').trim();
      if (!text) return;
      s.llm.text = text.slice(0, TEXT_MAX);
      s.llm.text_t_wall = tw;
      if (s.llm.phase === 'idle') {
        s.llm.phase = 'thinking';
        openGap(s, tw);
      }
      feed(s, 'llm', `“${short(text, 220)}”`, tw);
      return;
    }
    case 'thinking':
      // the content stays private; only the fact that the model is thinking shows
      if (!s.llm.calls.length && s.llm.phase !== 'done') {
        s.llm.phase = 'thinking';
        if (s.llm.gap_t_wall == null) openGap(s, tw);
      }
      return;
    case 'tool_result':
      if (r.is_error) feed(s, 'llm', `${r.tool ?? 'tool'} error at the client: ${short(r.text, 160)}`, tw, null, 'fail');
      return;
    case 'result':
      if (r.subtype !== 'turn.completed') feed(s, 'llm', `session ends · ${r.subtype ?? 'done'}${r.is_error ? ' · error' : ''}`, tw);
      return;
    case 'error':
      feed(s, 'llm', `error · ${short(r.text, 160)}`, tw, null, 'fail');
      return;
    case 'rate_limit': {
      const info = isObj(r.info) ? r.info : null;
      if (info && info.status && info.status !== 'allowed') feed(s, 'llm', `rate limit · ${info.status}`, tw);
      return;
    }
    case 'shell':
      feed(s, 'llm', `shell · ${short(r.command, 120)}`, tw);
      return;
    default:
  }
}

// ---- world rows: the scene changed under the robot (section 4.2) -------------------------------------------------------
function xyText(p) {
  return Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every(Number.isFinite)
    ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)})` : null;
}

/** A gate (an opening that closes behind the robot) changed state; the viewport moves its geom from the same row. */
function onGate(s, r, tw, t) {
  const name = r.name ?? '?';
  if (r.state === 'closed') feed(s, 'world', `gate ${name} closed behind the robot`, tw, t);
  else feed(s, 'world', `gate ${name} ${r.state ?? 'changed'}`, tw, t);
}

/** A step of the scene's scripted mover started or finished. A row about a region marker carries the marker's geom
 * (`geom_id`; older recordings only name it, so the scene dict's region names count too); a teleport is one line (its
 * start and its end come together). */
function onObjectMotion(s, r, tw, t) {
  const region = Number.isInteger(r.geom_id) || s.episode.regions.includes(String(r.object));
  const what = region ? `the target ${r.object ?? '?'}` : String(r.object ?? 'an object');
  const mode = r.mode ? String(r.mode) : 'move';
  if (r.state === 'started') {
    if (mode !== 'teleport') feed(s, 'world', `${what} starts to move (${mode})`, tw, t);
    return;
  }
  if (r.state !== 'finished') return;
  const to = xyText(r.to);
  const why = r.reason && r.reason !== mode ? ` · ${r.reason}` : '';
  feed(s, 'world', `${what} moved (${mode})${to ? ` → ${to}` : ''}${why}`, tw, t);
}

/** A ball's number in a line: "ball 3", or "a ball" when the row does not say. */
function ballWords(r) {
  const n = num(r.n);
  return n != null ? `ball ${n}` : 'a ball';
}

function underscores(v) {
  return String(v).replace(/_/g, ' ');
}

/** A pan toss's verdict. The game (contract R11, 2026-11-15: the row carries `number` and `of_tosses`): "toss 3 of 5: 6
 * turned, 8 of 8 in the pan — 17 points so far" (`turned`: the caught pieces that came back on another side; the points
 * are the game's total), a shake a quiet line of its own; the count of before it: "toss 3: 8 of 8 back in the pan ·
 * counted, 2 so far" (the judge counts a toss whose pieces all rose above the rim and enough of them came back;
 * scenes/pan_toss.py). */
function tossWords(r) {
  if (Object.prototype.hasOwnProperty.call(r, 'number') || Object.prototype.hasOwnProperty.call(r, 'of_tosses')) {
    if (r.shake === true) return { text: 'a shake: the pieces hopped too little to count as a toss', tone: 'quiet' };
    const kept = num(r.kept);
    const of = num(r.of);
    const total = num(r.points_total);
    const head = `toss ${num(r.number) ?? '?'}${num(r.of_tosses) != null ? ` of ${num(r.of_tosses)}` : ''}`;
    const turned = num(r.turned) != null ? `${num(r.turned)} turned` : null;
    const inPan = kept != null ? `${kept}${of != null ? ` of ${of}` : ''} in the pan` : null;
    const pts = total != null ? ` — ${total} point${total === 1 ? '' : 's'}${r.done === true ? ' in all' : ' so far'}` : '';
    return `${head}: ${[turned, inPan].filter(Boolean).join(', ') || 'ended'}${pts}`;
  }
  const n = num(r.n);
  const kept = num(r.kept);
  const of = num(r.of);
  const head = n != null ? `toss ${n}` : 'a toss';
  const back = kept != null && of != null ? `: ${kept} of ${of} back in the pan` : kept != null ? `: ${kept} back in the pan` : ' ended';
  const so = num(r.tosses);
  // a toss with every piece back can still not count: one rose too little (the judge's apex), which the line then says
  const low = num(r.apex_min_m);
  const why = kept != null && of != null && kept === of && low != null ? ` (the lowest piece rose ${fmtCm(low)})` : '';
  const verdict = r.counted === true ? ` · counted${so != null ? `, ${so} so far` : ''}` : r.counted === false ? ` · not counted${why}` : '';
  return `${head}${back}${verdict}`;
}

/** Why a ball missed, in the page's own words (scenes/ball_launcher.py's reasons). */
const MISS_WORDS = { own_half: 'bounced on its own side', off_table: 'went off the table', not_touched: 'never touched',
  timeout: 'undecided at the limit', rest: 'came to rest' };

/** A miss's reason with whether the paddle touched the ball (null: unknown): a stroke that sent it off the table or onto
 * the robot's own side is "hit, but …", an untouched ball that left the table "never touched (it went off the table)". */
function ballMissWords(reason, touched) {
  if (reason === 'off_table') return touched === true ? 'hit, but it went off the table' : touched === false
    ? 'never touched (it went off the table)' : MISS_WORDS.off_table;
  if (reason === 'own_half') return touched === false ? MISS_WORDS.own_half : "hit, but it bounced on the robot's own side";
  return reason ? (MISS_WORDS[reason] || underscores(reason)) : '';
}

/** A decided ball (C-4). A row with the judge's crossing (contract R10, 2026-11-15) says where the ball came and where it
 * went: "ball 4: returned — came 0.21 m left of centre, landed 0.62 m past the net", "ball 5: missed, never touched —
 * came 0.08 m right of centre"; an older row "ball 4 returned over the net" / "ball 5 missed (own half)". */
function ballDecided(r, s) {
  const fresh = Object.prototype.hasOwnProperty.call(r, 'cross_y_m');
  if (!fresh) {
    return r.event === 'returned' ? `${ballWords(r)} returned over the net`
      : `${ballWords(r)} missed${r.reason ? ` (${underscores(r.reason)})` : ''}`;
  }
  const came = cameWords(r.cross_y_m);
  const land = num(r.land_along_m ?? r.along_m);
  const went = r.event === 'returned' && land != null ? `landed ${Math.abs(land).toFixed(2)} m past the net` : null;
  // whether the paddle touched it: the event does not say, the card's row of the same ball (decided in the same instant)
  // does -- a ball that went off the table after a stroke reads otherwise than one that passed untouched
  const card = s && isObj(s.episode.score_card) && Array.isArray(s.episode.score_card.trials) ? s.episode.score_card.trials : [];
  const row = card.find((x) => isObj(x) && x.n === r.n && (x.ball == null || r.ball == null || x.ball === r.ball));
  const touched = row && typeof row.touched === 'boolean' ? row.touched : null;
  const why = r.event === 'returned' ? '' : ballMissWords(r.reason, touched);
  const what = r.event === 'returned' ? 'returned' : why.startsWith('hit') ? why : `missed${why ? `, ${why}` : ''}`;
  const where = [came, went].filter(Boolean).join(', ');
  return { text: `${ballWords(r)}: ${what}${where ? ` — ${where}` : ''}`, tone: r.event === 'returned' ? 'ok' : null };
}

/** A pass of the conveyor's target ended (C-1, contract S7: `pass {object, n, outcome}`): "pass 3 of the target: taken
 * (right hand)", "pass 2 of the target: passed by". */
const PASS_WORDS = { taken: 'taken', passed: 'passed by', pinched_lost: 'pinched, then lost on the belt',
  off_belt: 'fell off the belt', running: 'still on the belt' };
function passWords(r, s) {
  const by = r.outcome === 'taken' && s.episode.target_taken_by ? ` (${s.episode.target_taken_by} hand)` : '';
  return { text: `pass ${num(r.n) ?? '?'} of the target: ${PASS_WORDS[r.outcome] || underscores(r.outcome ?? 'ended')}${by}`,
    tone: r.outcome === 'taken' ? 'ok' : null };
}

/** The pan toss's game decided (`game_over {passed, points, tosses, kept, shakes}`). */
function gameOverWords(r) {
  const pts = num(r.points);
  const n = num(r.tosses);
  const kept = num(r.kept);
  const bits = [`${pts ?? '?'} point${pts === 1 ? '' : 's'}${n != null ? ` in ${n} toss${n === 1 ? '' : 'es'}` : ''}`];
  if (kept != null) bits.push(`${kept} piece${kept === 1 ? '' : 's'} kept`);
  return { text: `the game is over: ${bits.join(', ')}${r.passed === true ? ' — passed' : r.passed === false ? ' — not passed' : ''}`,
    tone: r.passed === true ? 'ok' : r.passed === false ? 'fail' : null };
}

/** Whether a real-time hand attempt is under way (from its launch to its miss, capture or the run's end). */
function inAttempt(s) {
  const run = s.engine.run;
  return !!run && !run.ended && run.rt_attempt === true;
}

/** A quiet line the first time `key` comes in the current run (or outside any run), else none. */
function onceQuiet(s, key, text) {
  const run = s.engine.run;
  const k = `${run && !run.ended ? run.t_wall_start : 'none'}|${key}`;
  if (s.episode.quiet_keys.includes(k)) return null;
  s.episode.quiet_keys.push(k);
  if (s.episode.quiet_keys.length > 64) s.episode.quiet_keys.shift();
  return { text, tone: 'quiet' };
}

/** Who touched the banana (C-6's `by`: left | right | body): the hand of a pad contact, the arm or the body of a knock. */
function swingWho(by, part) {
  if (by === 'body') return 'the body';
  return by ? `the ${by} ${part}` : `a ${part}`;
}

/**
 * The events of the scene components a viewer cares about, by the component kind that publishes them (a row's
 * `trace_kind`, the payload's own `kind`) and the event: its line, a string or `{text, tone}`, or null for no line (a
 * function may keep what a later row of the same machine needs, the conveyor's target). Two machines may share an
 * event's name (`taken`, `release`, `touch`): the kind keeps them apart; a row without a kind (an older recording) takes
 * the first kind that knows its event.
 */
const COMPONENT_EVENTS = {
  conveyor: {
    // the target comes round again (`spawn` with `target: true`); the other items' spawns are no news
    spawn: (r, s) => {
      if (r.target !== true) return null;
      const e = s.episode;
      if (r.object != null && !e.targets.includes(String(r.object))) e.targets.push(String(r.object));
      e.target_passes += 1;
      return `the target comes round: pass ${e.target_passes}`;
    },
    // the target's take is told by its pass, which follows in the same tick, with the hand kept here
    taken: (r, s) => {
      if (r.object != null && s.episode.targets.includes(String(r.object))) {
        s.episode.target_taken_by = r.gripper ?? null;
        return null;
      }
      return `${r.object ?? 'an item'} taken off the belt${r.gripper ? ` (${r.gripper} hand)` : ''}`;
    },
    pass: passWords,
  },
  maze: {
    solved: () => 'the ball rests in the cup: the maze is solved',
    ball_off: () => 'the ball fell off the maze board',
  },
  pan_toss: {
    toss: tossWords,
    game_over: gameOverWords,
    lost: (r) => `${r.piece ?? 'a piece'} fell out of the pan`,
  },
  ball_launcher: {
    launch: (r) => `${ballWords(r)} launched`,
    returned: ballDecided,
    missed: ballDecided,
  },
  grip_assist: {
    grip_on: (r) => `the grip assist locks ${r.object ?? 'the object'} to the ${r.hand ? `${r.hand} ` : ''}hand`,
    grip_off: (r) => `the grip assist lets go of ${r.object ?? 'the object'}`
      + `${r.reason === 'opened' ? ' (the hand opened)' : r.reason ? ` (${underscores(r.reason)})` : ''}`,
  },
  balloon: {
    release: (r) => `the balloon is let go${r.hand ? ` (a ${r.hand} hand under it)` : ''}`,
    hit: (r) => `balloon hit${num(r.n) != null ? ` #${num(r.n)}` : ''}${r.arm ? ` (${r.arm} hand)` : ''}`,
    grounded: (r) => `the balloon came down${r.where ? ` on the ${underscores(r.where)}` : ''}`,
  },
  // C-6 (scenes/pendulum.py): a free turn of the swing is no news, the robot's contacts and the banana's fate are -- a
  // contact during an attempt (from a launch to its end) and every pinch; outside one the banana swinging into a waiting
  // hand or arm is told once per run and part, quietly (it comes back every swing)
  pendulum: {
    touch: (r, s) => (r.pinch === true || inAttempt(s) ? `${swingWho(r.by, 'hand')} ${r.pinch === true ? 'pinches' : 'touches'} the banana`
      : onceQuiet(s, `touch|${r.by}`, `the banana brushes ${swingWho(r.by, 'hand')}`)),
    knock: (r, s) => (inAttempt(s) ? `${swingWho(r.by, 'arm')} knocks the banana`
      : onceQuiet(s, `knock|${r.by}`, `the banana knocks against ${swingWho(r.by, 'arm')}`)),
    release: (r) => {
      const bits = [num(r.load_n) != null ? `pulled with ${num(r.load_n).toFixed(1)} N` : null,
        r.held_by ? `${r.held_by} hand` : null].filter(Boolean);
      return `the banana comes off the cord${bits.length ? ` (${bits.join(', ')})` : ''}`;
    },
    taken: (r) => ({ text: `the banana is taken${r.by ? ` (${r.by} hand)` : ''}`, tone: 'ok' }),
    dropped: () => ({ text: 'the banana is dropped', tone: 'fail' }),
  },
};

/** The line function of a `scene/component` row the feed shows, or null for one it leaves out (a noisy event, an unknown
 * one). */
function componentEntry(r) {
  const ev = r.event;
  const has = (kind) => Object.prototype.hasOwnProperty.call(COMPONENT_EVENTS, kind)
    && Object.prototype.hasOwnProperty.call(COMPONENT_EVENTS[kind], ev);
  const kind = r.trace_kind ?? null;
  if (kind != null) return has(kind) ? COMPONENT_EVENTS[kind][ev] : null;
  const first = Object.keys(COMPONENT_EVENTS).find(has);
  return first ? COMPONENT_EVENTS[first][ev] : null;
}

/** A scene component's event (scenes/components.py `{component, kind, event, ...}`): a World line for the ones a viewer
 * cares about (an item taken off the belt, a pass of the target, the maze solved, a toss and its verdict, a ball returned
 * or missed, the grip assist on or off, the banana touched, taken or dropped); nothing for the rest. */
function onComponent(s, r, tw, t) {
  const fn = componentEntry(r);
  const out = fn ? fn(r, s) : null;
  if (!out) return;
  const line = typeof out === 'string' ? { text: out, tone: null } : out;
  feed(s, 'world', short(line.text, 160), tw, t, line.tone ?? null);
}

const HANDLERS = {
  meta: onMeta,
  'task/episode_start': onEpisodeStart,
  'task/status': onTaskStatus,
  'task/episode_end': onEpisodeEnd,
  'reasoning/tool_status': onToolStatus,
  'lab/tool_result': onToolResult,
  'research/jev_event': onJevEvent,
  'research/jev_trace': onTrace,
  'motor_control/fault': onFault,
  'scene/gate': onGate,
  'scene/object_motion': onObjectMotion,
  'scene/component': onComponent,
  hold: onHold,
  task_shape: onTaskShape,
  runner: (s, r, tw, t) => {
    if (r.what !== 'task') feed(s, 'run', short(String(r.what ?? ''), 120), tw, t);
  },
  library: (s, r) => setItems(s, r.items),
  scene: (s, r) => {
    const sc = isObj(r.scene) ? r.scene : null;
    if (sc && sc.name) s.episode.scene = String(sc.name);
    if (sc && Array.isArray(sc.regions)) s.episode.regions = sc.regions.filter((r) => isObj(r) && r.name).map((r) => String(r.name));
    else if (typeof r.scene === 'string') s.episode.scene = r.scene;
    // the task's goals as the scene describes them (describe.py task_of): the pills' labels and the counters' goals
    if (sc && isObj(sc.task)) {
      if (sc.task.name != null && s.episode.task == null) s.episode.task = String(sc.task.name);
      if (Array.isArray(sc.task.goals)) {
        s.episode.goals = sc.task.goals.filter((g) => isObj(g) && typeof g.key === 'string').map((g) => ({
          key: g.key, kind: g.kind ?? null, object: g.object ?? null, region: g.region ?? null, component: g.component ?? null,
          status_key: g.status_key ?? null, at_least: num(g.at_least) }));
      }
      // the scorecard's head (what the task asks, its protocol, its pass rule, the primary's name): fixed for the episode
      const head = scoreHead(sc.task);
      if (head) s.episode.score_head = head;
    }
    if (r.seed != null) s.episode.seed = r.seed;
  },
  // a replay's scorecard, seeded with the bundle (model/score.js reveals its rows up to the playhead)
  score: (s, r) => {
    if (!isObj(r.card)) return;
    s.episode.score_card = r.card;
    s.episode.score_seeded = true;
  },
  robot: (s, r) => {
    if (r.mode != null) s.engine.mode = String(r.mode);
    if (r.state != null) s.engine.control = String(r.state);
  },
  viewer: (s, r, tw, t) => feed(s, 'world', short(String(r.text ?? ''), 160), tw, t),
};

/** Fold one row into the state. Returns the state (mutated in place: the HUD re-renders from it). */
export function reduce(s, row) {
  if (!isObj(row)) return s;
  const kind = String(row.kind ?? '');
  const tw = num(row.t_wall);
  const t = num(row.t);
  if (tw != null) {
    if (s.episode.t0_wall == null) s.episode.t0_wall = tw;
    if (s.episode.t_wall == null || tw > s.episode.t_wall) s.episode.t_wall = tw;
  }
  if (t != null && (s.episode.t == null || t > s.episode.t)) s.episode.t = t;
  if (s.episode.closed && shutdownRow(row)) return s;
  const fn = HANDLERS[kind] || (kind.startsWith('player/') ? onPlayer : null);
  if (fn) fn(s, row, tw, t);
  return s;
}

/**
 * The time-derived fields at the playback clock `{t, t_wall}` (sim and wall seconds): the seconds of the current
 * thinking gap (and the episode's total), and the running motion's phase, extrapolated from its last known phase at
 * the run's speed until the engine says otherwise.
 */
export function tick(s, clock = {}) {
  const tw = num(clock.t_wall);
  const ts = num(clock.t);
  const llm = s.llm;
  if (tw != null && llm.gap_t_wall != null) {
    llm.thinking_s = Math.max(0, tw - llm.gap_t_wall);
    llm.thinking_total_s = llm.thinking_closed_s + llm.thinking_s;
  }
  const run = s.engine.run;
  // a pause and a hold (the playhead waiting for the decider) keep the phase where it stands; so does a real-time motion,
  // whose phase is the one the engine last reported (its playhead rests at the ready phase until the target comes, so
  // time says nothing about it; a loop's wraps from 1 back to 0 each cycle), and a run without a duration has no rate
  if (run && !run.ended && run.outcome == null && !run.paused && !run.held && !run.loop && !run.rt_plan
    && num(run.duration_s, 0) > 0) {
    let el = null;
    if (ts != null && run.anchor_t != null) el = ts - run.anchor_t;
    else if (tw != null && run.anchor_t_wall != null) el = tw - run.anchor_t_wall;
    // the plan's duration covers the curve from the entry phase to its end
    const rate = Math.max(0, 1 - num(run.entry_s, 0)) / run.duration_s;
    if (el != null) run.phase = clamp(run.anchor_phase + Math.max(0, el) * rate, 0, Math.max(run.anchor_phase, PHASE_EXTRAPOLATION_CAP));
  }
  return s;
}

/** The actor a row belongs to on the time bar's event ticks, or null for rows that get no tick. */
export function rowActor(row) {
  if (!isObj(row)) return null;
  switch (row.kind) {
    case 'reasoning/tool_status': return row.state === 'starting' ? 'llm' : null;
    case 'player/text': return 'llm';
    case 'research/jev_event':
      if (row.event === 'options') return 'jev';
      if (row.event === 'fail') return 'fail';
      return row.event === 'success' || row.event === 'scene_changed' ? 'engine' : null;
    case 'research/jev_trace':
      if (row.trace_kind === 'run_end') return row.accumulated ? 'memory' : 'engine';
      // the real-time lane's re-aims come several times a second: ticks for them would cover the bar
      if (row.rt === true && (row.trace_kind === 'reedit' || (row.trace_kind === 'plan' && row.reedit))) return null;
      if ((row.trace_kind === 'decision' || row.trace_kind === 'redecision') && row.context !== 'options') return 'jev';
      return ['reedit', 'chain', 'plan'].includes(row.trace_kind) ? 'jev' : null;
    case 'task/episode_end': return 'task';
    case 'scene/gate': return 'world';
    case 'scene/object_motion': return row.state === 'finished' ? 'world' : null;
    // a pan toss's shake uses up nothing: no tick for it
    case 'scene/component': return COMPONENT_TICK_EVENTS.has(row.event) && row.shake !== true && componentEntry(row) ? 'world' : null;
    default: return null;
  }
}

/**
 * The holds of a recording, as `hold` pseudo-rows a replay plays at their start. The engine asks the decider in a job
 * and writes the `redecision` trace when the answer lands (`async`, `asked_t`, `asked_phase`, `held_s`, sim seconds the
 * playhead held); nothing is written when it asks. Each landing with `held_s > 0` spans `[asked_t, asked_t + held_s]`,
 * and its row is placed on the wall clock after the engine's own traces of the motion at `asked_t` (the tick that asked:
 * a refused follow, say), else at `asked_t` through the rows' (t, t_wall) pairs, kept where the sim time does not go
 * back (an event row and a tool call carry stamps of their own). A live run has no such row: it shows the landing only.
 */
export function holdRows(rows) {
  const list = (rows || []).filter(isObj);
  const pts = list.map((r) => [num(r.t_wall), num(r.t)]).filter(([tw, t]) => tw != null && t != null).sort((a, b) => a[0] - b[0]);
  const pairs = [];
  for (const [tw, t] of pts) if (!pairs.length || t >= pairs[pairs.length - 1][1]) pairs.push([tw, t]);
  const wallAt = (t) => {
    const i = pairs.findIndex((p) => p[1] >= t);
    if (i < 0 || (i === 0 && pairs[0][1] > t)) return null;
    if (pairs[i][1] === t) return pairs[i][0];
    const [w0, t0] = pairs[i - 1];
    const [w1, t1] = pairs[i];
    return w0 + ((w1 - w0) * (t - t0)) / (t1 - t0);
  };
  const out = [];
  for (const r of list) {
    if (r.kind !== 'research/jev_trace' || r.trace_kind !== 'redecision' || r.async !== true) continue;
    const held = num(r.held_s, 0);
    const asked = num(r.asked_t);
    const landed = num(r.t_wall);
    if (!(held > 0) || asked == null || landed == null) continue;
    const asking = list.filter((x) => x.kind === 'research/jev_trace' && x !== r && (x.motion ?? null) === (r.motion ?? null)
      && num(x.t) != null && Math.abs(num(x.t) - asked) <= SAME_TICK_S && num(x.t_wall) != null && num(x.t_wall) <= landed)
      .map((x) => num(x.t_wall));
    // without a row of that tick or a pair around it the hold is placed by its own length before the landing
    const tw = Math.min(landed, asking.length ? Math.max(...asking) : wallAt(asked) ?? landed - held);
    const kind = isObj(r.change) ? r.change.kind : null;
    out.push({ kind: 'hold', motion: r.motion ?? null, t: asked, t_wall: tw, why: changeWords(kind), phase: num(r.asked_phase),
      held_s: held });
  }
  return out;
}

/** The ids a recording learned (run ends with `accumulated`): a replay hides them until their run end. */
export function learnedIds(rows) {
  const out = new Set();
  for (const r of rows || []) {
    if (isObj(r) && r.kind === 'research/jev_trace' && r.trace_kind === 'run_end' && r.accumulated) out.add(String(r.accumulated));
  }
  return out;
}
