// The browser viewport (docs/design/WEB_HUD.md section 8.2): the simulator's compiled scene drawn with three.js and
// kept in step with the streamed qpos by MuJoCo WASM's mj_kinematics. It is a kinematic mirror, not a second physics:
// the simulator stays the only authority, and the browser only computes where every geom of the same model is for
// the qpos it is given. On top of the mirror sit the plan overlays of the running motion and object dragging.
//
//   const vp = await createViewport(container, {theme: 'dark'});
//   await vp.loadModel(arrayBuffer);   // -> {nq, ngeom, nbody, nmesh, derivedScene}
//   vp.applyScene(scene); vp.setState(qpos); vp.setPlan(plan); vp.setProgress(phase);
//   vp.applyWorldRow(row); vp.restoreWorld(scene);   // gates and moved region markers (section 4.2)
//   vp.highlightObject(name); vp.onDragObject(cb); vp.setInteractive(bool);
//   vp.cameraPreset('default' | 'front' | 'side' | 'top'); vp.frameScene(); vp.resize(); vp.setTheme(t); vp.dispose();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { classifyGeoms, deriveScene, getMujoco, meshArrays, openModel, robotRoot } from './meshes.js';
import { PlanOverlay } from './overlays.js';
import { ObjectDrag } from './drag.js';

/** Page colours (section 8.1) and the scene tones that go with them: a floor a shade off the background so shadows
 * read on it, a grid that is barely there, and a hemisphere fill tinted like the room. */
const THEMES = Object.freeze({
  dark: { background: '#0b0d10', floor: '#191c22', gridMajor: '#2a3039', gridMinor: '#1a1e24', sky: '#e4ebf7',
    ground: '#1c2027' },
  light: { background: '#f6f7f9', floor: '#e8ebef', gridMajor: '#c6ccd5', gridMinor: '#dadee5', sky: '#ffffff',
    ground: '#b7bdc7' },
});

/** The robot's visual meshes share one matte light grey: the reader should see the robot's posture, not its parts. */
const ROBOT_MATERIAL = Object.freeze({ color: '#d2d5da', roughness: 0.72, metalness: 0.05 });
const WORLD_ROUGHNESS = 0.62;

/** Object feedback: a faint lift on hover (interactive only); for the object the HUD points at, a ring in JEV's teal
 * around its foot, which marks it without changing its colour (the reader matches it against the camera image). Ring
 * sizes in metres, outside the object's footprint. */
const HOVER_EMISSIVE = Object.freeze({ color: '#ffffff', intensity: 0.08 });
const HIGHLIGHT_RING = Object.freeze({ color: '#2dd4bf', gap: 0.012, width: 0.007, lift: 0.002, opacity: 0.95 });

const LIGHTS = Object.freeze({
  hemisphere: 1.45,
  key: 2.4,
  // The key light stands to the robot's front-right, high up: its shadows fall back and to the robot's left, where
  // the default view (from the front-left) sees them on the table and the floor.
  keyAzimuthDeg: -35,
  keyElevationDeg: 58,
  shadowMap: 2048,
  shadowRadius: 4,
  // Shadows ground the robot and the objects without punching black holes into the floor.
  shadowIntensity: 0.72,
  shadowBias: -0.0004,
  shadowNormalBias: 0.02,
});

const FLOOR = Object.freeze({ size: 60, grid: 12, cell: 0.5, gridLift: 0.0008 });

const CAMERA = Object.freeze({ fov: 40, near: 0.02, far: 80, easeMs: 600, fill: 1.0, fogNear: 1.8, fogFar: 7 });

/** Views relative to the robot's heading: azimuth from its forward axis toward its left and elevation above the floor
 * (degrees). 'default' looks from the robot's front-left down at the table, the view the page opens with. */
const PRESETS = Object.freeze({
  default: { az: 40, el: 30 },
  front: { az: 0, el: 12 },
  side: { az: 90, el: 8 },
  top: { az: 180, el: 87 },
});

/** An object counts as standing on a surface when its bottom is within this height of the surface's top. */
const SURFACE_TOL_M = 0.05;
/** A primitive plane without a size is infinite in MuJoCo; it is drawn this large (half-size, metres). */
const INFINITE_PLANE_HALF = 30;

const DEFAULTS = Object.freeze({ theme: 'dark', interactive: false, resumeMs: 300, liveHz: 10, maxPixelRatio: 2 });

const deg = THREE.MathUtils.degToRad;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Unit vector at azimuth az (from +x toward +y) and elevation el above the floor, z up. */
function direction(az, el) {
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
}

/** Camera placement as an orbit around its target: easing in these coordinates swings the camera around the scene
 * instead of cutting through it. */
function orbitOf(position, target) {
  const d = position.clone().sub(target);
  const r = Math.max(1e-6, d.length());
  return { target: target.clone(), r, az: Math.atan2(d.y, d.x), el: Math.asin(clamp(d.z / r, -1, 1)) };
}

function validSurface(s) {
  return !!s && Number.isFinite(s.top_z) && Array.isArray(s.center) && s.center.length >= 2
    && Array.isArray(s.half_size) && s.half_size.length >= 2 && s.half_size.slice(0, 2).every(Number.isFinite);
}

/** A world point in a (possibly yawed) surface's frame. */
function toSurface(s, x, y) {
  const yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const dx = x - s.center[0];
  const dy = y - s.center[1];
  return [c * dx + sn * dy, -sn * dx + c * dy, c, sn];
}

/** Keeps an object of horizontal half-extent margin on the surface: the simulator puts a moved object at its resting
 * height on its own surface whatever the xy, so a drop beyond the edge would leave it floating, then falling. */
function clampToSurface(s, margin, x, y) {
  if (!s) return [x, y];
  const [lx, ly, c, sn] = toSurface(s, x, y);
  const hx = Math.max(0, s.half_size[0] - margin);
  const hy = Math.max(0, s.half_size[1] - margin);
  const cx = clamp(lx, -hx, hx);
  const cy = clamp(ly, -hy, hy);
  return [s.center[0] + c * cx - sn * cy, s.center[1] + sn * cx + c * cy];
}

function primitiveGeometry(kind, size) {
  switch (kind) {
    case 'plane':
      return new THREE.PlaneGeometry(2 * (size[0] || INFINITE_PLANE_HALF), 2 * (size[1] || INFINITE_PLANE_HALF));
    case 'sphere':
      return new THREE.SphereGeometry(size[0], 32, 16);
    case 'capsule': {
      // MuJoCo capsules and cylinders run along their local z, three.js ones along y.
      const g = new THREE.CapsuleGeometry(size[0], 2 * size[1], 8, 24);
      g.rotateX(Math.PI / 2);
      return g;
    }
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 48);
      g.rotateX(Math.PI / 2);
      return g;
    }
    case 'box':
      return new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2]);
    case 'ellipsoid': {
      const g = new THREE.SphereGeometry(1, 32, 16);
      g.scale(size[0], size[1], size[2]);
      return g;
    }
    default:
      return null;
  }
}

function meshGeometry(model, meshId) {
  const { positions, normals, index } = meshArrays(model, meshId);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  if (normals) g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else g.computeVertexNormals();
  return g;
}

class Viewport {
  constructor(container, opts) {
    if (!container || typeof container.appendChild !== 'function') {
      throw new TypeError('createViewport needs a container element');
    }
    this.container = container;
    this.opts = { ...DEFAULTS, ...opts };
    this.theme = THEMES[this.opts.theme] ? this.opts.theme : 'dark';
    this.interactive = !!this.opts.interactive;
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.mirror = null;
    this.robot = null;
    this.geomMeshes = [];
    this.meshByGeom = new Map();
    this._geometries = [];
    this.objects = new Map();
    this.regions = [];
    this.gates = [];
    this.table = null;
    this.surfaces = [];
    this.floorZ = 0;
    this.highlighted = null;
    this.hovered = null;
    this._dragCb = null;
    this._dirty = true;
    this._disposed = false;
    this._userCamera = false;
    this._camAnim = null;
    this._shadowCenter = null;
    this._shadowHalf = 1.5;
    this._size = [0, 0];

    // Start fetching and compiling the WASM now; loadModel awaits the same promise and reports a failure there.
    getMujoco().catch(() => {});

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, this.opts.maxPixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    // three r182's PCFShadowMap is the soft (disk-sampled, radius-controlled) filter; PCFSoftShadowMap is a deprecated
    // alias that only adds a console warning.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.outline = 'none';
    canvas.style.borderRadius = 'inherit'; // follow a rounded container instead of poking out of its corners
    container.appendChild(canvas);
    this.renderer = renderer;

    const theme = THEMES[this.theme];
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.background);
    scene.fog = new THREE.Fog(theme.background, 6, 22);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    camera.up.set(0, 0, 1); // MuJoCo is z-up
    camera.position.set(2.2, 1.7, 1.6);
    this.camera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0.3, 0, 0.6);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.3;
    controls.maxDistance = 14;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // never below the floor
    controls.addEventListener('start', () => {
      this._userCamera = true;
      this._camAnim = null;
    });
    controls.addEventListener('change', () => {
      this._dirty = true;
    });
    controls.update();
    this.controls = controls;

    this.hemi = new THREE.HemisphereLight(theme.sky, theme.ground, LIGHTS.hemisphere);
    this.hemi.position.set(0, 0, 1); // the sky is +z, not three's default +y
    scene.add(this.hemi);
    const key = new THREE.DirectionalLight('#ffffff', LIGHTS.key);
    key.castShadow = true;
    key.shadow.mapSize.set(LIGHTS.shadowMap, LIGHTS.shadowMap);
    key.shadow.radius = LIGHTS.shadowRadius;
    key.shadow.intensity = LIGHTS.shadowIntensity;
    key.shadow.bias = LIGHTS.shadowBias;
    key.shadow.normalBias = LIGHTS.shadowNormalBias;
    scene.add(key);
    scene.add(key.target);
    this.key = key;

    this.floorMat = new THREE.MeshStandardMaterial({ color: theme.floor, roughness: 1, metalness: 0 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR.size, FLOOR.size), this.floorMat);
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    scene.add(this.floor);
    this.grid = null;
    this._buildGrid();

    this.robotMat = new THREE.MeshStandardMaterial(ROBOT_MATERIAL);
    this.mirrorGroup = new THREE.Group();
    this.mirrorGroup.name = 'mirror';
    scene.add(this.mirrorGroup);

    this.ring = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_RING.color, transparent: true, opacity: HIGHLIGHT_RING.opacity, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false }));
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.ring.name = 'highlight-ring';
    this._ringFor = null;
    scene.add(this.ring);

    this.overlay = new PlanOverlay(scene, { theme: this.theme, reducedMotion: this.reducedMotion });
    this.drag = new ObjectDrag(this, { liveHz: this.opts.liveHz });
    this._placeLight(new THREE.Vector3(0.3, 0, 0.5), 1.2);

    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    if (this._ro) this._ro.observe(container);
    this.resize();
    this._frame = this._frame.bind(this);
    this._raf = requestAnimationFrame(this._frame);
  }

  // ---- model and state ------------------------------------------------------------------------------------------

  /** Loads the scene's .mjb and builds one three.js mesh per drawn geom. A file MuJoCo cannot read throws and leaves
   * the current model in place. Returns {nq, ngeom, nbody, nmesh, derivedScene} (derivedScene: a scene dict read off
   * the model alone, for pages without a bridge or bundle; applyScene with the real one replaces it). */
  async loadModel(buffer) {
    const mujoco = await getMujoco();
    if (this._disposed) throw new Error('the viewport was disposed while the model loaded');
    const mirror = openModel(mujoco, buffer);
    this._unloadModel();
    this.mirror = mirror;
    this.robot = robotRoot(mujoco, mirror.model);
    this._buildMeshes(mujoco);
    this._updateMeshes();
    this.floor.position.z = this.floorZ;
    this.grid.position.z = this.floorZ + FLOOR.gridLift;
    this.overlay.floorZ = this.floorZ;
    this._userCamera = false;
    this.cameraPreset('default', { instant: true });
    return { nq: mirror.nq, ngeom: mirror.ngeom, nbody: mirror.nbody, nmesh: mirror.nmesh,
      derivedScene: deriveScene(mujoco, mirror.model) };
  }

  /** Mirrors one qpos (an array or Float64Array of length nq). A frame of the wrong length is ignored with one
   * warning. Returns whether the frame was drawn. */
  setState(qpos) {
    if (!this.mirror || !this.mirror.setQpos(qpos)) return false;
    this._updateMeshes();
    return true;
  }

  /** The scene dict of the bridge or the bundle (section 5.3): which geoms are draggable objects, where the region
   * markers stand this episode (moved like the simulator moves them: model.geom_pos), the table and the surfaces
   * objects rest on. A new scene ends any drag and hold: the episode reset may have moved every object. */
  applyScene(scene) {
    this.drag.cancel();
    for (const rec of this.objects.values()) {
      clearTimeout(rec.releaseTimer);
      if (this.mirror && rec.qposAdr >= 0) this.mirror.release(rec.qposAdr);
      for (const mesh of rec.meshes) {
        mesh.userData.role = 'world';
        mesh.userData.object = null;
        mesh.material.emissive.set(0x000000);
      }
    }
    this.objects.clear();
    this.regions = [];
    this.gates = [];
    this.table = null;
    this.surfaces = [];
    this.hovered = null;
    if (!scene || !this.mirror) {
      this._applyHighlight();
      return;
    }
    if (Number.isFinite(scene.nq) && scene.nq !== this.mirror.nq) {
      console.warn(`viewport: the scene has nq = ${scene.nq} but the model has ${this.mirror.nq}; `
        + 'is it another scene\'s dict?');
    }
    for (const o of Array.isArray(scene.objects) ? scene.objects : []) {
      const ids = Array.isArray(o.geom_ids) ? o.geom_ids : [];
      const meshes = ids.map((id) => this.meshByGeom.get(id)).filter(Boolean);
      if (!o.name || !meshes.length) continue;
      const qposAdr = Number.isInteger(o.qpos_adr) ? o.qpos_adr : -1;
      for (const mesh of meshes) {
        mesh.userData.role = 'object';
        mesh.userData.object = o.name;
      }
      this.objects.set(o.name, { name: o.name, bodyId: o.body_id, qposAdr, meshes, releaseTimer: 0, surface: null,
        margin: 0 });
    }
    // the region markers at their centres and the gates where the dict saw them; whatever a world row moved before
    // goes back first (a new episode, a replay seeking backwards)
    this.mirror.placeScene(scene);
    for (const r of Array.isArray(scene.regions) ? scene.regions : []) {
      if (!r || !Number.isInteger(r.geom_id)) continue;
      const mesh = this.meshByGeom.get(r.geom_id);
      if (mesh) {
        mesh.userData.role = 'region';
        mesh.castShadow = false;
      }
      this.regions.push(r);
    }
    for (const g of Array.isArray(scene.gates) ? scene.gates : []) {
      if (!g || !Number.isInteger(g.geom_id)) continue;
      const mesh = this.meshByGeom.get(g.geom_id);
      // a gate is a wall, not an object: never draggable, and left out of the framing while parked under the floor
      if (mesh) mesh.userData.role = 'gate';
      this.gates.push(g);
    }
    this.table = validSurface(scene.table) ? scene.table : null;
    this.surfaces = [this.table, ...Object.values(scene.surfaces || {})].filter(validSurface);
    this.mirror.refresh();
    this._updateMeshes();
    this._applyHighlight();
    if (!this._userCamera) this.cameraPreset('default', { instant: !this._renderedSinceFraming });
  }

  /** Applies a world row (section 4.2): a `scene/gate` or `scene/object_motion` row that carries `geom_id` and `pos`
   * (and `quat`) puts that geom there, as the simulator did with model.geom_pos. Any other row is ignored. Returns
   * whether a geom moved. */
  applyWorldRow(row) {
    if (!this.mirror || this.mirror.applyWorldRow(row, this.regions) < 0) return false;
    this.mirror.refresh();
    this._updateMeshes();
    return true;
  }

  /** The scene's static geoms as the scene dict states them (region markers at their centres, gates where the dict
   * saw them), undoing every world row applied since; nothing else of applyScene (drags, roles, camera). A replay
   * calls it before it re-applies the world rows up to a seek target, and at an episode start. */
  restoreWorld(scene) {
    if (!this.mirror) return;
    this.mirror.placeScene(scene);
    this.mirror.refresh();
    this._updateMeshes();
  }

  /** World position of a body by name after the last frame, or null (for pages that anchor things to the robot). */
  bodyPosition(name) {
    if (!this.mirror) return null;
    const { mujoco, model } = this.mirror;
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, String(name));
    return id >= 0 ? this.mirror.bodyPos(id) : null;
  }

  // ---- overlays and feedback ------------------------------------------------------------------------------------

  /** Shows a `plan` trace record (section 4.1) or clears the overlays for null. */
  setPlan(plan) {
    if (this.overlay.setPlan(plan)) this._dirty = true;
  }

  /** Moves the progress marker to phase (0..1) along the plan's path; null hides it. */
  setProgress(phase) {
    if (this.overlay.setProgress(phase)) this._dirty = true;
  }

  /** Rings the named object in JEV's teal (the object the pipeline is working on), or clears the ring for null. A
   * name the scene does not know yet is kept and applies once applyScene brings the object. */
  highlightObject(name) {
    this.highlighted = name ? String(name) : null;
    this._applyHighlight();
  }

  /** Registers the drag callback ({name, pos: [x, y, z], live}): live true at most liveHz while dragging, false once
   * on the drop. Returns a function that unregisters it. */
  onDragObject(cb) {
    this._dragCb = typeof cb === 'function' ? cb : null;
    return () => {
      if (this._dragCb === cb) this._dragCb = null;
    };
  }

  /** Dragging needs a simulator to apply the move: off (replay), a drag attempt raises the 'viewport-hint' event. */
  setInteractive(on) {
    this.interactive = !!on;
    if (!this.interactive) {
      this.drag.cancel();
      this.drag.clearHover();
    }
    this._applyHighlight();
  }

  // ---- camera, size, theme --------------------------------------------------------------------------------------

  /** Moves the camera to a named view, fitted to the robot and the table ({instant: true} skips the easing). */
  cameraPreset(name = 'default', { instant = false } = {}) {
    const preset = PRESETS[name] || PRESETS.default;
    const { center, radius } = this._fit();
    const heading = this._robotHeading();
    const dist = this._fitDistance(radius);
    const position = center.clone().addScaledVector(direction(heading + deg(preset.az), deg(preset.el)), dist);
    this._flyTo(position, center, instant);
    this._afterFraming(center, radius, dist);
  }

  /** Refits the view to the robot and the table, keeping the direction the camera looks from. */
  frameScene({ instant = false } = {}) {
    const { center, radius } = this._fit();
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) {
      this.cameraPreset('default', { instant });
      return;
    }
    const dist = this._fitDistance(radius);
    this._flyTo(center.clone().addScaledVector(dir.normalize(), dist), center, instant);
    this._afterFraming(center, radius, dist);
  }

  /** Matches the drawing buffer to the container (the ResizeObserver calls it; a hidden container is skipped). */
  resize() {
    const w = Math.floor(this.container.clientWidth);
    const h = Math.floor(this.container.clientHeight);
    if (w <= 0 || h <= 0 || (w === this._size[0] && h === this._size[1])) return;
    this._size = [w, h];
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._dirty = true;
  }

  setTheme(name) {
    if (!THEMES[name]) return;
    this.theme = name;
    const t = THEMES[name];
    this.scene.background.set(t.background);
    this.scene.fog.color.set(t.background);
    this.floorMat.color.set(t.floor);
    this.hemi.color.set(t.sky);
    this.hemi.groundColor.set(t.ground);
    this._buildGrid();
    this.overlay.setTheme(name);
    this._dirty = true;
  }

  /** Frees everything: the WASM handles (model, data), every three.js geometry, material and the GL context. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._ro) this._ro.disconnect();
    this.drag.dispose();
    this._unloadModel();
    this.overlay.dispose();
    this.controls.dispose();
    this.floor.geometry.dispose();
    this.floorMat.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.robotMat.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.key.shadow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  _frame(now) {
    this._raf = requestAnimationFrame(this._frame);
    let changed = this._dirty;
    if (this._camAnim) {
      this._stepCamera(now);
      changed = true;
    }
    if (this.controls.update()) changed = true;
    if (this.overlay.update(now)) changed = true;
    // Rendering only when something changed keeps an idle page (a paused replay) from burning the GPU.
    if (changed) {
      this._dirty = false;
      this.renderer.render(this.scene, this.camera);
      this._renderedSinceFraming = true;
    }
  }

  _buildGrid() {
    if (this.grid) {
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid.removeFromParent();
    }
    const t = THEMES[this.theme];
    const grid = new THREE.GridHelper(FLOOR.grid, Math.round(FLOOR.grid / FLOOR.cell), t.gridMajor, t.gridMinor);
    grid.rotation.x = Math.PI / 2; // GridHelper lies in three's xz plane; the floor is MuJoCo's xy plane
    grid.position.z = this.floorZ + FLOOR.gridLift;
    grid.material.transparent = true;
    grid.material.opacity = 0.9;
    grid.material.depthWrite = false;
    grid.material.toneMapped = false;
    grid.name = 'grid';
    this.grid = grid;
    this.scene.add(grid);
  }

  _buildMeshes(mujoco) {
    const { model, data } = this.mirror;
    const { geoms, skipped } = classifyGeoms(mujoco, model);
    if (skipped.length) {
      console.warn(`viewport: ${skipped.length} geoms of a kind the viewport cannot draw are skipped`, skipped);
    }
    const meshes = new Map();
    const primitives = new Map();
    this.floorZ = 0;
    for (const g of geoms) {
      if (g.role === 'floor') {
        // The viewport's own floor (large, with a grid) stands in for the model's plane, at its height.
        this.floorZ = data.geom_xpos[3 * g.id + 2];
        continue;
      }
      let geometry;
      if (g.kind === 'mesh') {
        geometry = meshes.get(g.dataid);
        if (!geometry) {
          geometry = meshGeometry(model, g.dataid);
          meshes.set(g.dataid, geometry);
        }
      } else {
        const key = `${g.kind}:${g.size.join(',')}`;
        geometry = primitives.get(key);
        if (!geometry) {
          geometry = primitiveGeometry(g.kind, g.size);
          primitives.set(key, geometry);
        }
      }
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = g.role === 'robot' ? this.robotMat : this._worldMaterial(g.rgba);
      const mesh = new THREE.Mesh(geometry, material);
      // MuJoCo computes the world pose of every geom; three.js must not recompose it from position/rotation.
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = g.kind !== 'plane';
      mesh.receiveShadow = true;
      mesh.name = g.name;
      mesh.userData = { geom: g.id, body: g.body, role: g.role, object: null };
      this.mirrorGroup.add(mesh);
      this.geomMeshes.push(mesh);
      this.meshByGeom.set(g.id, mesh);
    }
    this._geometries = [...meshes.values(), ...primitives.values()];
  }

  _worldMaterial(rgba) {
    const color = new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.SRGBColorSpace);
    const transparent = rgba[3] < 1;
    return new THREE.MeshStandardMaterial({ color, roughness: WORLD_ROUGHNESS, metalness: 0, transparent,
      opacity: rgba[3], depthWrite: !transparent });
  }

  /** Writes the mirror's geom poses into the meshes: geom_xpos and the row-major geom_xmat make the world matrix. */
  _updateMeshes() {
    const m = this.mirror;
    if (!m) return;
    const xpos = m.data.geom_xpos;
    const xmat = m.data.geom_xmat;
    const ov = m.posOverride;
    const mv = m.matOverride;
    for (const mesh of this.geomMeshes) {
      const id = mesh.userData.geom;
      const p = 3 * id;
      const o = ov.size ? ov.get(id) : undefined;
      const om = mv.size ? mv.get(id) : undefined;
      const R = om || xmat;
      const r = om ? 0 : 9 * id;
      mesh.matrix.set(
        R[r], R[r + 1], R[r + 2], o ? o[0] : xpos[p],
        R[r + 3], R[r + 4], R[r + 5], o ? o[1] : xpos[p + 1],
        R[r + 6], R[r + 7], R[r + 8], o ? o[2] : xpos[p + 2],
        0, 0, 0, 1,
      );
      mesh.matrixWorldNeedsUpdate = true;
    }
    this._followRobotWithShadow();
    this._placeRing();
    this._dirty = true;
  }

  /** Keeps the highlight ring at the highlighted object's foot (it follows a dragged or carried object). The ring is
   * rebuilt only when the highlight moves to another object, whose footprint sets its radius. */
  _placeRing() {
    const rec = this.highlighted ? this.objects.get(this.highlighted) : null;
    if (!rec) {
      this.ring.visible = false;
      this._ringFor = null;
      return;
    }
    const box = this._objectBox(rec);
    if (this._ringFor !== rec) {
      const r = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2 + HIGHLIGHT_RING.gap;
      this.ring.geometry.dispose();
      this.ring.geometry = new THREE.RingGeometry(r, r + HIGHLIGHT_RING.width, 72);
      this._ringFor = rec;
    }
    this.ring.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z + HIGHLIGHT_RING.lift);
    this.ring.visible = true;
  }

  _unloadModel() {
    this.drag.cancel();
    for (const rec of this.objects.values()) clearTimeout(rec.releaseTimer);
    this.objects.clear();
    this.regions = [];
    this.gates = [];
    this.table = null;
    this.surfaces = [];
    this.hovered = null;
    for (const mesh of this.geomMeshes) {
      mesh.removeFromParent();
      if (mesh.material !== this.robotMat) mesh.material.dispose();
    }
    for (const g of this._geometries) g.dispose();
    this.geomMeshes = [];
    this.meshByGeom.clear();
    this._geometries = [];
    this.overlay.clear();
    if (this.mirror) this.mirror.dispose();
    this.mirror = null;
    this.robot = null;
    this._dirty = true;
  }

  _robotHeading() {
    const r = this.robot;
    if (!this.mirror || !r || r.body < 0) return 0;
    const m = this.mirror.bodyMat(r.body);
    // The body's x axis (the first column of the row-major matrix) projected on the floor is the robot's forward.
    return Math.hypot(m[0], m[3]) > 1e-6 ? Math.atan2(m[3], m[0]) : 0;
  }

  /** The box the camera frames: the robot, the objects and the table (top and legs, down to the floor); without a
   * scene dict, every drawn world geom of a sensible size stands in for the table. */
  _fit() {
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    const add = (mesh) => {
      mesh.updateMatrixWorld();
      part.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      return part;
    };
    for (const mesh of this.geomMeshes) {
      const role = mesh.userData.role;
      if (role === 'robot' || role === 'object') box.union(add(mesh));
      else if (!this.table && role === 'world') {
        const b = add(mesh);
        // a geom parked under the floor (an open gate the scene dict has not named yet) is not part of the view
        if (b.max.x - b.min.x < 4 && b.max.y - b.min.y < 4 && b.max.z > this.floorZ) box.union(b);
      }
    }
    if (this.table) {
      const t = this.table;
      const yaw = Number.isFinite(t.yaw) ? t.yaw : 0;
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const lx = sx * t.half_size[0];
        const ly = sy * t.half_size[1];
        box.expandByPoint(new THREE.Vector3(t.center[0] + c * lx - sn * ly, t.center[1] + sn * lx + c * ly, t.top_z));
      }
      box.expandByPoint(new THREE.Vector3(t.center[0], t.center[1], this.floorZ));
    }
    if (box.isEmpty()) {
      box.set(new THREE.Vector3(-0.5, -0.5, this.floorZ), new THREE.Vector3(0.8, 0.5, this.floorZ + 1.3));
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.2, box.getBoundingSphere(new THREE.Sphere()).radius);
    return { center, radius };
  }

  _fitDistance(radius) {
    const v = deg(this.camera.fov);
    const h = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect);
    return (radius * CAMERA.fill) / Math.sin(Math.min(v, h) / 2);
  }

  _flyTo(position, target, instant) {
    if (instant || this.reducedMotion) {
      this._camAnim = null;
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.controls.update();
      this._renderedSinceFraming = false;
    } else {
      this._camAnim = { from: orbitOf(this.camera.position, this.controls.target), to: orbitOf(position, target),
        start: performance.now(), dur: CAMERA.easeMs };
    }
    this._dirty = true;
  }

  _stepCamera(now) {
    const a = this._camAnim;
    const t = Math.min(1, (now - a.start) / a.dur);
    const e = easeInOutCubic(t);
    let daz = a.to.az - a.from.az;
    daz = Math.atan2(Math.sin(daz), Math.cos(daz)); // the short way round
    const target = a.from.target.clone().lerp(a.to.target, e);
    const r = a.from.r + (a.to.r - a.from.r) * e;
    const el = a.from.el + (a.to.el - a.from.el) * e;
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(direction(a.from.az + daz * e, el), r);
    if (t >= 1) this._camAnim = null;
  }

  _afterFraming(center, radius, dist) {
    this._placeLight(center, radius);
    // Fog only fades the far floor into the background; it starts well behind the framed scene.
    this.scene.fog.near = dist * CAMERA.fogNear;
    this.scene.fog.far = dist * CAMERA.fogFar;
  }

  _placeLight(center, radius) {
    const key = this.key;
    const heading = this._robotHeading();
    key.target.position.copy(center);
    key.target.updateMatrixWorld();
    const toLight = direction(heading + deg(LIGHTS.keyAzimuthDeg), deg(LIGHTS.keyElevationDeg));
    key.position.copy(center).addScaledVector(toLight, radius * 4);
    const half = radius * 1.3;
    const cam = key.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = radius * 0.5;
    cam.far = radius * 9;
    cam.updateProjectionMatrix();
    this._shadowCenter = center.clone();
    this._shadowHalf = half;
  }

  /** Keeps the robot inside the shadow camera when it walks away from where the scene was framed. */
  _followRobotWithShadow() {
    if (!this._shadowCenter || !this.robot || this.robot.body < 0) return;
    const p = this.mirror.bodyPos(this.robot.body);
    const dx = p[0] - this._shadowCenter.x;
    const dy = p[1] - this._shadowCenter.y;
    if (Math.hypot(dx, dy) < 0.6 * this._shadowHalf) return;
    const center = new THREE.Vector3(p[0], p[1], this._shadowCenter.z);
    this._placeLight(center, this._shadowHalf / 1.3);
  }

  _applyHighlight() {
    for (const rec of this.objects.values()) {
      const lit = rec.name === this.hovered && this.interactive ? HOVER_EMISSIVE : null;
      for (const mesh of rec.meshes) {
        mesh.material.emissive.set(lit ? lit.color : 0x000000);
        mesh.material.emissiveIntensity = lit ? lit.intensity : 1;
      }
    }
    if (this.mirror) this._placeRing();
    this._dirty = true;
  }

  // ---- hooks of ObjectDrag ----------------------------------------------------------------------------------------

  _pickables() {
    const out = [];
    for (const rec of this.objects.values()) out.push(...rec.meshes);
    return out;
  }

  _objectBox(rec) {
    const box = new THREE.Box3();
    const part = new THREE.Box3();
    for (const mesh of rec.meshes) {
      mesh.updateMatrixWorld();
      box.union(part.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    return box;
  }

  /** The surface the object stands on: the closest top just under its bottom that it is above. */
  _surfaceUnder(x, y, bottom) {
    let best = null;
    let bestDz = SURFACE_TOL_M;
    for (const s of this.surfaces) {
      const dz = Math.abs(bottom - s.top_z);
      if (dz > bestDz) continue;
      const [lx, ly] = toSurface(s, x, y);
      if (Math.abs(lx) > s.half_size[0] || Math.abs(ly) > s.half_size[1]) continue;
      best = s;
      bestDz = dz;
    }
    return best;
  }

  /** Starts holding an object at its mirrored pose; returns its centre [x, y, z], or null when it cannot be held. */
  _beginHold(name) {
    const rec = this.objects.get(name);
    const m = this.mirror;
    if (!rec || !m) return null;
    if (!(rec.qposAdr >= 0 && rec.qposAdr + 7 <= m.nq)) {
      console.warn(`viewport: ${name} has no free joint in the scene dict (qpos_adr); it cannot be dragged`);
      return null;
    }
    clearTimeout(rec.releaseTimer);
    const pose = m.freePose(rec.qposAdr);
    m.hold(rec.qposAdr, pose);
    const box = this._objectBox(rec);
    rec.margin = Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2;
    rec.surface = this._surfaceUnder(pose[0], pose[1], box.min.z);
    return [pose[0], pose[1], pose[2]];
  }

  /** Moves the held object's centre to (x, y), kept on its surface; returns the centre [x, y, z] it got. */
  _moveHold(name, x, y) {
    const rec = this.objects.get(name);
    const pose = rec && this.mirror ? this.mirror.heldPose(rec.qposAdr) : null;
    if (!pose) return null;
    const [cx, cy] = clampToSurface(rec.surface, rec.margin, x, y);
    pose[0] = cx;
    pose[1] = cy;
    this.mirror.refresh();
    this._updateMeshes();
    return [cx, cy, pose[2]];
  }

  /** Ends a hold. After a drop the object stays where it was dropped until the stream shows it there (the simulator
   * has applied the move) or resumeMs pass, whichever comes first; a click without movement lets go at once. */
  _endHold(name, dropped) {
    const rec = this.objects.get(name);
    const m = this.mirror;
    if (!rec || !m) return;
    if (!dropped) {
      if (m.release(rec.qposAdr)) {
        m.refresh();
        this._updateMeshes();
      }
      return;
    }
    m.releaseWhenCaughtUp(rec.qposAdr);
    clearTimeout(rec.releaseTimer);
    rec.releaseTimer = setTimeout(() => {
      if (m !== this.mirror || !m.release(rec.qposAdr)) return;
      m.refresh();
      this._updateMeshes();
    }, this.opts.resumeMs);
  }

  _emitDrag(event) {
    if (!this._dragCb) return;
    try {
      this._dragCb(event);
    } catch (err) {
      console.error('viewport: the drag callback failed', err);
    }
  }

  _hint(text) {
    this.container.dispatchEvent(new CustomEvent('viewport-hint', { detail: text, bubbles: true }));
  }

  _setHover(name) {
    this.hovered = name;
    this._applyHighlight();
  }
}

/** Creates the viewport inside container (it fills it; give the container a size). The WASM starts loading here and
 * loadModel waits for it. Options: theme ('dark' | 'light'), interactive (false), resumeMs (300: how long a dropped
 * object ignores the stream at most), liveHz (10: the rate of live drag events), maxPixelRatio (2). */
export async function createViewport(container, opts = {}) {
  return new Viewport(container, opts);
}
