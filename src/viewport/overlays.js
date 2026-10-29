// The plan overlays of the viewport (docs/design/WEB_HUD.md sections 4.1, 8.2 and 11.3): where the running motion
// goes. A hand motion shows the clip as placed before the edit (the ghost: a dashed grey line) and as JEV edited it
// for this scene (a thin teal tube with its control points and a ring at the goal). A new plan is staged so the edit
// can be followed: the ghost alone first (the stored motion as placed), then the tube morphs out of it into the edit
// (a re-edit morphs from what was on screen and leaves the previous edit behind as a fading trace), then the control
// points and the goal ring settle on the result; the edit reads as a movement rather than a swap. A base motion is a
// flat arrow on the floor; a gaze motion draws nothing. The amber marker is the engine's progress along the path.

import * as THREE from 'three';

/** Actor colours of the page (section 8.1): JEV's edit in teal, the engine's progress in amber, the ghost in the
 * muted text grey of the theme. */
const COLORS = Object.freeze({
  edit: '#2dd4bf',
  point: '#99f6e4',
  engine: '#f59e0b',
  ghost: { dark: '#9aa3b2', light: '#7d8696' },
});

/** Sizes in metres: thin enough to read as an annotation over a 1.2 m robot, thick enough to see from 3 m. */
const SIZE = Object.freeze({
  tube: 0.004,
  point: 0.0075,
  goalRadius: 0.032,
  goalTube: 0.0022,
  marker: 0.011,
  halo: 0.022,
  dash: 0.014,
  gap: 0.009,
  arrowZ: 0.01, // the base arrow lies this far above the floor (section 4.1: z = 0.01)
  arrowShaft: 0.018,
  arrowHead: 0.055,
  arrowHeadLen: 0.14,
  turnRadius: 0.34,
  markerLift: 0.015,
});

/** Opacity of the occluded pass: the part of a path behind the robot or under the table still shows, faintly, so the
 * plan reads from any view (the default view looks at the robot's left side; most reaches use the right hand). */
const XRAY = Object.freeze({ tube: 0.3, marker: 0.45, arrow: 0.2 });

/** The edit's choreography (section 11.3). The hold shows the ghost alone long enough to be read as "the motion as
 * stored" before anything teal moves; the morph is slow enough to follow the edit as a movement. MORPH_MS is the
 * page's morph time (util/easing.js); the overlay keeps its own copy so its timing does not depend on the HUD module. */
const HOLD_MS = 500;
const MORPH_MS = 1200;
/** A re-edit's trace: the previous edited curve in the same teal, faint. It waits at full strength through the hold
 * and fades out from the morph's start, so it is still there while the new curve moves away from it, and it outlasts
 * the morph slightly (the end state is seen next to where the edit was). */
const TRACE = Object.freeze({ opacity: 0.35, fadeMs: 1500 });
/** A base plan shorter than this is a turn on the spot, drawn as an arc around the robot. */
const MIN_STRAIGHT_M = 0.05;
const MIN_TURN_RAD = 0.05;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Valid [x, y, z] entries of a plan array as vectors; malformed entries are dropped, not drawn at the origin. */
function toPoints(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (Array.isArray(p) && p.length >= 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) {
      out.push(new THREE.Vector3(p[0], p[1], p[2]));
    }
  }
  return out;
}

function finiteNumbers(list, n) {
  return Array.isArray(list) && list.length >= n && list.slice(0, n).every(Number.isFinite);
}

/** A polyline resampled to n points, uniformly in sample index (plan curves are sampled uniformly in phase). */
function resample(points, n) {
  if (points.length === n) return points.map((p) => p.clone());
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : (i / (n - 1)) * (points.length - 1);
    const k = Math.min(Math.floor(u), points.length - 2);
    out.push(points[k].clone().lerp(points[k + 1], u - k));
  }
  return out;
}

/** The edited path's tube through points (the morph rebuilds it every frame; a re-edit's trace is built the same way,
 * so it lies exactly where the tube was). */
function tubeGeometry(points) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  return new THREE.TubeGeometry(curve, Math.max(64, 4 * points.length), SIZE.tube, 8, false);
}

/** ?still=1 pages (index.html sets the class before anything renders) are captured with no frame between a change
 * and the screenshot, so a plan must show its final state at once. */
function isStillPage() {
  return typeof document !== 'undefined' && !!document.documentElement
    && document.documentElement.classList.contains('still');
}

/** Adds a pass of mesh that ignores depth (drawn last, faint), sharing its geometry and following its transform. */
function addXray(mesh, material) {
  const xray = new THREE.Mesh(mesh.geometry, material);
  xray.renderOrder = 10;
  mesh.add(xray);
  mesh.userData.xray = xray;
}

/** Replaces a mesh's geometry (disposing the old one) and keeps its occluded pass on the same geometry. */
function setGeometry(mesh, geometry) {
  mesh.geometry.dispose();
  mesh.geometry = geometry;
  if (mesh.userData.xray) mesh.userData.xray.geometry = geometry;
}

/** What makes two plan records the same record: a replay seek re-reduces the rows and hands the same plan back,
 * which must not restart the morph. */
function signature(plan) {
  const e = Array.isArray(plan.edited) ? plan.edited : [];
  return JSON.stringify([plan.channel, plan.motion, plan.arm, plan.t_wall, plan.t, plan.reedit,
    e.length, e[0], e[e.length - 1], plan.start, plan.goal]);
}

function straightArrowShape(length) {
  const w = SIZE.arrowShaft;
  const hw = SIZE.arrowHead;
  const h = Math.min(SIZE.arrowHeadLen, 0.45 * length);
  const s = new THREE.Shape();
  s.moveTo(0, -w);
  s.lineTo(length - h, -w);
  s.lineTo(length - h, -hw);
  s.lineTo(length, 0);
  s.lineTo(length - h, hw);
  s.lineTo(length - h, w);
  s.lineTo(0, w);
  s.closePath();
  return s;
}

/** An arc arrow around the origin from angle a0 by da (a turn on the spot), in the floor plane. */
function arcArrowShape(radius, a0, da) {
  const w = SIZE.arrowShaft;
  const hw = SIZE.arrowHead;
  const dir = Math.sign(da) || 1;
  const headAng = Math.min(SIZE.arrowHeadLen / radius, 0.45 * Math.abs(da)) * dir;
  const a1 = a0 + da;
  const ab = a1 - headAng;
  const steps = Math.max(8, Math.ceil(Math.abs(da) / 0.05));
  const at = (r, a) => new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push(at(radius + w, a0 + ((ab - a0) * i) / steps));
  pts.push(at(radius + hw, ab), at(radius, a1), at(radius - hw, ab));
  for (let i = steps; i >= 0; i--) pts.push(at(radius - w, a0 + ((ab - a0) * i) / steps));
  return new THREE.Shape(pts);
}

export class PlanOverlay {
  constructor(parent, { theme = 'dark', reducedMotion = false } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'plan-overlay';
    parent.add(this.group);
    this.reducedMotion = reducedMotion;
    this.floorZ = 0;
    this.plan = null;
    this._sig = null;
    // The edited points on screen: the tube's (mid-morph: the interpolated ones) or, while a re-edit holds, the
    // trace's. A re-edit of the same motion morphs from them; null while no edit of the current motion is shown.
    this._shown = null;
    this._anim = null; // the running choreography of a new hand plan: {start, from, to, settled, trace}
    this._marks = null; // the current hand plan's control points and goal ring: {dots, goal}
    this._path = null; // the points the progress marker runs along
    this._phase = null;

    // Overlays are annotations, not objects in the room: unlit and outside tone mapping, so they keep the page's
    // exact actor colours under any lighting.
    this.mats = {
      ghost: new THREE.LineDashedMaterial({ color: COLORS.ghost[theme] || COLORS.ghost.dark, dashSize: SIZE.dash,
        gapSize: SIZE.gap, transparent: true, opacity: 0.9, toneMapped: false }),
      tube: new THREE.MeshBasicMaterial({ color: COLORS.edit, toneMapped: false }),
      point: new THREE.MeshBasicMaterial({ color: COLORS.point, toneMapped: false }),
      goal: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true, opacity: 0.9, toneMapped: false }),
      arrow: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true, opacity: 0.6, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false }),
      marker: new THREE.MeshBasicMaterial({ color: COLORS.engine, toneMapped: false }),
      halo: new THREE.MeshBasicMaterial({ color: COLORS.engine, transparent: true, opacity: 0.22, depthWrite: false,
        toneMapped: false }),
      tubeXray: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true, opacity: XRAY.tube,
        depthTest: false, depthWrite: false, toneMapped: false }),
      markerXray: new THREE.MeshBasicMaterial({ color: COLORS.engine, transparent: true, opacity: XRAY.marker,
        depthTest: false, depthWrite: false, toneMapped: false }),
      arrowXray: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true, opacity: XRAY.arrow,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
      // The trace is the tube at a fraction of its strength, its occluded pass included (a right-hand path mostly
      // lies behind the robot in the default view).
      trace: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true, opacity: TRACE.opacity,
        depthWrite: false, toneMapped: false }),
      traceXray: new THREE.MeshBasicMaterial({ color: COLORS.edit, transparent: true,
        opacity: TRACE.opacity * XRAY.tube, depthTest: false, depthWrite: false, toneMapped: false }),
    };
    this.geos = {
      point: new THREE.SphereGeometry(SIZE.point, 16, 10),
      goal: new THREE.TorusGeometry(SIZE.goalRadius, SIZE.goalTube, 8, 64),
      marker: new THREE.SphereGeometry(SIZE.marker, 20, 14),
      halo: new THREE.SphereGeometry(SIZE.halo, 20, 14),
    };

    this.ghost = new THREE.Line(new THREE.BufferGeometry(), this.mats.ghost);
    this.tube = new THREE.Mesh(new THREE.BufferGeometry(), this.mats.tube);
    this.trace = new THREE.Mesh(new THREE.BufferGeometry(), this.mats.trace);
    this.goal = new THREE.Mesh(this.geos.goal, this.mats.goal);
    this.arrow = new THREE.Mesh(new THREE.BufferGeometry(), this.mats.arrow);
    this.marker = new THREE.Mesh(this.geos.marker, this.mats.marker);
    this.marker.add(new THREE.Mesh(this.geos.halo, this.mats.halo));
    addXray(this.tube, this.mats.tubeXray);
    addXray(this.trace, this.mats.traceXray);
    addXray(this.marker, this.mats.markerXray);
    addXray(this.arrow, this.mats.arrowXray);
    this.points = [];
    for (const obj of [this.ghost, this.tube, this.trace, this.goal, this.arrow, this.marker]) {
      obj.visible = false;
      obj.renderOrder = 2;
      this.group.add(obj);
    }
    this.arrow.renderOrder = 1;
  }

  /** Shows a plan record (a `plan` trace row), or clears the overlays for null. Returns whether anything changed. */
  setPlan(plan, now = performance.now()) {
    if (!plan || typeof plan !== 'object') {
      if (!this.plan) return false;
      this.clear();
      return true;
    }
    const sig = signature(plan);
    if (sig === this._sig) return false;
    const prev = this.plan;
    this._sig = sig;
    this.plan = plan;
    if (plan.channel === 'hand') this._showHand(plan, prev, now);
    else if (plan.channel === 'base') this._showBase(plan);
    else {
      // Gaze (and any channel without a path): nothing to draw, and nothing of the previous plan may linger, or
      // the progress marker would run along a path that is no longer the running motion's.
      this._shown = null;
      this._anim = null;
      this._marks = null;
      this._path = null;
      this._hideAll();
    }
    this._placeMarker();
    return true;
  }

  /** Moves the progress marker to phase (0..1) along the path; null or a non-number hides it. */
  setProgress(phase) {
    const next = phase == null || !Number.isFinite(+phase) ? null : Math.min(1, Math.max(0, +phase));
    if (next === this._phase) return false;
    this._phase = next;
    this._placeMarker();
    return true;
  }

  /** Advances the choreography of a new hand plan (hold, morph, trace fade); returns true when the frame changed
   * (the viewport renders only then). */
  update(now) {
    const a = this._anim;
    if (!a) return false;
    // Time since the morph began. The frame's stamp can precede the setPlan call that started the choreography,
    // hence the clamp; during the hold nothing moves, so there is nothing to render.
    const t = Math.max(0, now - a.start) - HOLD_MS;
    if (t < 0) return false;
    if (!a.settled) {
      const u = MORPH_MS > 0 ? Math.min(1, t / MORPH_MS) : 1;
      const e = easeInOutCubic(u);
      this._drawTube(a.from.map((p, i) => p.clone().lerp(a.to[i], e)));
      this.tube.visible = true;
      if (u >= 1) {
        // The control points and the goal belong to the finished edit: they appear once the curve has settled.
        a.settled = true;
        this._setMarks(true);
      }
    }
    if (a.trace) {
      const k = 1 - t / TRACE.fadeMs;
      if (k > 0) {
        this._fadeTrace(k);
      } else {
        this.trace.visible = false;
        a.trace = false;
      }
    }
    if (a.settled && !a.trace) this._anim = null;
    return true;
  }

  setTheme(theme) {
    this.mats.ghost.color.set(COLORS.ghost[theme] || COLORS.ghost.dark);
  }

  clear() {
    this.plan = null;
    this._sig = null;
    this._shown = null;
    this._anim = null;
    this._marks = null;
    this._path = null;
    this._hideAll();
  }

  dispose() {
    this.clear();
    for (const obj of [this.ghost, this.tube, this.trace, this.arrow]) obj.geometry.dispose();
    for (const g of Object.values(this.geos)) g.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.group.removeFromParent();
  }

  _hideAll() {
    for (const obj of [this.ghost, this.tube, this.trace, this.goal, this.arrow, this.marker]) obj.visible = false;
    for (const p of this.points) p.visible = false;
  }

  _showHand(plan, prev, now) {
    const ghost = toPoints(plan.ghost);
    const edited = toPoints(plan.edited);
    this.arrow.visible = false;
    if (edited.length < 2) {
      this._hideAll();
      this._anim = null;
      this._marks = null;
      this._path = null;
      this._shown = null;
      return;
    }
    if (ghost.length >= 2) {
      this.ghost.geometry.dispose();
      this.ghost.geometry = new THREE.BufferGeometry().setFromPoints(ghost);
      this.ghost.computeLineDistances();
      this.ghost.visible = true;
    } else {
      this.ghost.visible = false;
    }
    // A re-edit of the motion on screen morphs from what is shown (even mid-morph); a new motion grows out of its
    // ghost, which is the edit itself made visible.
    const same = prev && prev.channel === 'hand' && prev.motion === plan.motion
      && (prev.arm ?? null) === (plan.arm ?? null) && this._shown;
    // Reduced motion skips the hold and the morph, a ?still=1 capture would never see them, and a new motion without
    // a ghost has nothing to hold on or grow from: all three show the final state at once.
    const instant = this.reducedMotion || isStillPage() || (!same && ghost.length < 2);

    const ctrl = toPoints(plan.points);
    while (this.points.length < ctrl.length) {
      const dot = new THREE.Mesh(this.geos.point, this.mats.point);
      dot.renderOrder = 3;
      dot.visible = false;
      this.group.add(dot);
      this.points.push(dot);
    }
    ctrl.forEach((p, i) => this.points[i].position.copy(p));
    const goal = finiteNumbers(plan.goal, 3) ? plan.goal : null;
    if (goal) this.goal.position.set(goal[0], goal[1], goal[2]);
    this._marks = { dots: ctrl.length, goal: !!goal };
    // The marker rides the newest path from the start: the engine runs this plan even while its edit is staged.
    const path = toPoints(plan.path);
    this._path = path.length >= 2 ? path : edited;

    if (instant) {
      this._anim = null;
      this.trace.visible = false;
      this._drawTube(edited);
      this.tube.visible = true;
      this._setMarks(true);
      return;
    }
    const from = resample(same ? this._shown : ghost, edited.length);
    if (same) {
      // What was on screen stays behind as the trace: the tube as drawn (mid-morph too) or, when a re-edit arrives
      // during another one's hold, the trace already there; this._shown holds either and keeps it through the hold.
      setGeometry(this.trace, tubeGeometry(this._shown));
      this._fadeTrace(1);
      this.trace.visible = true;
    } else {
      this.trace.visible = false;
      this._shown = null; // nothing of this motion's edit is on screen until its morph starts
    }
    // The hold: the ghost alone (and a re-edit's trace); the tube, its control points and the goal ring come with
    // the morph (update()).
    this.tube.visible = false;
    this._setMarks(false);
    this._anim = { start: now, from, to: edited, settled: false, trace: !!same };
  }

  /** Draws the edited tube through points and records them as what is on screen. */
  _drawTube(points) {
    this._shown = points;
    setGeometry(this.tube, tubeGeometry(points));
  }

  /** Shows or hides the current hand plan's control points and goal ring. */
  _setMarks(visible) {
    const m = this._marks;
    this.points.forEach((dot, i) => {
      dot.visible = visible && !!m && i < m.dots;
    });
    this.goal.visible = visible && !!m && m.goal;
  }

  /** Sets the trace's strength on both of its passes: 1 as it appears, towards 0 as it fades. */
  _fadeTrace(k) {
    this.mats.trace.opacity = TRACE.opacity * k;
    this.mats.traceXray.opacity = TRACE.opacity * XRAY.tube * k;
  }

  _showBase(plan) {
    const s = plan.start;
    const g = plan.goal;
    for (const obj of [this.ghost, this.tube, this.trace, this.goal]) obj.visible = false;
    for (const p of this.points) p.visible = false;
    this._shown = null;
    this._anim = null;
    this._marks = null;
    if (!finiteNumbers(s, 3) || !finiteNumbers(g, 2)) {
      this.arrow.visible = false;
      this._path = null;
      return;
    }
    const [x, y, yaw] = s;
    const dyaw = Number.isFinite(g[2]) ? g[2] : 0;
    // The goal is a displacement in the robot's heading at the start; the floor arrow is in the world.
    const c = Math.cos(yaw);
    const sn = Math.sin(yaw);
    const ex = x + c * g[0] - sn * g[1];
    const ey = y + sn * g[0] + c * g[1];
    const z = this.floorZ + SIZE.arrowZ;
    const lift = z + SIZE.markerLift;
    const length = Math.hypot(ex - x, ey - y);
    if (length >= MIN_STRAIGHT_M) {
      setGeometry(this.arrow, new THREE.ShapeGeometry(straightArrowShape(length)));
      this.arrow.position.set(x, y, z);
      this.arrow.rotation.set(0, 0, Math.atan2(ey - y, ex - x));
      this._path = [new THREE.Vector3(x, y, lift), new THREE.Vector3(ex, ey, lift)];
    } else if (Math.abs(dyaw) >= MIN_TURN_RAD) {
      const r = SIZE.turnRadius;
      setGeometry(this.arrow, new THREE.ShapeGeometry(arcArrowShape(r, yaw, dyaw)));
      this.arrow.position.set(x, y, z);
      this.arrow.rotation.set(0, 0, 0);
      const n = 24;
      this._path = Array.from({ length: n + 1 }, (_, i) => {
        const a = yaw + (dyaw * i) / n;
        return new THREE.Vector3(x + r * Math.cos(a), y + r * Math.sin(a), lift);
      });
    } else {
      setGeometry(this.arrow, new THREE.BufferGeometry());
      this.arrow.visible = false;
      this._path = null;
      return;
    }
    this.arrow.visible = true;
  }

  _placeMarker() {
    const path = this._path;
    if (!path || path.length < 2 || this._phase == null) {
      this.marker.visible = false;
      return;
    }
    const u = this._phase * (path.length - 1);
    const k = Math.min(Math.floor(u), path.length - 2);
    this.marker.position.copy(path[k]).lerp(path[k + 1], u - k);
    this.marker.visible = true;
  }
}
