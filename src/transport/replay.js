// Replay of a recorded episode bundle (docs/design/WEB_HUD.md sections 7 and 8.4).
//
// A bundle is `episodes/<id>/{episode.json, frames.bin, model.mjb}` written by tools/web/export_episode.py. The rows
// are replayed on the wall clock they were recorded at (a row fires at `t_wall - t0`). Frames are placed on the same
// clock when the bundle says how (`frames.hz` and `frames.t_rel0`: frame i is at `t_rel0 + i / hz`); otherwise the
// player maps its wall clock to sim time through the rows' own (t_wall, t) pairs and finds the frames by their sim
// time. Either way `qpos` is interpolated linearly between frames. Seeking hands the rows up to the target to the app, which rebuilds the HUD state by
// reducing them from scratch (the reducer is pure, so a seek and a straight play end in the same state).

import { isObj, num, clamp } from '../util/format.js';
import { rowActor, learnedIds } from '../model/pipeline.js';

// half speed lets a burst of JEV's decisions be followed; the faster ones skim the waiting
export const SPEEDS = [0.5, 1, 2, 4];

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}

/** `frames.bin`: little-endian float32, `n x (1 + nq)` (the sim time, then qpos); `hz` / `t_rel0` place frame i on
 * the playback clock at `t_rel0 + i / hz` when the bundle gives them. */
export function parseFrames(buffer, nq, n = null, hz = null, tRel0 = 0) {
  const stride = 1 + nq;
  const count = Math.floor(buffer.byteLength / 4 / stride);
  const total = n != null ? Math.min(n, count) : count;
  let data;
  if (LITTLE_ENDIAN) {
    data = new Float32Array(buffer, 0, total * stride);
  } else {
    const view = new DataView(buffer);
    data = new Float32Array(total * stride);
    for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(4 * i, true);
  }
  return { n: total, nq, stride, data, t_first: total ? data[0] : 0, t_last: total ? data[(total - 1) * stride] : 0,
    hz: hz != null && hz > 0 ? hz : null, t_rel0: tRel0 ?? 0 };
}

/**
 * Load a bundle from the URL of its `episode.json`: `{meta, scene, library, rows, frames, modelBytes, errors}`. A
 * missing or unreadable `frames.bin` or `model.mjb` leaves `frames` / `modelBytes` null (with the reason in
 * `errors`): the HUD replays the rows without the 3-D mirror.
 */
export async function loadBundle(url) {
  const base = new URL(url, document.baseURI);
  const res = await fetch(base);
  if (!res.ok) throw new Error(`episode ${base.pathname}: ${res.status} ${res.statusText}`);
  const json = await res.json();
  // the scene dict may sit under `scene` (section 7) or beside a plain scene name
  const scene = isObj(json.scene) ? json.scene : isObj(json.scene_dict) ? json.scene_dict : null;
  const meta = {
    format: json.format ?? null,
    id: json.id ?? null,
    title: json.title ?? null,
    scene: scene?.name ?? (typeof json.scene === 'string' ? json.scene : null) ?? json.scene_name ?? null,
    seed: json.seed ?? null,
    outcome: json.outcome ?? null,
    t0_wall: num(json.t0_wall),
    duration_s: num(json.duration_s),
    notes: Array.isArray(json.notes) ? json.notes.map(String) : [],
    stats: isObj(json.stats) ? json.stats : null,
    url: base.href,
  };
  const rows = (Array.isArray(json.rows) ? json.rows : []).filter(isObj);
  const errors = [];
  let frames = null;
  const fr = isObj(json.frames) ? json.frames : null;
  if (fr && fr.url) {
    const nq = num(fr.nq) ?? num(scene?.nq);
    if (nq == null) errors.push('frames: nq unknown');
    else {
      try {
        frames = parseFrames(await fetchBuffer(new URL(fr.url, base)), nq, num(fr.n), num(fr.hz), num(fr.t_rel0, 0));
      } catch (e) {
        errors.push(`frames: ${e.message}`);
      }
    }
  }
  let modelBytes = null;
  if (json.model_url) {
    try {
      modelBytes = await fetchBuffer(new URL(json.model_url, base));
    } catch (e) {
      errors.push(`model: ${e.message}`);
    }
  }
  return { meta, scene, library: Array.isArray(json.library) ? json.library : [], rows, frames, modelBytes, errors };
}

/** The bundle's library as it stood when the episode began: the motions the recording learned come back at their run end. */
export function initialLibrary(bundle) {
  const learned = learnedIds(bundle.rows);
  return (bundle.library || []).filter((it) => isObj(it) && !learned.has(String(it.id)));
}

function upperBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A playback clock over a bundle, at one of `SPEEDS`. `handlers`: `onRows(rows)` (rows that became due, in order),
 * `onSeek(t_rel, rows)` (a seek: the rows up to the target, to rebuild the state from), `onTime(t_rel)`,
 * `onState({playing, speed})`, `onEnd()`. The app calls `step(nowMs)` once per animation frame; it returns the clock
 * and the mirrored `qpos`.
 */
export function createPlayer(bundle, handlers = {}) {
  const meta = bundle.meta || {};
  // rows in wall order; a row without a wall stamp keeps its place after the row before it
  const rows = [];
  let lastWall = null;
  bundle.rows.forEach((r, i) => {
    const tw = num(r.t_wall);
    if (tw != null) lastWall = tw;
    rows.push({ r, i, tw: tw ?? lastWall ?? 0 });
  });
  rows.sort((a, b) => a.tw - b.tw || a.i - b.i);
  const t0 = meta.t0_wall ?? (rows.length ? rows[0].tw : 0);
  const rel = rows.map((x) => x.tw - t0);
  const ordered = rows.map((x) => x.r);

  // wall -> sim time: the rows' (t_wall, t) pairs, kept where the sim time does not go back (an event row carries its
  // own, older stamp); outside the pairs the sim runs at wall speed
  const pairs = [];
  for (let i = 0; i < ordered.length; i++) {
    const t = num(ordered[i].t);
    if (t == null) continue;
    if (!pairs.length || (t >= pairs[pairs.length - 1][1] && rel[i] > pairs[pairs.length - 1][0])) pairs.push([rel[i], t]);
  }
  const frames = bundle.frames && bundle.frames.n > 0 ? bundle.frames : null;
  const qpos = frames ? new Float64Array(frames.nq) : null;
  const framesSpan = frames && pairs.length ? Math.max(0, frames.t_last - pairs[pairs.length - 1][1]) : 0;
  const duration = Math.max(meta.duration_s ?? 0, rel.length ? rel[rel.length - 1] : 0) + (meta.duration_s == null ? framesSpan : 0);

  let tRel = 0;
  let idx = 0;
  let playing = false;
  let speed = 1;
  let last = null;
  const timeCbs = [];

  function simAt(t) {
    if (frames && frames.hz) {
      // the frames are on the playback clock: their own sim time is exact
      const x = (t - frames.t_rel0) * frames.hz;
      if (frames.n < 2) return frames.t_first;
      if (x >= 0 && x <= frames.n - 1) {
        const i = Math.min(frames.n - 2, Math.floor(x));
        const f = x - i;
        return frames.data[i * frames.stride] + (frames.data[(i + 1) * frames.stride] - frames.data[i * frames.stride]) * f;
      }
    }
    if (!pairs.length) return frames ? frames.t_first + t : null;
    if (t <= pairs[0][0]) return pairs[0][1] - (pairs[0][0] - t);
    const n = pairs.length;
    if (t >= pairs[n - 1][0]) return pairs[n - 1][1] + (t - pairs[n - 1][0]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const [a, ta] = pairs[lo];
    const [b, tb] = pairs[hi];
    return ta + ((tb - ta) * (t - a)) / (b - a);
  }

  function frameAt(tSim) {
    if (!frames || tSim == null) return null;
    const { data, stride, n, nq } = frames;
    let i;
    if (tSim <= data[0]) i = 0;
    else if (tSim >= data[(n - 1) * stride]) i = n - 1;
    else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (data[mid * stride] <= tSim) lo = mid;
        else hi = mid;
      }
      const ta = data[lo * stride];
      const tb = data[hi * stride];
      const f = tb > ta ? (tSim - ta) / (tb - ta) : 0;
      const oa = lo * stride + 1;
      const ob = hi * stride + 1;
      for (let k = 0; k < nq; k++) qpos[k] = data[oa + k] + (data[ob + k] - data[oa + k]) * f;
      return qpos;
    }
    const o = i * stride + 1;
    for (let k = 0; k < nq; k++) qpos[k] = data[o + k];
    return qpos;
  }

  /** The frame at the playback clock, for frames placed on it (`hz`). */
  function frameAtRel(t) {
    const { data, stride, n, nq } = frames;
    const x = clamp((t - frames.t_rel0) * frames.hz, 0, n - 1);
    const i = Math.min(Math.max(0, n - 2), Math.floor(x));
    const f = n > 1 ? x - i : 0;
    const oa = i * stride + 1;
    const ob = Math.min(n - 1, i + 1) * stride + 1;
    for (let k = 0; k < nq; k++) qpos[k] = data[oa + k] + (data[ob + k] - data[oa + k]) * f;
    return qpos;
  }

  function emitState() {
    handlers.onState?.({ playing, speed });
  }

  const player = {
    t0,
    duration,
    rows: ordered,
    /** Event ticks for the time bar: `[{t, who}]` in seconds from the start. */
    ticks: ordered.map((r, i) => ({ t: rel[i], who: rowActor(r) })).filter((x) => x.who),
    get playing() { return playing; },
    get speed() { return speed; },
    get time() { return tRel; },
    simAt,
    step(nowMs = performance.now()) {
      // animation-frame and timer stamps can interleave by a few ms: the clock never steps back
      if (playing && last != null) tRel = Math.min(duration, tRel + (Math.max(0, nowMs - last) / 1000) * speed);
      last = nowMs;
      if (idx < ordered.length && rel[idx] <= tRel) {
        const due = [];
        while (idx < ordered.length && rel[idx] <= tRel) due.push(ordered[idx++]);
        handlers.onRows?.(due);
      }
      if (playing && tRel >= duration) {
        playing = false;
        emitState();
        handlers.onEnd?.();
      }
      const tSim = simAt(tRel);
      for (const cb of timeCbs) cb(tRel);
      handlers.onTime?.(tRel);
      return { t_rel: tRel, t_wall: t0 + tRel, t_sim: tSim, qpos: frames && frames.hz ? frameAtRel(tRel) : frameAt(tSim), playing, duration };
    },
    play() {
      if (tRel >= duration) player.seek(0);
      playing = true;
      last = null;
      emitState();
    },
    pause() {
      playing = false;
      emitState();
    },
    toggle() {
      if (playing) player.pause();
      else player.play();
    },
    /** The rows handed over so far (by `step` or a seek), in order: what the world looks like at the clock. */
    playedRows() {
      return ordered.slice(0, idx);
    },
    seek(t) {
      tRel = clamp(num(t, 0), 0, duration);
      idx = upperBound(rel, tRel);
      last = null;
      handlers.onSeek?.(tRel, ordered.slice(0, idx));
    },
    setSpeed(n) {
      const v = num(n, 1);
      speed = SPEEDS.includes(v) ? v : 1;
      emitState();
    },
    onTime(cb) {
      timeCbs.push(cb);
      return () => {
        const i = timeCbs.indexOf(cb);
        if (i >= 0) timeCbs.splice(i, 1);
      };
    },
  };
  return player;
}
