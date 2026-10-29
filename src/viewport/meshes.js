// The MuJoCo half of the browser viewport (docs/design/WEB_HUD.md section 8.2): load the simulator's compiled scene
// into MuJoCo WASM, mirror the streamed qpos through mj_kinematics, classify the geoms the page draws and turn their
// geometry into plain typed arrays. Nothing here imports three.js, so node (web/tests/test_mirror.mjs) runs exactly
// the code the page runs; viewport.js wraps the arrays into three.js objects.

import loadMujoco from '../../vendor/mujoco/mujoco.js';

/** Geom groups of a compiled sprout-sim scene. World geoms (floor, furniture, region markers, objects) sit in group 0;
 * the robot carries its collision hulls in group 1 (never drawn) and its visual meshes in group 2. The scene dict
 * repeats the two robot groups as collision_group / visual_group. */
export const GEOM_GROUP = Object.freeze({ world: 0, collision: 1, visual: 2 });

/** The virtual file the model is loaded from; the name only has to be consistent between addBuffer and the load. */
const MODEL_FILE = 'model.mjb';

/** MuJoCo's default geom colour: a geom that still carries it shows its material's colour instead (MuJoCo's rule). */
const DEFAULT_RGBA = [0.5, 0.5, 0.5, 1];

/** A dropped object counts as caught up once the stream puts it this close (metres, in x and y) to the drop point. */
const CAUGHT_UP_M = 0.005;

let mujocoPromise = null;

/** The MuJoCo WASM module, instantiated once per page: a second instance would compile the 10 MB binary again. A
 * failed load is forgotten so that a later call can retry (a flaky network should not poison the page). */
export function getMujoco() {
  if (!mujocoPromise) {
    mujocoPromise = loadMujoco().catch((err) => {
      mujocoPromise = null;
      throw err;
    });
  }
  return mujocoPromise;
}

/** Drawable geom kinds by mjtGeom value. Height fields and SDFs never occur in sprout-sim scenes; they are left out
 * and reported as skipped rather than drawn wrongly. */
function geomKinds(mujoco) {
  const G = mujoco.mjtGeom;
  return new Map([
    [G.mjGEOM_PLANE.value, 'plane'],
    [G.mjGEOM_SPHERE.value, 'sphere'],
    [G.mjGEOM_CAPSULE.value, 'capsule'],
    [G.mjGEOM_ELLIPSOID.value, 'ellipsoid'],
    [G.mjGEOM_CYLINDER.value, 'cylinder'],
    [G.mjGEOM_BOX.value, 'box'],
    [G.mjGEOM_MESH.value, 'mesh'],
  ]);
}

/** The name of a MuJoCo object (kind is an mjtObj key such as 'mjOBJ_BODY'), or '' when it has none. */
export function nameOf(mujoco, model, kind, id) {
  return mujoco.mj_id2name(model, mujoco.mjtObj[kind].value, id) || '';
}

function errorText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError('the model must be an ArrayBuffer or a typed array holding an .mjb file');
}

/** True when writes into this WASM-backed view reach the model (the binding hands out live views over the heap). The
 * probe writes a value, reads it back through a fresh view and restores it. */
function viewIsWritable(getView) {
  const view = getView();
  if (!view || view.length === 0) return false;
  const old = view[0];
  view[0] = old + 1;
  const ok = getView()[0] === old + 1;
  view[0] = old;
  return ok;
}

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** A finite numeric vector of at least n entries. */
function isVec(v, n) {
  if (!v || typeof v.length !== 'number' || v.length < n) return false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}

/** Row-major 3x3 rotation of a unit quaternion [w, x, y, z] (MuJoCo's mju_quat2Mat). */
function quatToMat([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Row kinds that move a static geom of the scene (docs/design/WEB_HUD.md section 4.2). */
export const WORLD_ROW_KINDS = Object.freeze(['scene/gate', 'scene/object_motion']);

/**
 * The geom pose a world row carries, or null: a `scene/gate` row (a gate closed) or a `scene/object_motion` row about
 * a region marker carries `geom_id`, `pos` [x, y, z] and `quat` [w, x, y, z], the geom's pose at the row's time. A
 * `scene/object_motion` row about a free object carries none (its pose arrives with qpos) and gives null.
 * Recordings made before the rows carried the geom: with the scene dict's regions given, a `finished` row about a
 * region (`object` is a region's name) places that region's marker at the row's `to` (where the step left it).
 * Returns {geomId, pos, quat | null}.
 */
export function worldGeomPose(row, regions = null) {
  if (!isObj(row) || !WORLD_ROW_KINDS.includes(row.kind)) return null;
  if (row.geom_id == null && row.kind === 'scene/object_motion' && row.state === 'finished' && isVec(row.to, 3)
    && Array.isArray(regions)) {
    const r = regions.find((x) => isObj(x) && x.name === row.object && Number.isInteger(x.geom_id));
    return r ? { geomId: r.geom_id, pos: [row.to[0], row.to[1], row.to[2]], quat: null } : null;
  }
  if (!Number.isInteger(row.geom_id) || row.geom_id < 0 || !isVec(row.pos, 3)) return null;
  return { geomId: row.geom_id, pos: [row.pos[0], row.pos[1], row.pos[2]], quat: isVec(row.quat, 4) ? row.quat.slice(0, 4) : null };
}

/**
 * The kinematic mirror: one MjModel + MjData whose qpos follows the simulator. The browser never steps physics (the
 * simulator is the only authority); every frame copies the streamed qpos and runs mj_kinematics, which gives the
 * exact geom poses of the same compiled model.
 *
 * Holds pin a free joint at a pose of the viewer's choosing while the stream says otherwise: the object being dragged
 * follows the pointer, not the simulator, until the simulator has applied the move.
 */
export class MjMirror {
  constructor(mujoco, model) {
    this.mujoco = mujoco;
    this.model = model;
    this.data = new mujoco.MjData(model);
    this.nq = model.nq;
    this.ngeom = model.ngeom;
    this.nbody = model.nbody;
    this.nmesh = model.nmesh;
    // The scene keyframe (robot standing, objects at home) is a far better picture than qpos0 for the moment before
    // the first streamed frame arrives.
    if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, this.data, 0);
    /** The last streamed qpos (the keyframe until the first frame). Kept apart from data.qpos, which holds the
     * streamed values with the holds applied. */
    this.qpos = Float64Array.from(this.data.qpos);
    /** qpos address of a free joint -> {pose: Float64Array(7), dropXY: [x, y] | null}. */
    this.holds = new Map();
    /** geom id -> world position, for region markers and gates when model.geom_pos cannot be written. */
    this.posOverride = new Map();
    /** geom id -> world rotation (row-major 3x3), the same fallback for model.geom_quat. */
    this.matOverride = new Map();
    /** geom id -> {pos, quat} as the model was loaded, for every geom a scene or a world row has moved: restoreGeoms
     * puts them back (a replay seeking backwards, a new episode). */
    this.geomHome = new Map();
    // mj_kinematics takes a geom's pose from geom_pos / geom_quat only when geom_sameframe does not say the geom sits
    // in its body's frame (the compiler sets it for a world geom without a rotation, which then ignores geom_quat):
    // a written pose clears the flag, so writing needs all three views
    const sameframeWritable = viewIsWritable(() => this.model.geom_sameframe);
    this.geomPosWritable = sameframeWritable && viewIsWritable(() => this.model.geom_pos);
    this.geomQuatWritable = sameframeWritable && viewIsWritable(() => this.model.geom_quat);
    this._warnedLength = false;
    this._warnedValues = false;
    this.refresh();
  }

  /** Mirrors one streamed qpos. Returns false, warning once, for a frame that does not fit the model (another
   * scene's frame, a truncated message): drawing it would scramble every body after the first wrong address. */
  setQpos(qpos) {
    if (!qpos || qpos.length !== this.nq) {
      if (!this._warnedLength) {
        const n = qpos ? qpos.length : 'none';
        console.warn(`viewport: ignoring a qpos of length ${n}; the model has nq = ${this.nq}`);
        this._warnedLength = true;
      }
      return false;
    }
    for (let i = 0; i < qpos.length; i++) {
      if (!Number.isFinite(qpos[i])) {
        if (!this._warnedValues) {
          console.warn(`viewport: ignoring a qpos with a non-finite value at address ${i}`);
          this._warnedValues = true;
        }
        return false;
      }
    }
    this.qpos.set(qpos);
    this._releaseCaughtUp();
    this.refresh();
    return true;
  }

  /** Recomputes the geom poses from the last streamed qpos and the current holds. Called after a hold moves, so a
   * dragged object follows the pointer even while no frame arrives (a paused or slow stream). */
  refresh() {
    const q = this.data.qpos;
    q.set(this.qpos);
    for (const [adr, hold] of this.holds) q.set(hold.pose, adr);
    this.mujoco.mj_kinematics(this.model, this.data);
  }

  /** Pins the free joint whose 7 qpos values start at adr (position, then the wxyz quaternion) at pose. */
  hold(adr, pose) {
    this.holds.set(adr, { pose: Float64Array.from(pose), dropXY: null });
  }

  /** The held pose (a live array: moving the hold is writing into it and calling refresh), or null. */
  heldPose(adr) {
    const hold = this.holds.get(adr);
    return hold ? hold.pose : null;
  }

  /** Ends the hold as soon as the stream shows the object where it was dropped: from then on the stream and the
   * hold agree, and switching back to the stream cannot make the object jump back for a frame. */
  releaseWhenCaughtUp(adr) {
    const hold = this.holds.get(adr);
    if (hold) hold.dropXY = [hold.pose[0], hold.pose[1]];
  }

  /** Ends a hold; returns whether there was one. */
  release(adr) {
    return this.holds.delete(adr);
  }

  _releaseCaughtUp() {
    for (const [adr, hold] of this.holds) {
      if (!hold.dropXY) continue;
      const dx = Math.abs(this.qpos[adr] - hold.dropXY[0]);
      const dy = Math.abs(this.qpos[adr + 1] - hold.dropXY[1]);
      if (dx < CAUGHT_UP_M && dy < CAUGHT_UP_M) this.holds.delete(adr);
    }
  }

  /** The current pose of a free joint as mirrored (holds included): [x, y, z, qw, qx, qy, qz]. */
  freePose(adr) {
    return Float64Array.from(this.data.qpos.subarray(adr, adr + 7));
  }

  /** World position of a body after the last refresh. */
  bodyPos(id) {
    const x = this.data.xpos;
    return [x[3 * id], x[3 * id + 1], x[3 * id + 2]];
  }

  /** World rotation of a body after the last refresh, row-major 3x3. */
  bodyMat(id) {
    return Array.from(this.data.xmat.subarray(9 * id, 9 * id + 9));
  }

  /** Moves a geom to a world position: region markers are moved at every episode reset by writing model.geom_pos
   * in the simulator, so the mirror does the same. Same as setGeomPose without a rotation. */
  setGeomPos(id, pos) {
    return this.setGeomPose(id, pos, null);
  }

  /** Places a geom at a world pose: pos [x, y, z] and, when given, quat [w, x, y, z]. The simulator moves its static
   * geoms (region markers, gates) by writing model.geom_pos / geom_quat, so the mirror does the same for a world-body
   * geom when the views allow it (mj_kinematics then places it); otherwise the pose is kept as an override the
   * viewport applies after kinematics. The loaded pose is remembered first, for restoreGeoms. */
  setGeomPose(id, pos, quat = null) {
    if (!(Number.isInteger(id) && id >= 0 && id < this.ngeom) || !isVec(pos, 3)) return false;
    const q = isVec(quat, 4) && Math.hypot(quat[0], quat[1], quat[2], quat[3]) > 1e-9 ? quat : null;
    const worldBody = this.model.geom_bodyid[id] === 0;
    if (!this.geomHome.has(id)) {
      this.geomHome.set(id, { pos: Array.from(this.model.geom_pos.subarray(3 * id, 3 * id + 3)),
        quat: Array.from(this.model.geom_quat.subarray(4 * id, 4 * id + 4)), sameframe: this.model.geom_sameframe[id] });
    }
    if (this.geomPosWritable && worldBody) {
      this.model.geom_sameframe[id] = 0; // mjSAMEFRAME_NONE: geom_pos and geom_quat place it
      this.model.geom_pos.set([pos[0], pos[1], pos[2]], 3 * id);
      this.posOverride.delete(id);
    } else {
      this.posOverride.set(id, [pos[0], pos[1], pos[2]]);
    }
    if (q) {
      const n = Math.hypot(q[0], q[1], q[2], q[3]);
      const unit = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
      if (this.geomQuatWritable && worldBody) {
        this.model.geom_sameframe[id] = 0;
        this.model.geom_quat.set(unit, 4 * id);
        this.matOverride.delete(id);
      } else {
        this.matOverride.set(id, quatToMat(unit));
      }
    }
    return true;
  }

  /** Puts every geom setGeomPose has moved back where the model was loaded with it and drops the overrides. */
  restoreGeoms() {
    for (const [id, home] of this.geomHome) {
      if (this.geomPosWritable) this.model.geom_pos.set(home.pos, 3 * id);
      if (this.geomQuatWritable) this.model.geom_quat.set(home.quat, 4 * id);
      if (this.geomPosWritable || this.geomQuatWritable) this.model.geom_sameframe[id] = home.sameframe;
    }
    this.geomHome.clear();
    this.posOverride.clear();
    this.matOverride.clear();
  }

  /** The static geoms of a scene dict (docs/design/WEB_HUD.md sections 5.3 and 4.2): every geom moved before goes
   * back to its loaded pose, the region markers to their centres, the gates to their pose when the dict was read
   * (parked under the floor while open, in the opening once closed). Call refresh() afterwards. */
  placeScene(scene) {
    this.restoreGeoms();
    if (!isObj(scene)) return;
    for (const r of Array.isArray(scene.regions) ? scene.regions : []) {
      if (isObj(r) && Number.isInteger(r.geom_id) && isVec(r.center, 3)) this.setGeomPos(r.geom_id, r.center);
    }
    for (const g of Array.isArray(scene.gates) ? scene.gates : []) {
      if (isObj(g) && Number.isInteger(g.geom_id) && isVec(g.pos, 3)) this.setGeomPose(g.geom_id, g.pos, g.quat);
    }
  }

  /** Applies a world row (worldGeomPose; regions: the scene dict's, for rows recorded without the geom) to the
   * mirror: returns the geom id it moved, or -1 for any other row. Call refresh() afterwards. */
  applyWorldRow(row, regions = null) {
    const w = worldGeomPose(row, regions);
    if (!w || !this.setGeomPose(w.geomId, w.pos, w.quat)) return -1;
    return w.geomId;
  }

  /** Deletes the WASM handles. Safe to call twice: the binding throws on a second delete, which is swallowed. */
  dispose() {
    for (const key of ['data', 'model']) {
      const handle = this[key];
      this[key] = null;
      if (!handle) continue;
      try {
        handle.delete();
      } catch (err) {
        // Already deleted: nothing left to free.
      }
    }
    this.holds.clear();
    this.posOverride.clear();
    this.matOverride.clear();
    this.geomHome.clear();
  }
}

/** Loads an .mjb (ArrayBuffer or typed array) into a new mirror. The virtual file system is deleted right after the
 * load: the model keeps its own copy of everything, and the file would otherwise pin its bytes in the WASM heap. */
export function openModel(mujoco, buffer) {
  const bytes = toBytes(buffer);
  const vfs = new mujoco.MjVFS();
  let model = null;
  try {
    vfs.addBuffer(MODEL_FILE, bytes);
    model = mujoco.MjModel.mj_loadModel(MODEL_FILE, vfs);
  } catch (err) {
    const version = mujoco.mj_versionString();
    throw new Error(`MuJoCo could not load the model (${errorText(err)}); `
      + `it must be an .mjb written by MuJoCo ${version}`);
  } finally {
    vfs.delete();
  }
  if (!model) throw new Error('MuJoCo returned no model for the .mjb');
  return new MjMirror(mujoco, model);
}

/** The colour a geom shows, [r, g, b, a] as MuJoCo stores it (display values, not linear). */
export function geomColor(model, id) {
  const rgba = model.geom_rgba;
  const own = [rgba[4 * id], rgba[4 * id + 1], rgba[4 * id + 2], rgba[4 * id + 3]];
  const mat = model.geom_matid[id];
  const isDefault = own.every((v, k) => Math.abs(v - DEFAULT_RGBA[k]) < 1e-6);
  if (mat >= 0 && isDefault) {
    const m = model.mat_rgba;
    return [m[4 * mat], m[4 * mat + 1], m[4 * mat + 2], m[4 * mat + 3]];
  }
  return own;
}

/**
 * The geoms the page draws, in id order: the world and visual groups (collision hulls stay hidden, as in the MuJoCo
 * viewer's default), alpha above zero (MuJoCo's own convention for an invisible geom) and a kind three.js can draw.
 * Each entry: {id, body, group, kind, role, name, size, dataid, rgba}; role is 'floor' (the viewport draws its own
 * large floor with a grid in its place), 'robot' (the visual meshes) or 'world' (furniture, region markers and
 * objects, which applyScene tells apart). skipped lists the visible geoms of a kind the viewport cannot draw.
 */
export function classifyGeoms(mujoco, model, groups = GEOM_GROUP) {
  const kinds = geomKinds(mujoco);
  const type = model.geom_type;
  const group = model.geom_group;
  const bodyOf = model.geom_bodyid;
  const sizes = model.geom_size;
  const dataid = model.geom_dataid;
  let floor = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, 'floor');
  if (floor >= 0 && kinds.get(type[floor]) !== 'plane') floor = -1;
  const geoms = [];
  const skipped = [];
  for (let i = 0; i < model.ngeom; i++) {
    const g = group[i];
    if (g !== groups.world && g !== groups.visual) continue;
    const rgba = geomColor(model, i);
    if (!(rgba[3] > 0)) continue;
    const kind = kinds.get(type[i]);
    if (!kind) {
      skipped.push({ id: i, type: type[i] });
      continue;
    }
    // Without a geom named 'floor', the first world plane on the world body plays the floor.
    if (floor < 0 && kind === 'plane' && bodyOf[i] === 0 && g === groups.world) floor = i;
    const role = i === floor ? 'floor' : g === groups.visual ? 'robot' : 'world';
    geoms.push({
      id: i,
      body: bodyOf[i],
      group: g,
      kind,
      role,
      name: nameOf(mujoco, model, 'mjOBJ_GEOM', i),
      size: [sizes[3 * i], sizes[3 * i + 1], sizes[3 * i + 2]],
      dataid: dataid[i],
      rgba,
    });
  }
  return { geoms, skipped };
}

/**
 * The triangles of one mesh as plain arrays. MuJoCo stores the vertices in the geom's frame (the compiler has already
 * centred and scaled them), so geom_xpos / geom_xmat place them directly. With per-corner normals
 * (mesh_facenormal into mesh_normal) the result is unindexed {positions, normals}, which keeps MuJoCo's hard edges;
 * otherwise it is {positions, index} and the caller computes smooth normals. Face indices are relative to the
 * mesh's own first vertex (mesh_vertadr). Every array is a copy: views over the WASM heap die when the heap grows.
 */
export function meshArrays(model, meshId) {
  const vadr = model.mesh_vertadr[meshId];
  const vnum = model.mesh_vertnum[meshId];
  const fadr = model.mesh_faceadr[meshId];
  const fnum = model.mesh_facenum[meshId];
  const vert = model.mesh_vert;
  const face = model.mesh_face;
  const facenormal = model.mesh_facenormal;
  const normal = model.mesh_normal;
  const nadr = model.mesh_normaladr ? model.mesh_normaladr[meshId] : -1;
  const nnum = model.mesh_normalnum ? model.mesh_normalnum[meshId] : 0;
  const haveNormals = nadr >= 0 && nnum > 0 && facenormal && normal && facenormal.length >= 3 * (fadr + fnum);
  if (haveNormals) {
    const positions = new Float32Array(9 * fnum);
    const normals = new Float32Array(9 * fnum);
    let ok = true;
    for (let f = 0; f < fnum && ok; f++) {
      for (let c = 0; c < 3; c++) {
        const v = face[3 * (fadr + f) + c];
        const n = facenormal[3 * (fadr + f) + c];
        if (v < 0 || v >= vnum || n < 0 || n >= nnum) {
          ok = false;
          break;
        }
        const o = 9 * f + 3 * c;
        const vo = 3 * (vadr + v);
        const no = 3 * (nadr + n);
        positions[o] = vert[vo];
        positions[o + 1] = vert[vo + 1];
        positions[o + 2] = vert[vo + 2];
        normals[o] = normal[no];
        normals[o + 1] = normal[no + 1];
        normals[o + 2] = normal[no + 2];
      }
    }
    if (ok) return { positions, normals, index: null };
  }
  const positions = vert.slice(3 * vadr, 3 * (vadr + vnum));
  const index = new Uint32Array(face.subarray(3 * fadr, 3 * (fadr + fnum)));
  return { positions, normals: null, index };
}

/** The robot's root body (the one whose subtree holds the most visual-group geoms) and the qpos address of its free
 * joint (-1 when it is fixed). Used for the camera's sense of "front" and to tell the robot from free objects. */
export function robotRoot(mujoco, model, groups = GEOM_GROUP) {
  const votes = new Map();
  for (let i = 0; i < model.ngeom; i++) {
    if (model.geom_group[i] !== groups.visual) continue;
    const root = model.body_rootid[model.geom_bodyid[i]];
    votes.set(root, (votes.get(root) || 0) + 1);
  }
  let body = -1;
  let best = 0;
  for (const [root, n] of votes) {
    if (n > best) {
      best = n;
      body = root;
    }
  }
  let qposAdr = -1;
  if (body > 0) {
    const free = mujoco.mjtJoint.mjJNT_FREE.value;
    const jadr = model.body_jntadr[body];
    if (jadr >= 0 && model.jnt_type[jadr] === free) qposAdr = model.jnt_qposadr[jadr];
  }
  return { body, qposAdr, name: body >= 0 ? nameOf(mujoco, model, 'mjOBJ_BODY', body) : '' };
}

function sizeOfKind(kind, size) {
  if (kind === 'sphere') return size.slice(0, 1);
  if (kind === 'cylinder' || kind === 'capsule') return size.slice(0, 2);
  return size.slice(0, 3);
}

/**
 * A scene dict (docs/design/WEB_HUD.md section 5.3) derived from the model alone, for pages that have no bridge or
 * bundle to ask (the viewport's dev page). It knows only what the compiled model shows: free bodies other than the
 * robot are the objects, world geoms named target_* are the region markers, world geoms named gate_* are the gates, a
 * world box named table*_top is the table. The bridge's scene dict, built from the simulator's SceneInfo, is the real one.
 */
export function deriveScene(mujoco, model, groups = GEOM_GROUP) {
  const kinds = geomKinds(mujoco);
  const robot = robotRoot(mujoco, model, groups);
  const free = mujoco.mjtJoint.mjJNT_FREE.value;
  const geomsOf = new Map();
  for (let i = 0; i < model.ngeom; i++) {
    const b = model.geom_bodyid[i];
    if (!geomsOf.has(b)) geomsOf.set(b, []);
    geomsOf.get(b).push(i);
  }
  const vec = (arr, i, n) => Array.from(arr.subarray(n * i, n * i + n));
  const objects = [];
  for (let j = 0; j < model.njnt; j++) {
    if (model.jnt_type[j] !== free) continue;
    const body = model.jnt_bodyid[j];
    if (body === robot.body) continue;
    const ids = (geomsOf.get(body) || []).filter((g) => model.geom_group[g] === groups.world);
    if (!ids.length) continue;
    const kind = kinds.get(model.geom_type[ids[0]]) || 'unknown';
    objects.push({
      name: nameOf(mujoco, model, 'mjOBJ_BODY', body),
      kind,
      body_id: body,
      geom_ids: ids,
      qpos_adr: model.jnt_qposadr[j],
      size: sizeOfKind(kind, vec(model.geom_size, ids[0], 3)),
      color: geomColor(model, ids[0]),
    });
  }
  const regions = [];
  const gates = [];
  let table = null;
  for (const g of geomsOf.get(0) || []) {
    if (model.geom_group[g] !== groups.world) continue;
    const name = nameOf(mujoco, model, 'mjOBJ_GEOM', g);
    const kind = kinds.get(model.geom_type[g]);
    const pos = vec(model.geom_pos, g, 3);
    const size = vec(model.geom_size, g, 3);
    if (/^target/.test(name)) {
      const circle = kind === 'cylinder';
      regions.push({
        name,
        shape: circle ? 'circle' : 'rect',
        geom_id: g,
        center: pos,
        size_m: circle ? [2 * size[0], 2 * size[0]] : [2 * size[0], 2 * size[1]],
        color: geomColor(model, g),
      });
    } else if (/^gate_/.test(name)) {
      // a gate is parked under the floor while open (scenes/gates.py); its closed centre is not in the model
      const quat = vec(model.geom_quat, g, 4);
      gates.push({ name: name.slice(5), geom_id: g, center: null, half_size: size, pos, quat,
        state: pos[2] + size[2] < 0 ? 'open' : 'closed' });
    } else if (!table && kind === 'box' && /^table.*_top$/.test(name)) {
      const top = pos[2] + size[2];
      table = { top_z: top, center: [pos[0], pos[1], top], half_size: size, yaw: 0 };
    }
  }
  const robotGeoms = [];
  for (let i = 0; i < model.ngeom; i++) {
    if (model.body_rootid[model.geom_bodyid[i]] === robot.body) robotGeoms.push(i);
  }
  return {
    name: null,
    nq: model.nq,
    free_joint_body: robot.name,
    joints: {},
    objects,
    regions,
    gates,
    table,
    surfaces: {},
    cameras: [],
    robot_geom_ids: robotGeoms,
    static_geom_ids: [],
    collision_group: groups.collision,
    visual_group: groups.visual,
    derived: true,
  };
}
