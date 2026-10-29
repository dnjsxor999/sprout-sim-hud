// Formatting shared by the reducer (feed lines) and the HUD: numbers, clocks, short text, object references and the
// decision words. Everything here is pure so that the reducer stays deterministic when it imports it.

/** True for a finite number. */
export function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** A finite number from a number or numeric string, else `fallback` (rows carry nulls, NaN-as-null and strings). */
export function num(x, fallback = null) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : fallback;
  if (typeof x === 'string' && x.trim() !== '') {
    const v = Number(x);
    return Number.isFinite(v) ? v : fallback;
  }
  return fallback;
}

/** A plain object (not an array, not null). */
export function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Collapse whitespace and cut to `n` characters with an ellipsis, like report.py `_short`. */
export function short(text, n = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/** Seconds as a clock: 83.4 -> "1:23", 3725 -> "1:02:05" (negative clamps to 0). */
export function fmtClock(s) {
  const v = Math.max(0, Math.floor(num(s, 0)));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const sec = String(v % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Seconds as a clock with tenths: 83.46 -> "1:23.4" (the feed's time column). */
export function fmtClockTenths(s) {
  const v = Math.max(0, num(s, 0));
  const whole = Math.floor(v);
  const tenth = Math.floor((v - whole) * 10);
  return `${fmtClock(whole)}.${tenth}`;
}

export function fmtSec(s, nd = 1) {
  const v = num(s);
  return v == null ? '–' : `${v.toFixed(nd)} s`;
}

export function fmtCm(m, nd = 1) {
  const v = num(m);
  return v == null ? '–' : `${(100 * v).toFixed(nd)} cm`;
}

export function fmtDeg(d, nd = 0) {
  const v = num(d);
  return v == null ? '–' : `${v.toFixed(nd)}°`;
}

export function fmtP(p) {
  const v = num(p);
  return v == null ? '–' : v.toFixed(2);
}

export function fmtBytes(n) {
  const v = num(n, 0);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} kB`;
  return `${v} B`;
}

/** "obj:cylinder_0" -> "cylinder_0", "region:target_0" -> "target_0"; other strings pass through. */
export function refName(ref) {
  const s = String(ref ?? '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** The kind of a perceived reference: "obj", "region", or null. */
export function refKind(ref) {
  const s = String(ref ?? '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : null;
}

/** Bindings as one short phrase: {"hands": "obj:cylinder_0"} -> "hands → obj:cylinder_0". */
export function bindingsText(bindings) {
  if (!isObj(bindings)) return '';
  return Object.entries(bindings)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k} → ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

/** The object a command is bound to (the first `obj:`/`region:` binding), as a bare scene name, or null. */
export function boundName(bindings) {
  if (!isObj(bindings)) return null;
  for (const v of Object.values(bindings)) {
    if (typeof v === 'string' && (v.startsWith('obj:') || v.startsWith('region:')) && !v.endsWith('*')) return refName(v);
  }
  return null;
}

// The decision dimensions the card shows, in reading order, with their short labels and formatters. `waist` is left
// out on purpose: it is a body-level permission, not an object-relative parameter the reader can follow.
const FIELD_ORDER = ['face', 'pinch', 'pad_from_top_m', 'elevation_deg', 'clearance_m', 'point', 'level', 'yaw_deg',
  'via_lift_m', 'speed'];
const FIELD_LABEL = {
  face: 'face', pinch: 'pinch', pad_from_top_m: 'pad', elevation_deg: 'elev', clearance_m: 'clear', point: 'point',
  level: 'level', yaw_deg: 'yaw', via_lift_m: 'lift', speed: 'speed',
};
const GRASP_DEFAULT = ['face', 'pinch', 'pad_from_top_m', 'elevation_deg', 'yaw_deg', 'via_lift_m', 'speed'];

function fieldValue(key, v) {
  switch (key) {
    case 'pad_from_top_m':
    case 'clearance_m':
      return v == null ? 'clip' : fmtCm(v, 1);
    case 'elevation_deg':
    case 'yaw_deg':
      return fmtDeg(num(v, 0));
    case 'via_lift_m':
      return fmtCm(num(v, 0), 0);
    default:
      return v == null ? '–' : String(v);
  }
}

/**
 * The fields of a decision record as `[{key, label, value, conf, exempt}]`: the declared `dimensions` (plus the face
 * of a grasp) when the record lists them, else the grasp's seven. `conf` is the decider's confidence for the field
 * (0..1) or null.
 */
export function decisionFields(decision) {
  if (!isObj(decision)) return [];
  const dims = Array.isArray(decision.dimensions) ? decision.dimensions.map(String) : null;
  let keys;
  if (dims && dims.length) {
    const set = new Set(dims);
    if (set.has('pinch')) set.add('face');
    keys = FIELD_ORDER.filter((k) => set.has(k));
  } else {
    keys = GRASP_DEFAULT.filter((k) => k in decision);
  }
  const conf = isObj(decision.confidence) ? decision.confidence : {};
  const exempt = new Set(Array.isArray(decision.exempt) ? decision.exempt.map(String) : []);
  return keys.map((k) => ({
    key: k,
    label: FIELD_LABEL[k] || k,
    value: fieldValue(k, decision[k]),
    conf: num(conf[k]),
    exempt: exempt.has(k),
  }));
}

/** The decision's lowest confidence (min_confidence, else the minimum over its fields), or null. */
export function decisionConfidence(decision) {
  if (!isObj(decision)) return null;
  const m = num(decision.min_confidence);
  if (m != null) return m;
  if (isObj(decision.confidence)) {
    const vals = Object.values(decision.confidence).map((v) => num(v)).filter((v) => v != null);
    if (vals.length) return Math.min(...vals);
  }
  return null;
}

/** Compact decision words for the feed: "side/clip · pad 2.3 cm · elev 0° · yaw 15° · lift 0 cm · slow (conf 0.58)". */
export function decisionWords(decision) {
  const fields = decisionFields(decision);
  if (!fields.length) return '';
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const bits = [];
  if (byKey.face || byKey.pinch) bits.push([byKey.face?.value, byKey.pinch?.value].filter(Boolean).join('/'));
  for (const f of fields) {
    if (f.key === 'face' || f.key === 'pinch') continue;
    bits.push(f.key === 'speed' || f.key === 'point' || f.key === 'level' ? f.value : `${f.label} ${f.value}`);
  }
  const c = decisionConfidence(decision);
  return bits.join(' · ') + (c != null ? ` (conf ${c.toFixed(2)})` : '');
}
