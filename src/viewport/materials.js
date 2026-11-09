// The appearance half of the viewport's MuJoCo side (docs/design/WEB_HUD.md section 8.2): which colour, texture and
// surface every geom of the compiled scene shows, read from the model's material and texture arrays the way MuJoCo's own
// renderer reads them. Like meshes.js it imports neither three.js nor the DOM, so node (web/tests/test_materials.mjs)
// checks exactly what the page draws from; viewport.js turns these plain values and arrays into three.js materials and
// textures, and applies the page's palette on top.

import { DEFAULT_RGBA, geomColor } from './meshes.js';

/** MuJoCo's surface values for a geom without a material (mjv_updateScene's defaults; checked against MuJoCo 3.14). */
const NO_MATERIAL = Object.freeze({ specular: 0.5, shininess: 0.5, emission: 0 });

/** mjtTextureRole as MuJoCo 3.x numbers it, for a binding that does not expose the enum: the colour roles the classic
 * renderer reads and the number of roles per material in mat_texid. */
const TEXROLE_FALLBACK = Object.freeze({ rgb: 1, rgba: 8, count: 10 });

/** Byte alignments mjModel's buffer may use between its arrays (MuJoCo pads every array to one of these); the one the
 * loaded model uses is the one under which mat_texrepeat starts where it must, after mat_texuniform. */
const BUFFER_ALIGNMENTS = Object.freeze([8, 16, 32, 64]);

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function textureRoles(mujoco) {
  const R = mujoco && mujoco.mjtTextureRole;
  const value = (key, fallback) => (R && R[key] && Number.isInteger(R[key].value) ? R[key].value : fallback);
  return { rgb: value('mjTEXROLE_RGB', TEXROLE_FALLBACK.rgb), rgba: value('mjTEXROLE_RGBA', TEXROLE_FALLBACK.rgba),
    count: value('mjNTEXROLE', TEXROLE_FALLBACK.count) };
}

function textureKinds(mujoco) {
  const T = mujoco && mujoco.mjtTexture;
  const value = (key, fallback) => (T && T[key] && Number.isInteger(T[key].value) ? T[key].value : fallback);
  return new Map([[value('mjTEXTURE_2D', 0), '2d'], [value('mjTEXTURE_CUBE', 1), 'cube'],
    [value('mjTEXTURE_SKYBOX', 2), 'skybox']]);
}

function nameOf(mujoco, model, kind, id) {
  try {
    return mujoco.mj_id2name(model, mujoco.mjtObj[kind].value, id) || '';
  } catch (err) {
    return '';
  }
}

/**
 * mat_texuniform, one 0/1 per material, and how it was read. MuJoCo WASM 3.14 exposes the array as a view of C++ bools,
 * which its binding cannot hand out (reading it throws a BindingError), so the bytes are taken from the WASM memory
 * between the two arrays MuJoCo lays out around it (mat_texid before, mat_texrepeat after; mjxmacro.h): the alignment
 * that puts mat_texrepeat exactly where it starts locates them, and the bytes must all be 0 or 1. When neither works the
 * flags are MuJoCo's default (false) and the source says 'default'.
 */
export function readTexUniform(model) {
  const n = model.nmat;
  try {
    const v = model.mat_texuniform;
    if (v && v.length === n) return { flags: Uint8Array.from(v, (x) => (x ? 1 : 0)), source: 'binding' };
  } catch (err) {
    // The binding cannot convert the bool view: read the bytes from the memory around it below.
  }
  const flags = new Uint8Array(n);
  if (n === 0) return { flags, source: 'binding' };
  try {
    const before = model.mat_texid;
    const after = model.mat_texrepeat;
    if (before && after && before.buffer === after.buffer) {
      const end = before.byteOffset + before.byteLength;
      const up = (x, a) => Math.ceil(x / a) * a;
      const starts = new Set(BUFFER_ALIGNMENTS.filter((a) => up(up(end, a) + n, a) === after.byteOffset).map((a) => up(end, a)));
      if (starts.size === 1) {
        const [start] = starts;
        const bytes = new Uint8Array(before.buffer, start, n);
        if (bytes.every((b) => b === 0 || b === 1)) return { flags: Uint8Array.from(bytes), source: 'memory' };
      }
    }
  } catch (err) {
    // A binding whose views are not windows on one memory: MuJoCo's default below.
  }
  return { flags, source: 'default' };
}

/**
 * What the model's materials and textures are, once per model (the arrays are copied: views over the WASM heap die when
 * the heap grows).
 *   materials[k]: {id, name, rgba, texture (a 2-D colour texture id, else -1), repeat [u, v], uniform, emission,
 *                  specular, shininess, roughness, metallic (MuJoCo's PBR values, -1 when unset)}
 *   textures[t]:  {id, name, kind ('2d' | 'cube' | 'skybox'), width, height, nchannel, adr, colorspace}
 *   uniformSource: how mat_texuniform was read (readTexUniform)
 * A material's colour texture is its RGB role, else its RGBA role (the classic renderer's choice); a cube or skybox texture
 * counts as none, since the page draws neither.
 */
export function readLook(mujoco, model) {
  const roles = textureRoles(mujoco);
  const kinds = textureKinds(mujoco);
  const textures = [];
  for (let t = 0; t < model.ntex; t++) {
    textures.push({
      id: t,
      name: nameOf(mujoco, model, 'mjOBJ_TEXTURE', t),
      kind: kinds.get(model.tex_type[t]) || 'unknown',
      width: model.tex_width[t],
      height: model.tex_height[t],
      nchannel: model.tex_nchannel[t],
      adr: model.tex_adr[t],
      colorspace: model.tex_colorspace ? model.tex_colorspace[t] : 0,
    });
  }
  const { flags, source } = readTexUniform(model);
  const materials = [];
  const rgba = model.mat_rgba;
  const texid = model.mat_texid;
  const repeat = model.mat_texrepeat;
  const opt = (arr, k, fallback) => (arr && arr.length > k ? arr[k] : fallback);
  for (let k = 0; k < model.nmat; k++) {
    let tex = -1;
    for (const role of [roles.rgb, roles.rgba]) {
      const id = texid[roles.count * k + role];
      if (id >= 0 && textures[id] && textures[id].kind === '2d') {
        tex = id;
        break;
      }
    }
    materials.push({
      id: k,
      name: nameOf(mujoco, model, 'mjOBJ_MATERIAL', k),
      rgba: [rgba[4 * k], rgba[4 * k + 1], rgba[4 * k + 2], rgba[4 * k + 3]],
      texture: tex,
      repeat: [repeat[2 * k], repeat[2 * k + 1]],
      uniform: flags[k] === 1,
      emission: opt(model.mat_emission, k, NO_MATERIAL.emission),
      specular: opt(model.mat_specular, k, NO_MATERIAL.specular),
      shininess: opt(model.mat_shininess, k, NO_MATERIAL.shininess),
      roughness: opt(model.mat_roughness, k, -1),
      metallic: opt(model.mat_metallic, k, -1),
    });
  }
  return { materials, textures, uniformSource: source };
}

/**
 * The appearance of one geom, by MuJoCo's rule (mjv_updateScene, checked against MuJoCo 3.14): a geom with a material
 * shows the material's rgba unless its own rgba differs from MuJoCo's default grey, which then replaces it (it is not
 * multiplied); a geom without a material shows its own rgba. A texture multiplies that colour, as in MuJoCo's renderer.
 * Returns {rgba, from ('material' | 'geom'), material (id or -1), texture (2-D texture id or -1), repeat, uniform,
 * emission, specular, shininess, roughness, metallic}.
 */
export function geomLook(model, look, id) {
  const matId = model.geom_matid[id];
  const mat = matId >= 0 ? look.materials[matId] : null;
  const rgba = geomColor(model, id);
  const own = [0, 1, 2, 3].map((k) => model.geom_rgba[4 * id + k]);
  const isDefault = own.every((v, k) => Math.abs(v - DEFAULT_RGBA[k]) < 1e-6);
  return {
    rgba,
    from: mat && isDefault ? 'material' : 'geom',
    material: mat ? matId : -1,
    texture: mat ? mat.texture : -1,
    repeat: mat ? mat.repeat.slice() : [1, 1],
    uniform: mat ? mat.uniform : false,
    emission: mat ? mat.emission : NO_MATERIAL.emission,
    specular: mat ? mat.specular : NO_MATERIAL.specular,
    shininess: mat ? mat.shininess : NO_MATERIAL.shininess,
    roughness: mat ? mat.roughness : -1,
    metallic: mat ? mat.metallic : -1,
  };
}

/** MuJoCo's default material colour (mjsMaterial rgba). */
const MATERIAL_DEFAULT_RGBA = Object.freeze([1, 1, 1, 1]);

/**
 * Whether the model gives a geom no colour of its own: no texture, and either MuJoCo's default grey without a material
 * or a material left at its default white. A model saved without its textures (bundles exported before the page drew
 * them) leaves the robot's textured material exactly so, and the page then draws its own grey for the robot rather
 * than a white one.
 */
export function isDefaultLook(appearance) {
  if (appearance.texture >= 0) return false;
  const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-6);
  return appearance.material < 0 ? near(appearance.rgba, DEFAULT_RGBA)
    : appearance.from === 'material' && near(appearance.rgba, MATERIAL_DEFAULT_RGBA);
}

/**
 * The pixels of a 2-D texture as RGBA bytes (width x height x 4, the model's first row first), which a browser can
 * upload as is: WebGL 2 has no three-channel sRGB format three.js uploads, so one channel becomes grey, two grey and
 * alpha, three gain an opaque alpha. alpha says whether any pixel is not opaque. Null for another kind of texture or a
 * texture whose data the model does not hold.
 */
export function textureRGBA(model, look, texId) {
  const tex = look.textures[texId];
  if (!tex || tex.kind !== '2d' || !(tex.width > 0 && tex.height > 0) || ![1, 2, 3, 4].includes(tex.nchannel)) return null;
  const n = tex.width * tex.height;
  const all = model.tex_data;
  if (!all || tex.adr < 0 || tex.adr + n * tex.nchannel > all.length) return null;
  const src = all.subarray(tex.adr, tex.adr + n * tex.nchannel);
  const data = new Uint8Array(4 * n);
  let alpha = false;
  const c = tex.nchannel;
  for (let i = 0, s = 0, d = 0; i < n; i++, s += c, d += 4) {
    if (c >= 3) {
      data[d] = src[s];
      data[d + 1] = src[s + 1];
      data[d + 2] = src[s + 2];
    } else {
      data[d] = data[d + 1] = data[d + 2] = src[s];
    }
    const a = c === 4 ? src[s + 3] : c === 2 ? src[s + 1] : 255;
    data[d + 3] = a;
    if (a < 255) alpha = true;
  }
  return { width: tex.width, height: tex.height, data, alpha };
}

/**
 * Texture coordinates for a surface the model gives none (a box, a plane, a mesh without texcoords), projected along each
 * vertex's dominant normal axis so that a texture stands upright on a wall: on a face whose normal is mostly horizontal
 * u runs to the viewer's right and the image's top is up (z); on a face whose normal is mostly vertical u runs along +x
 * (seen from above; mirrored from below) and the image's top lies toward +y. The texture's first row is its top, and v
 * counts rows (as MuJoCo's own texture coordinates do). uniform (mat_texuniform): repeat is the number of images per
 * metre; otherwise the image spans the face's extent repeat times. half: the surface's half-extents [x, y, z] in its frame.
 * positions and normals: 3 floats per vertex. Returns 2 floats per vertex.
 */
export function projectedUVs(positions, normals, half, repeat = [1, 1], uniform = false) {
  const nv = Math.floor(positions.length / 3);
  const uv = new Float32Array(2 * nv);
  const hx = Math.max(half[0], 1e-9);
  const hy = Math.max(half[1], 1e-9);
  const hz = Math.max(half[2], 1e-9);
  const [ru, rv] = repeat;
  for (let i = 0; i < nv; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    const nx = normals[3 * i];
    const ny = normals[3 * i + 1];
    const nz = normals[3 * i + 2];
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let u;
    let v;
    let su;
    let sv;
    if (az >= ax && az >= ay) {
      // seen from above (or below): u along +x (-x from below), the top of the image toward +y
      u = nz >= 0 ? x : -x;
      v = -y;
      su = hx;
      sv = hy;
    } else if (ax >= ay) {
      // a wall facing +x (its viewer's right is +y) or -x (the right is -y)
      u = nx >= 0 ? y : -y;
      v = -z;
      su = hy;
      sv = hz;
    } else {
      // a wall facing +y (its viewer's right is -x) or -y (the right is +x)
      u = ny >= 0 ? -x : x;
      v = -z;
      su = hx;
      sv = hz;
    }
    if (uniform) {
      uv[2 * i] = u * ru;
      uv[2 * i + 1] = v * rv;
    } else {
      uv[2 * i] = ((u + su) / (2 * su)) * ru;
      uv[2 * i + 1] = ((v + sv) / (2 * sv)) * rv;
    }
  }
  return uv;
}

/**
 * MuJoCo's specular and shininess (0..1) as a roughness inside [lo, hi]: the brighter and tighter MuJoCo's highlight, the
 * smoother the surface, but never glossy (the page's surfaces are matte). The geometric mean of the two puts MuJoCo's
 * default material (0.5, 0.5) in the middle of the range. A material that sets MuJoCo's own roughness (3.x PBR) keeps it,
 * clamped into the range.
 */
export function matteRoughness(appearance, [lo, hi]) {
  if (appearance.roughness >= 0) return Math.min(hi, Math.max(lo, appearance.roughness));
  const gloss = Math.sqrt(clamp01(appearance.specular) * clamp01(appearance.shininess));
  return hi - (hi - lo) * gloss;
}
