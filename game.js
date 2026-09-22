/* ============================================================
   HTMLBLOX ENGINE — game.js
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ============================================================
   SUPABASE
   ============================================================ */
const SUPABASE_URL = 'https://rzkqzbwqewduzybfuefa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_drMZMPTsXCKFqhtduGhfEw_FswXH22T';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage }
});

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  fixedStep: 1 / 60,
  maxSubSteps: 5,
  gravity: 62,
  maxFallSpeed: 48,
  walkSpeed: 9,
  runSpeed: 16,
  jumpSpeed: 25,
  body: { hx: 1.0, hz: 1.0, height: 5.25, stepHeight: 0.9 },
  camera: {
    distance: 16, minDistance: 2.6, maxDistance: 34,
    targetHeight: 4.2, sensitivity: 0.0024,
    minPitch: -0.95, maxPitch: 1.45, smooth: 20
  },
  health: {
    max: 100,
    deathThreshold: 10,
    regenDelay: 6,
    regenRate: 4,
    respawnDelay: 3.2,
    restartRespawnDelay: 1.5
  }
};

const NOOB_COLORS = {
  head: 0xf5cd30,
  leftArm: 0xf5cd30, rightArm: 0xf5cd30,
  torso: 0x0d69ac,
  leftLeg: 0x4b974b, rightLeg: 0x4b974b
};

const DEFAULT_AVATAR = {
  head: '#f5cd30', torso: '#0d69ac',
  leftArm: '#f5cd30', rightArm: '#f5cd30',
  leftLeg: '#4b974b', rightLeg: '#4b974b'
};

const ATTACH_SLOTS = ['Head', 'Torso', 'Back', 'LeftArm', 'RightArm', 'LeftLeg', 'RightLeg'];
const FACE_SLOT = 'face';

const DEFAULT_FACE = {
  id: 'default_face',
  name: 'Default Face',
  category: 'face',
  texture_url: null,
  price: 0,
  is_default: true,
  user_id: null,
  author_name: 'HTMLBlox',
  is_published: true,
  is_public: true
};

/* ============================================================
   STORE CACHE
   ============================================================ */
let __storeCache = null;
let __storePromise = null;
const __storeMap = new Map();

async function loadStoreItems(client) {
  if (__storeCache) return __storeCache;
  if (__storePromise) return __storePromise;
  __storePromise = (async () => {
    try {
      const { data, error } = await client
        .from('custom_accessories')
        .select('*')
        .eq('is_published', true);
      if (error) throw error;

      const authorIds = [...new Set((data || []).map(i => i.user_id).filter(Boolean))];
      let authorMap = {};
      if (authorIds.length) {
        const { data: profs } = await client
          .from('profiles')
          .select('id,username')
          .in('id', authorIds);
        for (const p of (profs || [])) authorMap[p.id] = p.username;
      }

      __storeCache = (data || []).map(i => ({
        ...i,
        author_name: authorMap[i.user_id] || 'unknown'
      }));
      __storeMap.clear();
      for (const it of __storeCache) __storeMap.set(it.id, it);
      __storeMap.set('default_face', DEFAULT_FACE);
      console.log('[store] loaded', __storeCache.length, 'items');
      return __storeCache;
    } catch (e) {
      console.warn('[store] load failed:', e);
      __storeCache = [];
      return __storeCache;
    }
  })();
  return __storePromise;
}

function getStoreItemById(id) {
  if (!id) return null;
  if (id === 'default_face') return DEFAULT_FACE;
  return __storeMap.get(id) || null;
}

/* ============================================================
   MIGRATION
   ============================================================ */
function migrateEquipped(raw) {
  const out = {
    Head: [], Torso: [], Back: [],
    LeftArm: [], RightArm: [], LeftLeg: [], RightLeg: [],
    face: 'default_face',
    shirt: null, tshirt: null, pants: null
  };
  if (!raw || typeof raw !== 'object') return out;

  const legacyMap = {
    hat: 'Head', torso_acc: 'Torso', cape: 'Back',
    leftarm_acc: 'LeftArm', rightarm_acc: 'RightArm',
    leftleg_acc: 'LeftLeg', rightleg_acc: 'RightLeg',
    acc: 'Head'
  };

  for (const key of Object.keys(raw)) {
    const val = raw[key];
    if (!val) continue;

    if (key === 'face') {
      out.face = (typeof val === 'string' && val) ? val : 'default_face';
    } else if (['shirt', 'tshirt', 'pants'].includes(key)) {
      out[key] = typeof val === 'string' ? val : null;
    } else if (legacyMap[key]) {
      const target = legacyMap[key];
      if (typeof val === 'string') out[target].push(val);
      else if (Array.isArray(val)) out[target] = out[target].concat(val.filter(x => typeof x === 'string'));
    } else if (ATTACH_SLOTS.includes(key)) {
      if (typeof val === 'string') out[key].push(val);
      else if (Array.isArray(val)) out[key] = out[key].concat(val.filter(x => typeof x === 'string'));
    }
  }

  if (!out.face) out.face = 'default_face';
  for (const slot of ATTACH_SLOTS) out[slot] = [...new Set(out[slot])];
  return out;
}

/* ============================================================
   ATLAS UV REMAP
   ============================================================ */
const CL_ATLAS_LAYOUT = [
  { col: 1, row: 1 },
  { col: 0, row: 1 },
  { col: 0, row: 0 },
  { col: 1, row: 0 },
  { col: 0, row: 2 },
  { col: 1, row: 2 }
];

function applyClothingAtlasUV(geo) {
  const uv = geo.attributes.uv;
  if (!uv) return;
  const cols = 2, rows = 3;
  for (let f = 0; f < 6; f++) {
    const base = f * 4;
    const { col, row } = CL_ATLAS_LAYOUT[f];
    const u0 = col / cols, u1 = (col + 1) / cols;
    const v0 = (2 - row) / rows, v1 = (3 - row) / rows;
    for (let i = 0; i < 4; i++) {
      const origU = uv.getX(base + i);
      const origV = uv.getY(base + i);
      uv.setXY(base + i, origU < 0.5 ? u0 : u1, origV < 0.5 ? v0 : v1);
    }
  }
  uv.needsUpdate = true;
}

function getClothingAtlasForPart(item, partName) {
  if (!item) return null;
  const parts = item.parts;
  if (Array.isArray(parts)) {
    const hit = parts.find(p => (p.part || '').toLowerCase() === partName.toLowerCase());
    if (hit) return hit.atlas_url || hit.texture_url || null;
  } else if (parts && typeof parts === 'object') {
    const v = parts[partName];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.atlas_url || v.texture_url || null;
  }
  return item.texture_url || null;
}

/* ============================================================
   BUILD SHAPE MESH
   ============================================================ */
function buildShapeMesh(shape, color) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color || '#888888'),
    roughness: 0.55, metalness: 0.05
  });
  const g = new THREE.Group();
  switch (shape) {
    case 'box': g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat)); break;
    case 'sphere': g.add(new THREE.Mesh(new THREE.SphereGeometry(0.6, 24, 16), mat)); break;
    case 'cylinder': g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 24), mat)); break;
    case 'cone': g.add(new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 20), mat)); break;
    case 'torus': g.add(new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.2, 12, 24), mat)); break;
    case 'hat_top': {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.3, 16), mat);
      b.position.y = 0.75; g.add(b);
      const br = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.1, 16), mat);
      br.position.y = 0.1; g.add(br);
      break;
    }
    case 'cap': {
      g.add(new THREE.Mesh(new THREE.SphereGeometry(0.78, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat));
      const bl = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.1, 0.72), mat);
      bl.position.set(0, -0.02, -0.55);
      g.add(bl);
      break;
    }
    case 'crown': {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.45, 20), mat);
      base.position.y = 0.22; g.add(base);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.55, 8), mat);
        sp.position.set(Math.cos(a) * 0.6, 0.72, Math.sin(a) * 0.6);
        g.add(sp);
      }
      const gem = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xff2255, emissive: 0x661122, roughness: 0.3 })
      );
      gem.position.set(0, 0.25, 0.72); g.add(gem);
      break;
    }
    case 'glasses': {
      const m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color || '#333333'),
        roughness: 0.3, metalness: 0.4
      });
      const lL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.06), m);
      lL.position.set(-0.35, 0, 0); g.add(lL);
      const rL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.06), m);
      rL.position.set(0.35, 0, 0); g.add(rL);
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.06), m));
      break;
    }
    case 'cape': {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 2.4),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(color || '#cc0000'),
          roughness: 0.85, side: THREE.DoubleSide
        })
      );
      plane.position.set(0, 1.2, 0); g.add(plane);
      break;
    }
    default: g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/* ============================================================
   GLTF + TEXTURE CACHES
   ============================================================ */
const __gltfCache = new Map();
const __textureCache = new Map();

async function loadGLTFCloned(url) {
  if (__gltfCache.has(url)) {
    const cached = __gltfCache.get(url);
    return cached.scene.clone(true);
  }
  const loader = new GLTFLoader();
  const gltf = await new Promise((res, rej) => loader.load(url, res, undefined, rej));
  __gltfCache.set(url, gltf);
  return gltf.scene.clone(true);
}

function loadTextureCached(url) {
  if (!url) return Promise.resolve(null);
  if (__textureCache.has(url)) return Promise.resolve(__textureCache.get(url));
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader();
    loader.load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      __textureCache.set(url, t);
      resolve(t);
    }, undefined, () => {
      console.warn('[game] texture load failed:', url);
      resolve(null);
    });
  });
}

/* ============================================================
   BUILD ACCESSORY GROUP
   ============================================================ */
async function buildAccessoryGroup(item) {
  const group = new THREE.Group();
  if (!item) return group;
  if (['shirt', 'tshirt', 'pants', 'face'].includes(item.category)) return group;

  const parts = Array.isArray(item.parts) && item.parts.length
    ? item.parts
    : (item.shape || item.model_url ? [{
        shape: item.shape,
        color: item.color,
        model_url: item.model_url,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: 1
      }] : []);

  for (const p of parts) {
    let partGroup = null;

    if (p.model_url) {
      try {
        const model = await loadGLTFCloned(p.model_url);
        if (model) {
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          model.scale.setScalar(1.5 / maxDim);
          const box2 = new THREE.Box3().setFromObject(model);
          const center = box2.getCenter(new THREE.Vector3());
          model.position.sub(center);
          if (p.color) {
            model.traverse(o => {
              if (o.isMesh && o.material && o.material.color && !o.material.map) {
                if (Array.isArray(o.material)) o.material.forEach(m => m.color?.set(p.color));
                else o.material.color.set(p.color);
              }
            });
          }
          model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
          partGroup = new THREE.Group();
          partGroup.add(model);
        }
      } catch (e) {
        console.warn('[game] GLTF load failed, using shape fallback:', p.model_url);
      }
    }

    if (!partGroup) {
      partGroup = buildShapeMesh(p.shape || 'box', p.color || '#888888');
    }

    const sx = (p.scale_x != null) ? Number(p.scale_x) : (typeof p.scale === 'number' ? p.scale : 1);
    const sy = (p.scale_y != null) ? Number(p.scale_y) : (typeof p.scale === 'number' ? p.scale : 1);
    const sz = (p.scale_z != null) ? Number(p.scale_z) : (typeof p.scale === 'number' ? p.scale : 1);

    partGroup.position.set(p.position?.x || 0, p.position?.y || 0, p.position?.z || 0);
    partGroup.rotation.set(
      THREE.MathUtils.degToRad(p.rotation?.x || 0),
      THREE.MathUtils.degToRad(p.rotation?.y || 0),
      THREE.MathUtils.degToRad(p.rotation?.z || 0)
    );
    partGroup.scale.set(sx, sy, sz);
    group.add(partGroup);
  }

  return group;
}

/* ============================================================
   UTILS
   ============================================================ */
function cssToHex(c, def) {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && c[0] === '#') return parseInt(c.slice(1), 16);
  return def;
}

function normalizeAvatarColors(a) {
  if (!a) return {
    head: 0xf5cd30, torso: 0x0d69ac,
    leftArm: 0xf5cd30, rightArm: 0xf5cd30,
    leftLeg: 0x4b974b, rightLeg: 0x4b974b
  };
  if (a.arms && !a.leftArm) {
    return {
      head:     cssToHex(a.head,  0xf5cd30),
      torso:    cssToHex(a.torso, 0x0d69ac),
      leftArm:  cssToHex(a.arms,  0xf5cd30),
      rightArm: cssToHex(a.arms,  0xf5cd30),
      leftLeg:  cssToHex(a.legs,  0x4b974b),
      rightLeg: cssToHex(a.legs,  0x4b974b)
    };
  }
  return {
    head:     cssToHex(a.head,     0xf5cd30),
    torso:    cssToHex(a.torso,    0x0d69ac),
    leftArm:  cssToHex(a.leftArm,  0xf5cd30),
    rightArm: cssToHex(a.rightArm, 0xf5cd30),
    leftLeg:  cssToHex(a.leftLeg,  0x4b974b),
    rightLeg: cssToHex(a.rightLeg, 0x4b974b)
  };
}

function avatarColorsFromProfile(p) {
  return normalizeAvatarColors(p && p.avatar_colors);
}

function damp(cur, tgt, lambda, dt) {
  return THREE.MathUtils.lerp(cur, tgt, 1 - Math.exp(-lambda * dt));
}
function shortAngleDist(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function hexToCss(hex) { return '#' + hex.toString(16).padStart(6, '0'); }
function nameToColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return 'hsl(' + (Math.abs(h) % 360) + ', 72%, 68%)';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

/* ============================================================
   PHYSICS
   ============================================================ */
const EPS = 1e-3;

class PhysicsWorld {
  constructor() { this.boxes = []; }
  addBox(cx, cy, cz, sx, sy, sz) {
    const box = new THREE.Box3(
      new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
      new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2)
    );
    this.boxes.push(box);
    return box;
  }
  overlapsAt(x, y, z, hx, hz, h, box) {
    return (
      x - hx < box.max.x - EPS && x + hx > box.min.x + EPS &&
      y      < box.max.y - EPS && y + h  > box.min.y + EPS &&
      z - hz < box.max.z - EPS && z + hz > box.min.z + EPS
    );
  }
  isBlocked(x, y, z, hx, hz, h, ignore) {
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (b === ignore) continue;
      if (this.overlapsAt(x, y, z, hx, hz, h, b)) return true;
    }
    return false;
  }
  tryStepUp(body, box, p, hx, hz, h) {
    if (!body.grounded) return false;
    const rise = box.max.y - p.y;
    if (rise <= 0 || rise > body.stepHeight) return false;
    const newY = box.max.y;
    if (this.isBlocked(p.x, newY, p.z, hx, hz, h, box)) return false;
    p.y = newY;
    return true;
  }
  moveBody(body, dt) {
    const p = body.pos, v = body.vel;
    const hx = body.hx, hz = body.hz, h = body.height;

    if (v.x !== 0) {
      p.x += v.x * dt;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (!this.overlapsAt(p.x, p.y, p.z, hx, hz, h, b)) continue;
        if (this.tryStepUp(body, b, p, hx, hz, h)) continue;
        if (v.x > 0) p.x = b.min.x - hx - EPS;
        else         p.x = b.max.x + hx + EPS;
        v.x = 0;
      }
    }
    if (v.z !== 0) {
      p.z += v.z * dt;
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (!this.overlapsAt(p.x, p.y, p.z, hx, hz, h, b)) continue;
        if (this.tryStepUp(body, b, p, hx, hz, h)) continue;
        if (v.z > 0) p.z = b.min.z - hz - EPS;
        else         p.z = b.max.z + hz + EPS;
        v.z = 0;
      }
    }
    p.y += v.y * dt;
    body.grounded = false;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (!this.overlapsAt(p.x, p.y, p.z, hx, hz, h, b)) continue;
      if (v.y <= 0) { p.y = b.max.y; v.y = 0; body.grounded = true; }
      else          { p.y = b.min.y - h - EPS; v.y = 0; }
    }
  }
  raycast(origin, dir, maxDist) {
    let closest = maxDist;
    for (let i = 0; i < this.boxes.length; i++) {
      const t = this._rayBox(origin, dir, this.boxes[i], closest);
      if (t !== null && t < closest) closest = t;
    }
    return closest;
  }
  _rayBox(o, d, box, maxT) {
    let tmin = 0, tmax = maxT;
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const a = axes[i];
      const dd = d[a];
      if (Math.abs(dd) < 1e-8) {
        if (o[a] < box.min[a] || o[a] > box.max[a]) return null;
        continue;
      }
      const inv = 1 / dd;
      let t1 = (box.min[a] - o[a]) * inv;
      let t2 = (box.max[a] - o[a]) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    return tmin > 0 ? tmin : null;
  }
}

/* ============================================================
   CHARACTER — com suporte a roupas transparentes
   ============================================================ */
const SHARED_GEO = (() => {
  const leg = new THREE.BoxGeometry(1, 2, 1);
  applyClothingAtlasUV(leg);
  const arm = new THREE.BoxGeometry(1, 2, 1);
  applyClothingAtlasUV(arm);
  const torso = new THREE.BoxGeometry(2, 2, 1);
  applyClothingAtlasUV(torso);
  const head = new THREE.BoxGeometry(1.25, 1.25, 1.25);
  return { leg, arm, torso, head };
})();

/* Cada parte precisa de DOIS meshes:
   1. Base (sólido com a cor do avatar)
   2. Overlay (roupa pintada, transparente)
   Assim a cor do avatar aparece onde não há pintura. */

class Character {
  constructor({ name, colors, equippedItems, isLocal = false, subtitle = 'ONLINE', subtitleColor = '#6fe36f' }) {
    this.name = name;
    this.isLocal = isLocal;
    this.colors = Object.assign({}, NOOB_COLORS, colors || {});
    this.equippedItems = equippedItems || null;
    this._equipmentLoaded = false;
    this._equipmentLoading = false;

    this.body = {
      pos: new THREE.Vector3(0, 0, 0),
      vel: new THREE.Vector3(0, 0, 0),
      hx: CONFIG.body.hx, hz: CONFIG.body.hz,
      height: CONFIG.body.height, stepHeight: CONFIG.body.stepHeight,
      grounded: false
    };
    this.visualYaw = 0;
    this.targetYaw = 0;
    this.walkPhase = 0;
    this.group = new THREE.Group();

    this.maxHealth = CONFIG.health.max;
    this.health = this.maxHealth;
    this.dead = false;
    this.lastDamageTime = -Infinity;
    this.idleTime = Math.random() * 10;

    this._buildBody();
    this._buildNameTag(subtitle, subtitleColor);
  }

  _buildBody() {
    const c = this.colors, g = this.group;

    /* --- Torso: base + overlay --- */
    this.torsoGroup = new THREE.Group();
    this.torsoGroup.position.set(0, 3, 0);

    const torsoBaseMat = new THREE.MeshLambertMaterial({ color: c.torso });
    this.torsoBaseMesh = new THREE.Mesh(SHARED_GEO.torso, torsoBaseMat);
    this.torsoBaseMesh.castShadow = true;
    this.torsoBaseMesh.receiveShadow = true;
    this.torsoGroup.add(this.torsoBaseMesh);

    const torsoOverlayMat = new THREE.MeshLambertMaterial({
      transparent: true,
      color: 0xffffff
    });
    this.torsoMesh = new THREE.Mesh(SHARED_GEO.torso, torsoOverlayMat);
    this.torsoMesh.castShadow = true;
    this.torsoMesh.receiveShadow = true;
    this.torsoMesh.visible = false;
    this.torsoGroup.add(this.torsoMesh);

    g.add(this.torsoGroup);

    /* --- Arm L --- */
    this.armL = new THREE.Group(); this.armL.position.set(-1.5, 4, 0);

    const armLBaseMat = new THREE.MeshLambertMaterial({ color: c.leftArm });
    this._armLBaseMesh = new THREE.Mesh(SHARED_GEO.arm, armLBaseMat);
    this._armLBaseMesh.position.y = -1;
    this._armLBaseMesh.castShadow = true;
    this._armLBaseMesh.receiveShadow = true;
    this.armL.add(this._armLBaseMesh);

    const armLOverlayMat = new THREE.MeshLambertMaterial({
      transparent: true,
      color: 0xffffff
    });
    this._armLMesh = new THREE.Mesh(SHARED_GEO.arm, armLOverlayMat);
    this._armLMesh.position.y = -1;
    this._armLMesh.castShadow = true;
    this._armLMesh.receiveShadow = true;
    this._armLMesh.visible = false;
    this.armL.add(this._armLMesh);

    g.add(this.armL);

    /* --- Arm R --- */
    this.armR = new THREE.Group(); this.armR.position.set(1.5, 4, 0);

    const armRBaseMat = new THREE.MeshLambertMaterial({ color: c.rightArm });
    this._armRBaseMesh = new THREE.Mesh(SHARED_GEO.arm, armRBaseMat);
    this._armRBaseMesh.position.y = -1;
    this._armRBaseMesh.castShadow = true;
    this._armRBaseMesh.receiveShadow = true;
    this.armR.add(this._armRBaseMesh);

    const armROverlayMat = new THREE.MeshLambertMaterial({
      transparent: true,
      color: 0xffffff
    });
    this._armRMesh = new THREE.Mesh(SHARED_GEO.arm, armROverlayMat);
    this._armRMesh.position.y = -1;
    this._armRMesh.castShadow = true;
    this._armRMesh.receiveShadow = true;
    this._armRMesh.visible = false;
    this.armR.add(this._armRMesh);

    g.add(this.armR);

    /* --- Leg L --- */
    this.legL = new THREE.Group(); this.legL.position.set(-0.5, 2, 0);

    const legLBaseMat = new THREE.MeshLambertMaterial({ color: c.leftLeg });
    this._legLBaseMesh = new THREE.Mesh(SHARED_GEO.leg, legLBaseMat);
    this._legLBaseMesh.position.y = -1;
    this._legLBaseMesh.castShadow = true;
    this._legLBaseMesh.receiveShadow = true;
    this.legL.add(this._legLBaseMesh);

    const legLOverlayMat = new THREE.MeshLambertMaterial({
      transparent: true,
      color: 0xffffff
    });
    this._legLMesh = new THREE.Mesh(SHARED_GEO.leg, legLOverlayMat);
    this._legLMesh.position.y = -1;
    this._legLMesh.castShadow = true;
    this._legLMesh.receiveShadow = true;
    this._legLMesh.visible = false;
    this.legL.add(this._legLMesh);

    g.add(this.legL);

    /* --- Leg R --- */
    this.legR = new THREE.Group(); this.legR.position.set(0.5, 2, 0);

    const legRBaseMat = new THREE.MeshLambertMaterial({ color: c.rightLeg });
    this._legRBaseMesh = new THREE.Mesh(SHARED_GEO.leg, legRBaseMat);
    this._legRBaseMesh.position.y = -1;
    this._legRBaseMesh.castShadow = true;
    this._legRBaseMesh.receiveShadow = true;
    this.legR.add(this._legRBaseMesh);

    const legROverlayMat = new THREE.MeshLambertMaterial({
      transparent: true,
      color: 0xffffff
    });
    this._legRMesh = new THREE.Mesh(SHARED_GEO.leg, legROverlayMat);
    this._legRMesh.position.y = -1;
    this._legRMesh.castShadow = true;
    this._legRMesh.receiveShadow = true;
    this._legRMesh.visible = false;
    this.legR.add(this._legRMesh);

    g.add(this.legR);

    /* --- Head --- */
    const headBaseMat = new THREE.MeshLambertMaterial({ color: c.head });
    const headFaceMat = new THREE.MeshLambertMaterial({ map: this._makeFaceTexture() });
    this.headMesh = new THREE.Mesh(SHARED_GEO.head, [
      headBaseMat, headBaseMat, headBaseMat, headBaseMat, headFaceMat, headBaseMat
    ]);
    this.headMesh.position.set(0, 4.625, 0);
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;
    g.add(this.headMesh);
  }

  _makeFaceTexture() {
    const c = this.colors.head;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hexToCss(c);
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.ellipse(44, 52, 8, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(84, 52, 8, 11, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(64, 60, 28, 0.14 * Math.PI, 0.86 * Math.PI);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  _buildNameTag(subtitle, subtitleColor) {
    const sprite = createNameSprite(this.name, {
      isLocal: this.isLocal,
      subtitle, subtitleColor
    });
    sprite.position.set(0, 6.6, 0);
    this.group.add(sprite);
    this.nameSprite = sprite;
  }

  _getAttachPart(name) {
    switch (name) {
      case 'Head':     return this.headMesh;
      case 'Torso':    return this.torsoGroup;
      case 'Back':     return this.torsoGroup;
      case 'LeftArm':  return this.armL;
      case 'RightArm': return this.armR;
      case 'LeftLeg':  return this.legL;
      case 'RightLeg': return this.legR;
      default:         return this.headMesh;
    }
  }

  _applyClothingTexture(partKey, texture) {
    /* Aplica a textura no OVERLAY mesh da parte.
       A base colorida permanece por baixo — assim a cor do avatar aparece
       onde a textura for transparente. */
    let overlayMesh = null;
    switch (partKey) {
      case 'torso':    overlayMesh = this.torsoMesh; break;
      case 'leftArm':  overlayMesh = this._armLMesh; break;
      case 'rightArm': overlayMesh = this._armRMesh; break;
      case 'leftLeg':  overlayMesh = this._legLMesh; break;
      case 'rightLeg': overlayMesh = this._legRMesh; break;
    }
    if (!overlayMesh || !texture) return;

    overlayMesh.material.map = texture;
    overlayMesh.material.color.set('#ffffff');
    overlayMesh.material.transparent = true;
    overlayMesh.material.alphaTest = 0.01;
    overlayMesh.material.depthWrite = false;
    overlayMesh.material.polygonOffset = true;
    overlayMesh.material.polygonOffsetFactor = -1;
    overlayMesh.material.polygonOffsetUnits = -1;
    overlayMesh.material.needsUpdate = true;
    overlayMesh.visible = true;
  }

  async _applyFace(textureUrl) {
    if (!this.headMesh || !textureUrl) return;
    const headColorCss = '#' + this.colors.head.toString(16).padStart(6, '0');

    const faceCanvas = await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = headColorCss;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        } catch (e) {
          console.warn('[game] face composite failed (CORS?)', e);
          resolve(null);
        }
      };
      img.onerror = () => {
        console.warn('[game] face load failed:', textureUrl);
        resolve(null);
      };
      img.src = textureUrl;
    });

    if (!faceCanvas) return;

    const tex = new THREE.CanvasTexture(faceCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    const mats = this.headMesh.material;
    if (Array.isArray(mats) && mats.length === 6) {
      const newMats = mats.slice();
      newMats[4] = new THREE.MeshLambertMaterial({ map: tex });
      this.headMesh.material = newMats;
    }
  }

  async loadEquipment() {
    if (this._equipmentLoaded || this._equipmentLoading) return;
    if (!this.equippedItems) { this._equipmentLoaded = true; return; }
    this._equipmentLoading = true;

    try {
      const equipped = migrateEquipped(this.equippedItems);

      /* --- Face --- */
      const faceId = equipped.face;
      if (faceId && faceId !== 'default_face') {
        const faceItem = getStoreItemById(faceId);
        if (faceItem && faceItem.texture_url) {
          await this._applyFace(faceItem.texture_url);
        }
      }

      /* --- Roupas --- */
      const shirtId = equipped.shirt;
      const tshirtId = equipped.tshirt;
      const pantsId = equipped.pants;

      const shirtItem = shirtId ? getStoreItemById(shirtId) : null;
      const tshirtItem = tshirtId ? getStoreItemById(tshirtId) : null;
      const pantsItem = pantsId ? getStoreItemById(pantsId) : null;

      if (tshirtItem) {
        const tex = await loadTextureCached(getClothingAtlasForPart(tshirtItem, 'torso'));
        if (tex) this._applyClothingTexture('torso', tex);
      } else if (shirtItem) {
        const torsoTex = await loadTextureCached(getClothingAtlasForPart(shirtItem, 'torso'));
        const armLTex = await loadTextureCached(getClothingAtlasForPart(shirtItem, 'leftArm'));
        const armRTex = await loadTextureCached(getClothingAtlasForPart(shirtItem, 'rightArm'));
        if (torsoTex) this._applyClothingTexture('torso', torsoTex);
        if (armLTex) this._applyClothingTexture('leftArm', armLTex);
        if (armRTex) this._applyClothingTexture('rightArm', armRTex);
      }

      if (pantsItem) {
        const legLTex = await loadTextureCached(getClothingAtlasForPart(pantsItem, 'leftLeg'));
        const legRTex = await loadTextureCached(getClothingAtlasForPart(pantsItem, 'rightLeg'));
        if (legLTex) this._applyClothingTexture('leftLeg', legLTex);
        if (legRTex) this._applyClothingTexture('rightLeg', legRTex);
      }

      /* --- Acessórios 3D --- */
      for (const slot of ATTACH_SLOTS) {
        const raw = equipped[slot];
        const ids = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        for (const itemId of ids) {
          if (!itemId) continue;
          const item = getStoreItemById(itemId);
          if (!item) continue;
          if (['shirt', 'tshirt', 'pants', 'face'].includes(item.category)) continue;
          try {
            const accGroup = await buildAccessoryGroup(item);
            accGroup.position.set(item.offset_x || 0, item.offset_y || 0, item.offset_z || 0);
            accGroup.rotation.set(
              THREE.MathUtils.degToRad(item.rot_x || 0),
              THREE.MathUtils.degToRad(item.rot_y || 0),
              THREE.MathUtils.degToRad(item.rot_z || 0)
            );
            accGroup.scale.setScalar(item.scale || 1);
            const parent = this._getAttachPart(item.attach_part || slot);
            if (parent) parent.add(accGroup);
          } catch (e) {
            console.warn('[game] accessory load failed:', itemId, e);
          }
        }
      }
    } catch (e) {
      console.warn('[game] loadEquipment error:', e);
    }

    this._equipmentLoaded = true;
    this._equipmentLoading = false;
  }

  setPosition(x, y, z) {
    this.body.pos.set(x, y, z);
    this.body.vel.set(0, 0, 0);
    this.group.position.copy(this.body.pos);
  }
  setYaw(y) { this.visualYaw = y; this.targetYaw = y; this.group.rotation.y = y; }
  setVisible(v) { this.group.visible = v; }

  takeDamage(amount) {
    if (this.dead) return false;
    const amt = Number(amount) || 0;
    if (amt <= 0) return false;
    this.health = Math.max(0, this.health - amt);
    this.lastDamageTime = performance.now() / 1000;
    if (this.health <= CONFIG.health.deathThreshold) {
      this.health = 0;
      return true;
    }
    return false;
  }
  heal(amount) {
    if (this.dead) return;
    const amt = Number(amount) || 0;
    if (amt <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + amt);
  }
  resetHealth() {
    this.health = this.maxHealth;
    this.dead = false;
    this.lastDamageTime = -Infinity;
  }

  updateVisual(dt, horizontalSpeed) {
    const diff = shortAngleDist(this.visualYaw, this.targetYaw);
    this.visualYaw += diff * Math.min(1, dt * 12);
    this.group.rotation.y = this.visualYaw;

    const grounded = this.body.grounded;
    const moving = horizontalSpeed > 0.8 && grounded;
    const speedRatio = Math.min(1, horizontalSpeed / CONFIG.runSpeed);

    if (!grounded) {
      this.armL.rotation.x = damp(this.armL.rotation.x, -2.3, 12, dt);
      this.armR.rotation.x = damp(this.armR.rotation.x, -2.3, 12, dt);
      this.armL.rotation.z = damp(this.armL.rotation.z, 0, 12, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, 0, 12, dt);
      this.legL.rotation.x = damp(this.legL.rotation.x, 0.38, 12, dt);
      this.legR.rotation.x = damp(this.legR.rotation.x, -0.26, 12, dt);
      this.walkPhase = 0;
    } else if (moving) {
      this.walkPhase += dt * (7 + speedRatio * 9);
      const amp = 0.55 + speedRatio * 0.45;
      const s = Math.sin(this.walkPhase);
      this.legL.rotation.x = s * amp;
      this.legR.rotation.x = -s * amp;
      this.armL.rotation.x = -s * amp * 0.9;
      this.armR.rotation.x = s * amp * 0.9;
      this.armL.rotation.z = damp(this.armL.rotation.z, 0, 8, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, 0, 8, dt);
    } else {
      this.idleTime += dt;
      const breath = Math.sin(this.idleTime * 1.9) * 0.05;
      const swayX  = Math.sin(this.idleTime * 0.8) * 0.07;
      const swayZ  = Math.sin(this.idleTime * 1.3 + 1.2) * 0.04;

      this.legL.rotation.x = damp(this.legL.rotation.x, 0, 8, dt);
      this.legR.rotation.x = damp(this.legR.rotation.x, 0, 8, dt);
      this.armL.rotation.x = damp(this.armL.rotation.x,  swayX, 4, dt);
      this.armR.rotation.x = damp(this.armR.rotation.x, -swayX, 4, dt);
      this.armL.rotation.z = damp(this.armL.rotation.z, -swayZ, 4, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z,  swayZ, 4, dt);
    }
    this.group.position.copy(this.body.pos);
  }
}


/* ============================================================
   RAGDOLL
   ============================================================ */
class Ragdoll {
  constructor(character, scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.parts = [];
    this.life = 0;

    character.group.updateMatrixWorld(true);

    const entries = [];
    if (character.torsoBaseMesh) entries.push({ mesh: character.torsoBaseMesh, sy: 2 });
    if (character.headMesh)  entries.push({ mesh: character.headMesh,  sy: 1.25 });
    if (character.legL?.children[0]) entries.push({ mesh: character.legL.children[0], sy: 2 });
    if (character.legR?.children[0]) entries.push({ mesh: character.legR.children[0], sy: 2 });
    if (character.armL?.children[0]) entries.push({ mesh: character.armL.children[0], sy: 2 });
    if (character.armR?.children[0]) entries.push({ mesh: character.armR.children[0], sy: 2 });

    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();

    for (const e of entries) {
      e.mesh.matrixWorld.decompose(wp, wq, ws);

      const clone = e.mesh.clone();
      clone.position.copy(wp);
      clone.quaternion.copy(wq);
      clone.scale.copy(ws);
      clone.castShadow = true;
      clone.receiveShadow = true;
      scene.add(clone);

      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        2.5 + Math.random() * 4.5,
        (Math.random() - 0.5) * 8
      );
      const ang = new THREE.Vector3(
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10,
        (Math.random() - 0.5) * 10
      );

      this.parts.push({
        mesh: clone,
        vel, ang,
        halfY: e.sy / 2,
        resting: false
      });
    }
  }

  _groundY(x, z, fromY) {
    if (!this.physics) return -Infinity;
    const dist = this.physics.raycast(
      new THREE.Vector3(x, fromY, z),
      new THREE.Vector3(0, -1, 0),
      200
    );
    if (dist >= 199.9) return -Infinity;
    return fromY - dist;
  }

  update(dt) {
    this.life += dt;
    for (const p of this.parts) {
      if (p.resting) continue;

      p.vel.y -= 62 * dt;
      if (p.vel.y < -48) p.vel.y = -48;

      p.mesh.position.x += p.vel.x * dt;
      p.mesh.position.z += p.vel.z * dt;
      p.mesh.position.y += p.vel.y * dt;

      const gy = this._groundY(p.mesh.position.x, p.mesh.position.z, p.mesh.position.y);
      if (gy > -1e6) {
        const bottom = p.mesh.position.y - p.halfY;
        if (bottom <= gy) {
          p.mesh.position.y = gy + p.halfY;
          if (p.vel.y < -1.5) {
            p.vel.y = -p.vel.y * 0.3;
            p.vel.x *= 0.65;
            p.vel.z *= 0.65;
            p.ang.multiplyScalar(0.6);
          } else {
            p.vel.y = 0;
            p.vel.x *= 0.8;
            p.vel.z *= 0.8;
            p.ang.multiplyScalar(0.65);
            if (Math.abs(p.vel.x) < 0.15 && Math.abs(p.vel.z) < 0.15 && p.ang.length() < 0.4) {
              p.vel.set(0, 0, 0);
              p.ang.set(0, 0, 0);
              p.resting = true;
            }
          }
        }
      }

      p.mesh.rotation.x += p.ang.x * dt;
      p.mesh.rotation.y += p.ang.y * dt;
      p.mesh.rotation.z += p.ang.z * dt;
    }
  }

  /* CORREÇÃO CRÍTICA:
     NÃO chamar dispose() na geometria aqui — a geometria é COMPARTILHADA
     (SHARED_GEO) entre todos os Characters. Ao dar dispose nela, os meshes
     originais do personagem perdem o buffer da GPU e ficam invisíveis
     após o respawn. Só removemos o clone da cena. */
  dispose() {
    for (const p of this.parts) {
      this.scene.remove(p.mesh);
      // NÃO dispose da geometria (é compartilhada com o Character)
      // NÃO dispose do material também (também é compartilhado)
    }
    this.parts = [];
  }
}

/* ============================================================
   NAME SPRITE
   ============================================================ */
function createNameSprite(name, opts) {
  const W = 512, H = 160;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const padX = 26, padY = 18;
  const bx = padX, by = padY, bw = W - padX * 2, bh = H - padY * 2;
  roundRectPath(ctx, bx, by, bw, bh, 20);
  ctx.fillStyle = opts.isLocal ? 'rgba(10, 32, 58, 0.72)' : 'rgba(0, 0, 0, 0.55)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = opts.isLocal ? 'rgba(255, 214, 74, 0.95)' : 'rgba(255, 255, 255, 0.22)';
  ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 52px Verdana, Geneva, Arial, sans-serif';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeText(name, W / 2, 62);
  ctx.fillStyle = opts.isLocal ? '#ffe97a' : '#ffffff';
  ctx.fillText(name, W / 2, 62);
  if (opts.subtitle) {
    ctx.font = 'bold 30px Verdana, Geneva, Arial, sans-serif';
    ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(opts.subtitle, W / 2, 118);
    ctx.fillStyle = opts.subtitleColor || '#6fe36f';
    ctx.fillText(opts.subtitle, W / 2, 118);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.2, 1.31, 1);
  return sprite;
}

/* ============================================================
   STUD TEXTURE
   ============================================================ */
const __texLoader = new THREE.TextureLoader();
let __studBase = null;
let __studLoaded = false;
let __studReadyResolve = null;
const __studReadyPromise = new Promise((resolve) => { __studReadyResolve = resolve; });

function __makeProceduralStudTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);

  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.arc(32, 33, 12, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath(); ctx.arc(32, 31, 12, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.arc(32, 30, 10, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.beginPath(); ctx.arc(32, 32, 8, 0, Math.PI * 2); ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  console.log('[game] procedural stud texture created');
  return tex;
}

(function preloadStud() {
  const candidates = ['stud.png', 'Stud.png', 'STUD.png', '/stud.png'];
  let idx = 0;

  function finish(tex) {
    __studBase = tex;
    __studLoaded = true;
    if (__studReadyResolve) __studReadyResolve();
  }

  function useFallback() {
    console.warn('[game] stud.png not found — using procedural fallback');
    finish(__makeProceduralStudTexture());
  }

  function tryNext() {
    if (idx >= candidates.length) return useFallback();
    const url = candidates[idx++];
    console.log('[game] → trying texture:', url);
    __texLoader.load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.anisotropy = 8;
        console.log('[game] ✅ stud loaded from:', url);
        finish(tex);
      },
      undefined,
      () => {
        console.warn('[game] ✗ failed:', url);
        tryNext();
      }
    );
  }

  tryNext();
})();

function getStudTexture(repeatX, repeatY) {
  if (!__studBase) return null;
  const tex = __studBase.clone();
  tex.needsUpdate = true;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(Math.max(1, repeatX), Math.max(1, repeatY));
  return tex;
}

/* ============================================================
   GEOMETRY HELPERS
   ============================================================ */
function makeGeometryForPart(p) {
  const kind = p.kind || 'Part';
  const sx = p.sx, sy = p.sy, sz = p.sz;

  if (kind === 'Sphere') {
    return new THREE.SphereGeometry(Math.min(sx, sy, sz) / 2, 24, 16);
  }

  if (kind === 'Cylinder') {
    return new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 24);
  }

  if (kind === 'Wedge') {
    const w = sx / 2, h = sy / 2, d = sz / 2;
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([
      -w,-h, d,  w,-h, d, -w, h, d,
      -w,-h, d,  w,-h, d,  w,-h,-d,
      -w,-h, d,  w,-h,-d, -w,-h,-d,
      -w,-h, d, -w, h, d, -w,-h,-d,
      -w,-h,-d,  w,-h,-d, -w, h, d,
       w,-h,-d,  w,-h, d, -w, h, d,
       w,-h, d,  w,-h,-d, -w, h, d,
      -w, h, d,  w,-h, d,  w,-h,-d
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  }

  if (kind === 'CornerWedge') {
    const w = sx / 2, h = sy / 2, d = sz / 2;
    const g = new THREE.BufferGeometry();
    const v = new Float32Array([
      -w,-h, d,  w,-h, d, -w,-h,-d,
      -w,-h, d,  w,-h, d, -w, h, d,
      -w,-h, d, -w, h, d, -w,-h,-d,
       w,-h, d, -w, h, d,  w,-h,-d,
       w,-h, d,  w,-h,-d, -w,-h,-d,
      -w, h, d,  w,-h, d,  w,-h,-d
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  }

  return new THREE.BoxGeometry(sx, sy, sz);
}

function buildMaterialsForPart(p, colorNum, transparency) {
  const kind = p.kind || 'Part';
  const sx = p.sx, sy = p.sy, sz = p.sz;

  const sideMat = new THREE.MeshLambertMaterial({ color: colorNum });
  const topTex = getStudTexture(sx, sz);
  const topMat = topTex
    ? new THREE.MeshLambertMaterial({ color: colorNum, map: topTex })
    : new THREE.MeshLambertMaterial({ color: colorNum });

  if (transparency && transparency > 0) {
    sideMat.transparent = true; sideMat.opacity = 1 - transparency;
    topMat.transparent = true;  topMat.opacity = 1 - transparency;
  }

  if (kind === 'Sphere') return sideMat;
  if (kind === 'Cylinder') return [sideMat, topMat, sideMat];
  if (kind === 'Wedge' || kind === 'CornerWedge') return sideMat;
  return [sideMat, sideMat, topMat, sideMat, sideMat, sideMat];
}

function computeRotatedAABB(sx, sy, sz, rx, ry, rz) {
  const rxr = THREE.MathUtils.degToRad(rx || 0);
  const ryr = THREE.MathUtils.degToRad(ry || 0);
  const rzr = THREE.MathUtils.degToRad(rz || 0);
  const euler = new THREE.Euler(rxr, ryr, rzr, 'XYZ');
  const quat = new THREE.Quaternion().setFromEuler(euler);

  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const corners = [
    new THREE.Vector3(-hx, -hy, -hz),
    new THREE.Vector3( hx, -hy, -hz),
    new THREE.Vector3(-hx,  hy, -hz),
    new THREE.Vector3( hx,  hy, -hz),
    new THREE.Vector3(-hx, -hy,  hz),
    new THREE.Vector3( hx, -hy,  hz),
    new THREE.Vector3(-hx,  hy,  hz),
    new THREE.Vector3( hx,  hy,  hz)
  ];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const c of corners) {
    c.applyQuaternion(quat);
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.z < minZ) minZ = c.z;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
    if (c.z > maxZ) maxZ = c.z;
  }

  return {
    sx: maxX - minX,
    sy: maxY - minY,
    sz: maxZ - minZ
  };
}

/* ============================================================
   GENERATORS
   ============================================================ */
const GENERATORS = {
  empty(scene, physics) {
    const bpTex = getStudTexture(128, 128);
    const bpSide = new THREE.MeshLambertMaterial({ color: 0xcfcfcf });
    const bpTop = bpTex
      ? new THREE.MeshLambertMaterial({ color: 0xcfcfcf, map: bpTex })
      : new THREE.MeshLambertMaterial({ color: 0xcfcfcf });
    const bpMats = [bpSide, bpSide, bpTop, bpSide, bpSide, bpSide];
    const ground = new THREE.Mesh(new THREE.BoxGeometry(128, 2, 128), bpMats);
    ground.position.set(0, -1, 0);
    ground.receiveShadow = true;
    scene.add(ground);
    physics.addBox(0, -1, 0, 128, 2, 128);
  },

  blocky_world(scene, physics, data) {
    data = data || {};
    const worldMat = {};
    const getMat = (color) => {
      if (!worldMat[color]) worldMat[color] = new THREE.MeshLambertMaterial({ color });
      return worldMat[color];
    };
    function box(x, y, z, sx, sy, sz, color, opts = {}) {
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const mesh = new THREE.Mesh(geo, opts.material || getMat(color));
      mesh.position.set(x, y, z);
      mesh.castShadow = opts.castShadow !== false;
      mesh.receiveShadow = opts.receiveShadow !== false;
      scene.add(mesh);
      if (opts.collide !== false) physics.addBox(x, y, z, sx, sy, sz);
      return mesh;
    }
    const bpTex = getStudTexture(120, 120);
    const bpSide = new THREE.MeshLambertMaterial({ color: 0x6ab04c });
    const bpTop = bpTex
      ? new THREE.MeshLambertMaterial({ color: 0x6ab04c, map: bpTex })
      : new THREE.MeshLambertMaterial({ color: 0x6ab04c });
    const bpMats = [bpSide, bpSide, bpTop, bpSide, bpSide, bpSide];
    const bp = new THREE.Mesh(new THREE.BoxGeometry(120, 2, 120), bpMats);
    bp.position.set(0, -1, 0);
    bp.receiveShadow = true;
    scene.add(bp);
    physics.addBox(0, -1, 0, 120, 2, 120);

    const roadMat = new THREE.MeshLambertMaterial({ color: 0x54545e });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(120, 12), roadMat);
    road.rotation.x = -Math.PI / 2; road.position.set(0, 0.03, 0); road.receiveShadow = true;
    scene.add(road);
    const lineMat = new THREE.MeshLambertMaterial({ color: 0xe9e9e9 });
    for (let x = -56; x <= 56; x += 9) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.55), lineMat);
      line.rotation.x = -Math.PI / 2; line.position.set(x, 0.06, 0); scene.add(line);
    }
    box(0, 0.15, 7.5, 120, 0.3, 3, 0xbdbdbd, { castShadow: false });
    box(0, 0.15, -7.5, 120, 0.3, 3, 0xbdbdbd, { castShadow: false });

    function buildHouse(cx, cz, w, d, wallColor, roofColor, facing) {
      const wallT = 0.6, wallH = 10, doorW = 4, doorH = 7;
      const front = cz + facing * (d / 2 - wallT / 2);
      const back  = cz - facing * (d / 2 - wallT / 2);
      box(cx, wallH / 2, back, w, wallH, wallT, wallColor);
      box(cx - w / 2 + wallT / 2, wallH / 2, cz, wallT, wallH, d, wallColor);
      box(cx + w / 2 - wallT / 2, wallH / 2, cz, wallT, wallH, d, wallColor);
      const sideW = (w - doorW) / 2;
      box(cx - (doorW / 2 + sideW / 2), wallH / 2, front, sideW, wallH, wallT, wallColor);
      box(cx + (doorW / 2 + sideW / 2), wallH / 2, front, sideW, wallH, wallT, wallColor);
      const lintelH = wallH - doorH;
      box(cx, doorH + lintelH / 2, front, doorW, lintelH, wallT, wallColor);
      box(cx, 0.1, cz, w - 0.4, 0.2, d - 0.4, 0x8a6a4a, { castShadow: false });
      box(cx, wallH + 0.4, cz, w + 1.4, 0.8, d + 1.4, roofColor);
      box(cx + w * 0.28, wallH + 2.4, cz - d * 0.24, 1.6, 3.4, 1.6, 0x8d8d8d);
      const winMat = new THREE.MeshLambertMaterial({ color: 0x9fdcf5 });
      const winGeo = new THREE.BoxGeometry(0.16, 2.4, 2.4);
      [-1, 1].forEach((side) => {
        const wx = cx + side * (w / 2 - wallT / 2);
        const win = new THREE.Mesh(winGeo, winMat);
        win.position.set(wx, 5.4, cz);
        win.castShadow = false;
        scene.add(win);
      });
    }
    buildHouse(-32, -22, 18, 14, 0xd9c6a5, 0xa63b2f, 1);
    buildHouse( 32, -22, 16, 14, 0xe0d3b8, 0x7a4a2b, 1);
    buildHouse(-32,  22, 18, 14, 0xc9b8a8, 0x8a3b3b, -1);
    buildHouse( 32,  22, 16, 14, 0xd9c6a5, 0xa63b2f, -1);
    buildHouse(  0, -40, 22, 16, 0xe0d3b8, 0x7a4a2b, 1);

    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
    const leafMats = [
      new THREE.MeshLambertMaterial({ color: 0x3f8f3f }),
      new THREE.MeshLambertMaterial({ color: 0x4aa04a }),
      new THREE.MeshLambertMaterial({ color: 0x357a35 })
    ];
    function buildTree(x, z, scale = 1) {
      const trunkH = 6 * scale, trunkR = 0.7 * scale;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(trunkR * 0.85, trunkR, trunkH, 8), trunkMat);
      trunk.position.set(x, trunkH / 2, z);
      trunk.castShadow = true; trunk.receiveShadow = true;
      scene.add(trunk);
      physics.addBox(x, trunkH / 2, z, trunkR * 1.7, trunkH, trunkR * 1.7);
      const leafMat = leafMats[Math.floor(Math.random() * leafMats.length)];
      const r1 = 2.9 * scale, r2 = 2.1 * scale, r3 = 1.3 * scale;
      const c1 = new THREE.Mesh(new THREE.IcosahedronGeometry(r1, 0), leafMat);
      c1.position.set(x, trunkH + r1 * 0.55, z); c1.castShadow = true; c1.receiveShadow = true;
      scene.add(c1);
      const c2 = new THREE.Mesh(new THREE.IcosahedronGeometry(r2, 0), leafMat);
      c2.position.set(x + r1 * 0.5, trunkH + r1 * 1.1, z - r1 * 0.35); c2.castShadow = true;
      scene.add(c2);
      const c3 = new THREE.Mesh(new THREE.IcosahedronGeometry(r3, 0), leafMat);
      c3.position.set(x - r1 * 0.45, trunkH + r1 * 1.25, z + r1 * 0.4); c3.castShadow = true;
      scene.add(c3);
    }
    [
      [-52, -25], [52, -25], [-52, 25], [52, 25],
      [-16, -14], [16, -20], [-16, 14], [16, 14],
      [0, 32], [-26, 42], [26, 42], [0, -54],
      [-46, 14], [46, -14]
    ].forEach(([x, z], i) => buildTree(x, z, 0.9 + (i % 3) * 0.12));

    const platColor = 0x9b7653;
    [
      [10, 2.0, -10, 6, 1, 6], [16, 4.5, -10, 6, 1, 6], [22, 7.0, -10, 6, 1, 6],
      [28, 9.5, -10, 6, 1, 6], [34, 12.0, -10, 8, 1, 8]
    ].forEach(([x, y, z, sx, sy, sz]) => box(x, y, z, sx, sy, sz, platColor));

    const goldMat = new THREE.MeshLambertMaterial({ color: 0xffd700, emissive: 0x554400 });
    box(34, 13.9, -10, 2.2, 2.2, 2.2, 0xffd700, { material: goldMat });

    const crateColor = 0xb98a4b;
    box(6, 1, 14, 2, 2, 2, crateColor);
    box(6, 3, 14, 2, 2, 2, crateColor);
    box(8, 1, 14, 2, 2, 2, crateColor);
    box(7, 1, 16, 2, 2, 2, crateColor);
    box(-9, 1, 16, 2, 2, 2, crateColor);
    box(-9, 3, 16, 2, 2, 2, crateColor);
    box(-11, 1, 16, 2, 2, 2, crateColor);

    function buildBench(x, z) {
      box(x, 1.4, z, 4.4, 0.4, 1.4, 0x8b5a2b);
      box(x - 1.7, 0.7, z, 0.4, 1.4, 1.2, 0x5a3d1e);
      box(x + 1.7, 0.7, z, 0.4, 1.4, 1.2, 0x5a3d1e);
      box(x, 2.6, z - 0.6, 4.4, 1.6, 0.25, 0x8b5a2b);
    }
    buildBench(-30, 10); buildBench(30, 10); buildBench(-30, -10); buildBench(30, -10);

    const poleMat = new THREE.MeshLambertMaterial({ color: 0x6b6b6b });
    const lampMat = new THREE.MeshLambertMaterial({ color: 0xfff2b0, emissive: 0x554400 });
    function buildLamp(x, z) {
      const poleH = 12;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, poleH, 8), poleMat);
      pole.position.set(x, poleH / 2, z); pole.castShadow = true; pole.receiveShadow = true;
      scene.add(pole);
      physics.addBox(x, poleH / 2, z, 0.9, poleH, 0.9);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 1.8), lampMat);
      lamp.position.set(x, poleH + 0.5, z); lamp.castShadow = true;
      scene.add(lamp);
    }
    [-40, -20, 0, 20, 40].forEach((x) => { buildLamp(x, 10.5); buildLamp(x, -10.5); });

    box(-50, 3, -20, 1.2, 6, 16, 0xcfcfcf);
    box(50, 3, 20, 1.2, 6, 16, 0xcfcfcf);
    box(0, 3, 46, 22, 6, 1.2, 0xcfcfcf);
    box(-45, 1, -45, 14, 2, 14, 0x5fa344, { castShadow: false });
    box(45, 1.5, 45, 16, 3, 16, 0x5fa344, { castShadow: false });
    box(-45, 3, -45, 6, 2, 6, 0x4f8f38);

    const boundColor = 0x7f8c8d;
    box(0, 8, -60, 122, 16, 2, boundColor);
    box(0, 8, 60, 122, 16, 2, boundColor);
    box(-60, 8, 0, 2, 16, 122, boundColor);
    box(60, 8, 0, 2, 16, 122, boundColor);
  },

  custom_build(scene, physics, data) {
    const parts0 = (data && data.parts) || [];
    const hasCustomBaseplate = parts0.some(p => p.isBaseplate === true);
    const skipBP = (data && data.noBaseplate === true) || hasCustomBaseplate;
    if (!skipBP) {
      const BP = 256;
      const bpTex = getStudTexture(BP, BP);
      const bpSide = new THREE.MeshLambertMaterial({ color: 0xcfcfcf });
      const bpTop = bpTex
        ? new THREE.MeshLambertMaterial({ color: 0xcfcfcf, map: bpTex })
        : new THREE.MeshLambertMaterial({ color: 0xcfcfcf });
      const bpMats = [bpSide, bpSide, bpTop, bpSide, bpSide, bpSide];
      const baseplate = new THREE.Mesh(new THREE.BoxGeometry(BP, 2, BP), bpMats);
      baseplate.position.set(0, -1, 0);
      baseplate.receiveShadow = true;
      baseplate.castShadow = false;
      scene.add(baseplate);
      physics.addBox(0, -1, 0, BP, 2, BP);
    }

    const parts = (data && data.parts) || [];
    for (const p of parts) {
      const colorNum = typeof p.color === 'number'
        ? p.color
        : parseInt(String(p.color).replace('#', ''), 16);

      const geo = makeGeometryForPart(p);
      const mats = buildMaterialsForPart(p, colorNum, p.transparency || 0);

      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set(p.x, p.y, p.z);
      if (p.rx) mesh.rotation.x = THREE.MathUtils.degToRad(p.rx);
      if (p.ry) mesh.rotation.y = THREE.MathUtils.degToRad(p.ry);
      if (p.rz) mesh.rotation.z = THREE.MathUtils.degToRad(p.rz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      if (p.anchored !== false) {
        const aabb = computeRotatedAABB(
          p.sx, p.sy, p.sz,
          p.rx || 0, p.ry || 0, p.rz || 0
        );
        physics.addBox(p.x, p.y, p.z, aabb.sx, aabb.sy, aabb.sz);
      }

      if (Array.isArray(p.decals) && p.decals.length) {
        const sz = { x: p.sx, y: p.sy, z: p.sz };
        const off = 0.02;
        for (const d of p.decals) {
          if (!d.url) continue;
          try {
            const tex = new THREE.TextureLoader().load(d.url);
            tex.colorSpace = THREE.SRGBColorSpace;
            const op = 1 - (d.transparency || 0);
            const dm = new THREE.MeshStandardMaterial({
              map: tex,
              transparent: true,
              opacity: op,
              roughness: 0.9,
              metalness: 0,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: -4,
              polygonOffsetUnits: -4
            });

            let pw, ph, x = 0, y = 0, z = 0, rx = 0, ry = 0;
            switch (d.face) {
              case 'Front':  pw = sz.x * 0.98; ph = sz.y * 0.98; z =  sz.z/2 + off; break;
              case 'Back':   pw = sz.x * 0.98; ph = sz.y * 0.98; z = -sz.z/2 - off; ry = Math.PI; break;
              case 'Left':   pw = sz.z * 0.98; ph = sz.y * 0.98; x = -sz.x/2 - off; ry = -Math.PI/2; break;
              case 'Right':  pw = sz.z * 0.98; ph = sz.y * 0.98; x =  sz.x/2 + off; ry =  Math.PI/2; break;
              case 'Top':    pw = sz.x * 0.98; ph = sz.z * 0.98; y =  sz.y/2 + off; rx = -Math.PI/2; break;
              case 'Bottom': pw = sz.x * 0.98; ph = sz.z * 0.98; y = -sz.y/2 - off; rx =  Math.PI/2; break;
              default: continue;
            }

            const dg = new THREE.PlaneGeometry(pw, ph);
            const dmesh = new THREE.Mesh(dg, dm);
            dmesh.position.set(x, y, z);
            dmesh.rotation.set(rx, ry, 0);
            mesh.add(dmesh);
          } catch (e) {
            console.warn('[game] decal load failed:', d.url, e);
          }
        }
      }
    }

    if (Array.isArray(data.sounds) && data.sounds.length) {
      try {
        const listener = new THREE.AudioListener();
        scene.add(listener);

        data.sounds.forEach((sd) => {
          try {
            if (!sd.url) return;

            const audio = sd.positional
              ? new THREE.PositionalAudio(listener)
              : new THREE.Audio(listener);

            if (sd.positional) {
              const proxy = new THREE.Object3D();
              proxy.position.set(
                typeof sd.x === 'number' ? sd.x : 0,
                typeof sd.y === 'number' ? sd.y : 5,
                typeof sd.z === 'number' ? sd.z : 0
              );
              scene.add(proxy);
              proxy.add(audio);
              audio.setRefDistance(6);
              audio.setRolloffFactor(1.2);
            }

            const loader = new THREE.AudioLoader();
            loader.load(
              sd.url,
              (buffer) => {
                audio.setBuffer(buffer);
                audio.setLoop(!!sd.loop);
                audio.setVolume(typeof sd.volume === 'number' ? sd.volume : 0.8);

                if (sd.autoplay) {
                  const tryPlay = () => {
                    try {
                      if (typeof audio.play !== 'function') return;
                      if (audio.context && audio.context.state === 'suspended') {
                        audio.context.resume().then(() => {
                          try { audio.play(); } catch (_) {}
                        }).catch(() => {});
                      } else {
                        try { audio.play(); } catch (_) {}
                      }
                    } catch (e) {
                      console.warn('[game] autoplay failed:', sd.name, e);
                    }
                  };
                  tryPlay();
                }
              },
              undefined,
              (err) => console.warn('[game] audio load failed:', sd.name, err)
            );
          } catch (e) {
            console.warn('[game] audio setup error:', sd.name, e);
          }
        });
      } catch (e) {
        console.warn('[game] sound system error:', e);
      }
    }
  }
};

/* ============================================================
   REMOTE PLAYER
   ============================================================ */
class RemotePlayer {
  constructor(info) {
    this.id = info.id;
    this.name = info.name;
    this.isNPC = !!info.npc;
    this.isAdm = !!info.is_adm;
    this.colors = normalizeAvatarColors(info.avatar_colors || NOOB_COLORS);
    this.equippedItems = info.equipped_items || null;

    this.character = new Character({
      name: info.name,
      colors: this.colors,
      equippedItems: this.equippedItems,
      isLocal: false,
      subtitle: this.isNPC ? 'NPC' : (this.isAdm ? 'ADM' : 'ONLINE'),
      subtitleColor: this.isNPC ? '#8ac6ff' : (this.isAdm ? '#ff3b3b' : '#6fe36f')
    });

    this.character.setPosition(info.x, info.y, info.z);
    this.character.setYaw(info.yaw || 0);
    this.character.group.userData.playerId = info.id;

    this.targetPos = new THREE.Vector3(info.x, info.y, info.z);
    this.targetYaw = info.yaw || 0;
    this.hSpeed = 0;
    this.grounded = true;

    this.health = this.character.maxHealth;
    this.dead = false;
    this._wasDead = false;

    this.character.loadEquipment().catch(e => console.warn('[remote] equip load failed', e));
  }

  applyState(s) {
    this.targetPos.set(s.x, s.y, s.z);
    this.targetYaw = s.yaw;
    this.hSpeed = s.hs || 0;
    this.grounded = s.g !== false;
    if (typeof s.hp === 'number') this.health = s.hp;
    if (typeof s.dead === 'boolean') this.dead = s.dead;
  }

  applyEquipUpdate(equippedItems) {
    this.equippedItems = equippedItems;
    if (this.character) this.character.equippedItems = equippedItems;
  }

  update(dt) {
    const c = this.character, body = c.body;

    /* CORREÇÃO: esconder o personagem quando estiver morto (ragdoll),
       e mostrar de novo ao renascer — assim o respawn fica visível
       para todos os jogadores na sala. */
    if (this.dead) {
      if (!this._wasDead) {
        c.setVisible(false);
        this._wasDead = true;
      }
      return; // não anima/atualiza posição enquanto está morto
    } else {
      if (this._wasDead) {
        // renasceu — reposiciona e mostra de novo
        this._wasDead = false;
        c.body.pos.copy(this.targetPos);
        c.group.position.copy(this.targetPos);
        c.setVisible(true);
      }
    }

    const k = 1 - Math.exp(-14 * dt);
    body.pos.lerp(this.targetPos, k);
    c.targetYaw = this.targetYaw;
    body.grounded = this.grounded;
    body.vel.x = Math.sin(c.visualYaw) * this.hSpeed;
    body.vel.z = Math.cos(c.visualYaw) * this.hSpeed;
    c.updateVisual(dt, this.hSpeed);
  }

  dispose(scene) {
    scene.remove(this.character.group);
  }
}

/* ============================================================
   NETWORK
   ============================================================ */
class Network {
  constructor(game) {
    this.game = game;
    this.ws = null;
    this.id = null;
    this.connected = false;
    this.remotePlayers = new Map();
    this.sendTimer = 0;
    this.sendInterval = 0.05;
    this.username = 'Player';
    this.avatar_colors = null;
    this.equipped_items = null;
    this.isAdm = false;
    this.room = 'default';
    this.userId = null;
    this.reconnectTimer = 0;
    this.shouldReconnect = true;
    this.onStatusChange = null;
    this.kicked = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws`;
    this._setStatus('connecting');
    try { this.ws = new WebSocket(url); }
    catch { this._setStatus('error'); return; }

    this.ws.onopen = () => {
      this.connected = true;
      this._setStatus('online');
      this._send({
        type: 'join',
        name: this.username,
        avatar_colors: this.avatar_colors,
        equipped_items: this.equipped_items || {},
        is_adm: this.isAdm,
        game: this.room,
        user_id: this.userId
      });
    };
    this.ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      this._handle(msg);
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this.connected = false;
      this._setStatus('offline');
      for (const rp of this.remotePlayers.values()) rp.dispose(this.game.scene);
      this.remotePlayers.clear();
      this.game._updateHudPlayers();
      if (this.shouldReconnect && !this.kicked) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (!this.connected) this.connect();
        }, 2500);
      }
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) { try { this.ws.close(); } catch {} }
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(data)); } catch {}
    }
  }

  _setStatus(s) { if (this.onStatusChange) this.onStatusChange(s); }

  _handle(msg) {
    switch (msg.type) {
      case 'error':
        if (msg.code === 'already_playing') {
          this.kicked = true;
          this.shouldReconnect = false;
          if (this.ws) { try { this.ws.close(); } catch {} }
          this.game._showFatalError(
            msg.message || 'This account is already playing in another tab.'
          );
        }
        break;
      case 'welcome':
        this.id = msg.id;
        if (msg.room) this.room = msg.room;
        for (const p of msg.players) this._addRemote(p);
        this.game._updateHudPlayers();
        break;
      case 'player_join':
        this._addRemote(msg.player);
        this.game._updateHudPlayers();
        break;
      case 'player_leave':
        this._removeRemote(msg.id);
        this.game._updateHudPlayers();
        break;
      case 'player_equip': {
        const rp = this.remotePlayers.get(msg.id);
        if (rp) rp.applyEquipUpdate(msg.equipped_items);
        break;
      }
      case 'states':
        for (const s of msg.states) {
          if (s.id === this.id) continue;
          let rp = this.remotePlayers.get(s.id);
          if (!rp) {
            rp = this._addRemote({
              id: s.id, name: 'Player_' + s.id, npc: s.npc,
              x: s.x, y: s.y, z: s.z, yaw: s.yaw,
              avatar_colors: null, equipped_items: null, is_adm: false
            });
            this.game._updateHudPlayers();
          }
          rp.applyState(s);
        }
        break;
      case 'chat':
        this.game.chat.addMessage(msg.name, msg.text, nameToColor(msg.name));
        break;
    }
  }

  _addRemote(info) {
    const existing = this.remotePlayers.get(info.id);
    if (existing) return existing;
    const rp = new RemotePlayer(info);
    this.game.scene.add(rp.character.group);
    this.remotePlayers.set(info.id, rp);
    return rp;
  }

  _removeRemote(id) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    rp.dispose(this.game.scene);
    this.remotePlayers.delete(id);
  }

  sendState() {
    const p = this.game.player.body;
    this._send({
      type: 'state',
      x: +p.pos.x.toFixed(2), y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2),
      yaw: +this.game.player.visualYaw.toFixed(3),
      vy: +p.vel.y.toFixed(1),
      hs: +Math.hypot(p.vel.x, p.vel.z).toFixed(2),
      g: p.grounded,
      hp: Math.round(this.game.player.health),
      dead: !!this.game.player.dead
    });
  }

  sendChat(text) { this._send({ type: 'chat', text }); }

  update(dt) {
    for (const rp of this.remotePlayers.values()) rp.update(dt);
    if (this.connected) {
      this.sendTimer += dt;
      if (this.sendTimer >= this.sendInterval) { this.sendTimer = 0; this.sendState(); }
    }
  }

  get realPlayerCount() {
    let n = 0;
    for (const rp of this.remotePlayers.values()) if (!rp.isNPC) n++;
    return n;
  }
}


/* ============================================================
   CHAT
   ============================================================ */
class ChatSystem {
  constructor() {
    this.el = document.getElementById('chat');
    this.messagesEl = document.getElementById('chat-messages');
    this.inputEl = document.getElementById('chat-input');
    this.maxMessages = 200;
    this.onOpen = null;
    this.onClose = null;
    this.onPlayerMessage = null;
    this.onCommand = null;
    this._userScrolled = false;
    this._scrollThreshold = 40;

    this.messagesEl.addEventListener('scroll', () => {
      const el = this.messagesEl;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      this._userScrolled = distanceFromBottom > this._scrollThreshold;
    });

    this.inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.inputEl.value.trim();
        if (text) {
          if (text.startsWith('/')) {
            this.addMessage('>', text, '#8ac6ff');
            if (this.onCommand) {
              const parts = text.slice(1).split(/\s+/).filter(Boolean);
              if (parts.length) this.onCommand(parts[0].toLowerCase(), parts.slice(1));
            }
          } else {
            const name = window.__playerName || 'Player';
            this.addMessage(name, text, '#ffe97a');
            if (this.onPlayerMessage) this.onPlayerMessage(text);
          }
        }
        this.close();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.inputEl.value = '';
        this.close();
      }
    });
  }

  isFocused() { return document.activeElement === this.inputEl; }

  open() {
    this.el.classList.add('open');
    this.inputEl.value = '';
    this.inputEl.focus();
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.onOpen) this.onOpen();
  }

  close() {
    this.el.classList.remove('open');
    this.inputEl.blur();
    if (this.onClose) this.onClose();
  }

  addMessage(name, text, color = '#ffffff') {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.style.color = color;
    nameSpan.textContent = name + ': ';
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    div.appendChild(nameSpan);
    div.appendChild(textSpan);
    this.messagesEl.appendChild(div);

    while (this.messagesEl.children.length > this.maxMessages) {
      this.messagesEl.removeChild(this.messagesEl.firstChild);
    }

    if (!this._userScrolled) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }
}

/* ============================================================
   INPUT
   ============================================================ */
class InputManager {
  constructor() {
    this.keys = new Set();
    this.mouseDX = 0; this.mouseDY = 0;
    this.locked = false; this.jumpQueued = false;
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.jumpHeld = false;
  }
  isDown(code) { return this.keys.has(code); }
  clear() {
    this.keys.clear();
    this.jumpQueued = false;
    this.jumpHeld = false;
  }
}

/* ============================================================
   HUD
   ============================================================ */
class HUD {
  constructor() {
    this.fpsEl = document.getElementById('hud-fps');
    this.playersEl = document.getElementById('hud-players');
    this.userEl = document.getElementById('hud-user');
    this.connEl = document.getElementById('hud-conn');
    this.gameEl = document.getElementById('hud-game');
  }
  setFPS(v) { if (this.fpsEl) this.fpsEl.textContent = String(v); }
  setPlayers(v) { if (this.playersEl) this.playersEl.textContent = String(v); }
  setUser(name) { if (this.userEl) this.userEl.textContent = name; }
  setGame(name) { if (this.gameEl) this.gameEl.textContent = name; }
  setConnection(state) {
    const el = this.connEl;
    if (!el) return;
    el.classList.remove('conn-on', 'conn-off', 'conn-wait');
    if (state === 'online') { el.textContent = 'ONLINE'; el.classList.add('conn-on'); }
    else if (state === 'connecting') { el.textContent = 'CONNECTING'; el.classList.add('conn-wait'); }
    else { el.textContent = 'OFFLINE'; el.classList.add('conn-off'); }
  }
}

/* ============================================================
   ESC MENU
   ============================================================ */
class EscMenu {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('esc-menu');
    this.isOpen = false;
    this._bind();
  }

  _bind() {
    document.getElementById('esc-close').addEventListener('click', () => this.hide());
    document.querySelectorAll('.esc-tab').forEach(t => {
      t.addEventListener('click', () => this._selectTab(t.dataset.tab));
    });
    document.getElementById('esc-restart').addEventListener('click', () => {
      this.game.restartPlayer();
      this.hide();
    });
    document.getElementById('esc-reset-cam').addEventListener('click', () => {
      this.game.camYaw = 0;
      this.game.camPitch = 0.28;
      this.game.camDistance = 16;
      this.hide();
    });
    document.getElementById('esc-exit').addEventListener('click', () => {
      if (this.game.network) this.game.network.disconnect();
      window.location.href = 'index.html';
    });

    const sens = document.getElementById('set-sens');
    sens.value = Math.round(this.game.settings.sensitivity * 1000);
    document.getElementById('set-sens-val').textContent = sens.value;
    sens.addEventListener('input', () => {
      const v = parseInt(sens.value);
      document.getElementById('set-sens-val').textContent = v;
      this.game.settings.sensitivity = v / 1000;
    });

    const dist = document.getElementById('set-dist');
    dist.value = this.game.camDistance;
    document.getElementById('set-dist-val').textContent = dist.value;
    dist.addEventListener('input', () => {
      const v = parseInt(dist.value);
      document.getElementById('set-dist-val').textContent = v;
      this.game.camDistance = v;
    });

    const inv = document.getElementById('set-inv');
    inv.checked = this.game.settings.invertY;
    inv.addEventListener('change', () => { this.game.settings.invertY = inv.checked; });

    const vol = document.getElementById('set-vol');
    vol.addEventListener('input', () => {
      document.getElementById('set-vol-val').textContent = vol.value;
    });

    const fps = document.getElementById('set-fps');
    fps.addEventListener('change', () => {
      const h = document.getElementById('hud-fps');
      if (h) h.style.visibility = fps.checked ? 'visible' : 'hidden';
    });
  }

  _selectTab(name) {
    document.querySelectorAll('.esc-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.esc-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
    if (name === 'players') this._renderPlayers();
  }

  show() {
    this.isOpen = true;
    this.el.classList.add('open');
    if (document.pointerLockElement) document.exitPointerLock();
    this._selectTab('players');
  }

  hide() {
    this.isOpen = false;
    this.el.classList.remove('open');
    this.game._requestLock();
  }

  toggle() { this.isOpen ? this.hide() : this.show(); }

  async _renderPlayers() {
    const list = document.getElementById('esc-players-list');
    list.innerHTML = '<div class="esc-empty">Loading...</div>';

    const me = this.game.profile;
    if (!me) return;

    const remotes = [];
    for (const rp of this.game.network.remotePlayers.values()) {
      if (!rp.isNPC) remotes.push({
        id: rp.id, name: rp.name, adm: !!rp.isAdm,
        avatar_colors: rp.colors
      });
    }

    let frs = [];
    const byName = {};
    if (remotes.length) {
      const names = remotes.map(r => r.name);
      const { data: profs } = await sb.from('profiles').select('id,username,is_adm').in('username', names);
      (profs || []).forEach(p => byName[p.username.toLowerCase()] = p);

      const myId = me.id;
      const otherIds = (profs || []).map(p => p.id);
      if (otherIds.length) {
        const { data: rows } = await sb.from('friend_requests').select('*')
          .or('sender_id.eq.' + myId + ',receiver_id.eq.' + myId);
        frs = rows || [];
      }

      for (const r of remotes) {
        const prof = byName[r.name.toLowerCase()];
        r.profile = prof || null;
        if (prof) {
          const f = frs.find(x =>
            (x.sender_id === myId && x.receiver_id === prof.id) ||
            (x.sender_id === prof.id && x.receiver_id === myId));
          r.friend_status = f ? f.status : null;
        }
      }
    }

    const all = [{
      id: 'me', name: me.username, adm: !!me.is_adm,
      self: true, avatar_colors: me.avatar_colors
    }, ...remotes];

    list.innerHTML = '';
    for (const p of all) {
      const row = document.createElement('div');
      row.className = 'esc-player';
      row.innerHTML =
        '<div class="pav"></div>' +
        '<div class="pinfo">' +
          '<div class="pname">' + escapeHtml(p.name) +
            (p.adm ? '<span class="adm">ADM</span>' : '') +
            (p.self ? '<span class="badge-self">YOU</span>' : '') +
            (p.friend_status === 'accepted' ? '<span class="badge-friend">FRIEND</span>' : '') +
            (p.friend_status === 'pending' ? '<span class="badge-pending">PENDING</span>' : '') +
          '</div>' +
          '<div class="pid">#' + (p.profile?.id ? p.profile.id.slice(0,8) : (p.self ? 'self' : '-')) + '</div>' +
        '</div>' +
        (!p.self && !p.friend_status ?
          '<button class="pbtn" data-name="' + escapeHtml(p.name) + '">Add Friend</button>' :
         (!p.self && p.friend_status === 'accepted' ? '<span style="color:#6fe36f;font-size:11px">Friend</span>' :
         (!p.self && p.friend_status === 'pending' ? '<span style="color:#ffd166;font-size:11px">Pending</span>' : '')));

      list.appendChild(row);

      const pav = row.querySelector('.pav');
      this._mountMini(pav, p.avatar_colors);

      const btn = row.querySelector('.pbtn');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true; btn.textContent = '...';
          const { data, error } = await sb.rpc('send_friend_request', { target_username: p.name });
          if (error || (data && data.error)) {
            btn.textContent = 'Error';
            setTimeout(() => { btn.textContent = 'Add Friend'; btn.disabled = false; }, 1500);
          } else {
            btn.textContent = 'Sent';
            btn.disabled = true;
            this.game.chat.addMessage('SYSTEM', 'Friend request sent to ' + p.name, '#6fe36f');
          }
        });
      }
    }
  }

  async _mountMini(container, colors) {
    const THREE = await import('three');
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0.4, 12);
    camera.lookAt(0, 0.4, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(5, 8, 6); scene.add(dl);

    const c = normalizeAvatarColors(colors || {});
    const matH = new THREE.MeshStandardMaterial({ color: c.head, roughness: .7 });
    const matT = new THREE.MeshStandardMaterial({ color: c.torso, roughness: .75 });
    const matAL = new THREE.MeshStandardMaterial({ color: c.leftArm, roughness: .75 });
    const matAR = new THREE.MeshStandardMaterial({ color: c.rightArm, roughness: .75 });
    const matLL = new THREE.MeshStandardMaterial({ color: c.leftLeg, roughness: .75 });
    const matLR = new THREE.MeshStandardMaterial({ color: c.rightLeg, roughness: .75 });

    const g = new THREE.Group();
    const mk = (geo, mat, x, y) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, 0); g.add(m); return m; };
    mk(new THREE.BoxGeometry(1,2,1), matLL, -0.5, 1);
    mk(new THREE.BoxGeometry(1,2,1), matLR,  0.5, 1);
    mk(new THREE.BoxGeometry(2,2,1), matT,   0,   3);
    mk(new THREE.BoxGeometry(1,2,1), matAL, -1.5, 3);
    mk(new THREE.BoxGeometry(1,2,1), matAR,  1.5, 3);
    mk(new THREE.BoxGeometry(1.25,1.25,1.25), matH, 0, 4.625);
    g.position.y = -2.625;
    scene.add(g);

    const resize = () => {
      const r = container.getBoundingClientRect();
      if (!r.width) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    };
    setTimeout(resize, 30);

    let t = 0;
    const tick = () => { requestAnimationFrame(tick); t += 0.02; g.rotation.y = t; renderer.render(scene, camera); };
    tick();
  }
}

/* ============================================================
   TOUCH CONTROLS
   ============================================================ */
class TouchControls {
  constructor(game) {
    this.game = game;
    this.joyId = null;
    this.joyStartX = 0;
    this.joyStartY = 0;
    this.joyCurrentX = 0;
    this.joyCurrentY = 0;
    this.joyMaxDist = 60;

    this.camId = null;
    this.camLastX = 0;
    this.camLastY = 0;
    this.camSensitivity = 0.0035;

    document.body.classList.add('touch-mode');
    this._bind();
  }

  _bind() {
    const joyZone   = document.getElementById('joystick-zone');
    const camZone   = document.getElementById('camera-zone');
    const baseEl    = document.getElementById('joystick-base');
    const knobEl    = document.getElementById('joystick-knob');
    const jumpBtn   = document.getElementById('btn-jump');
    const chatBtn   = document.getElementById('btn-chat');
    const menuBtn   = document.getElementById('btn-menu');

    if (!joyZone || !camZone || !baseEl || !knobEl || !jumpBtn) return;

    this.baseEl = baseEl;
    this.knobEl = knobEl;

    const isMenuOpen = () =>
      (this.game.escMenu && this.game.escMenu.isOpen) || this.game.fatalError;

    const joyDown = (e) => {
      if (isMenuOpen()) return;
      if (this.joyId !== null) return;
      e.preventDefault();
      this.joyId = e.pointerId;
      this.joyStartX = e.clientX;
      this.joyStartY = e.clientY;
      this.joyCurrentX = e.clientX;
      this.joyCurrentY = e.clientY;
      baseEl.style.left = e.clientX + 'px';
      baseEl.style.top  = e.clientY + 'px';
      baseEl.classList.add('active');
      knobEl.style.transform = 'translate(0px, 0px)';
      try { joyZone.setPointerCapture(e.pointerId); } catch (_) {}
      this._applyJoy();
    };

    const joyMove = (e) => {
      if (e.pointerId !== this.joyId) return;
      e.preventDefault();
      this.joyCurrentX = e.clientX;
      this.joyCurrentY = e.clientY;
      this._applyJoy();
    };

    const joyUp = (e) => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      baseEl.classList.remove('active');
      knobEl.style.transform = 'translate(0px, 0px)';
      this.game.input.touchMoveX = 0;
      this.game.input.touchMoveZ = 0;
    };

    joyZone.addEventListener('pointerdown', joyDown);
    joyZone.addEventListener('pointermove', joyMove);
    joyZone.addEventListener('pointerup', joyUp);
    joyZone.addEventListener('pointercancel', joyUp);

    const camDown = (e) => {
      if (isMenuOpen()) return;
      if (this.camId !== null) return;
      e.preventDefault();
      this.camId = e.pointerId;
      this.camLastX = e.clientX;
      this.camLastY = e.clientY;
      try { camZone.setPointerCapture(e.pointerId); } catch (_) {}
    };

    const camMove = (e) => {
      if (e.pointerId !== this.camId) return;
      e.preventDefault();
      const dx = e.clientX - this.camLastX;
      const dy = e.clientY - this.camLastY;
      this.camLastX = e.clientX;
      this.camLastY = e.clientY;
      const s = this.camSensitivity * (this.game.settings.sensitivity / 0.0024);
      this.game.camYaw   -= dx * s;
      const inv = this.game.settings.invertY ? -1 : 1;
      this.game.camPitch += dy * s * inv;
      this.game.camPitch = Math.max(
        CONFIG.camera.minPitch,
        Math.min(CONFIG.camera.maxPitch, this.game.camPitch)
      );
    };

    const camUp = (e) => {
      if (e.pointerId !== this.camId) return;
      this.camId = null;
    };

    camZone.addEventListener('pointerdown', camDown);
    camZone.addEventListener('pointermove', camMove);
    camZone.addEventListener('pointerup', camUp);
    camZone.addEventListener('pointercancel', camUp);

    const jumpDown = (e) => {
      e.preventDefault();
      if (isMenuOpen()) return;
      if (this.game.player && this.game.player.dead) return;
      this.game.input.jumpHeld = true;
      this.game.input.jumpQueued = true;
    };
    const jumpUp = () => {
      this.game.input.jumpHeld = false;
    };
    jumpBtn.addEventListener('pointerdown', jumpDown);
    jumpBtn.addEventListener('pointerup', jumpUp);
    jumpBtn.addEventListener('pointercancel', jumpUp);
    jumpBtn.addEventListener('pointerleave', jumpUp);
    jumpBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    if (chatBtn) {
      chatBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (isMenuOpen()) return;
        this.game.chat.open();
      });
      chatBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    if (menuBtn) {
      menuBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.game.escMenu) this.game.escMenu.toggle();
      });
      menuBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  _applyJoy() {
    let dx = this.joyCurrentX - this.joyStartX;
    let dy = this.joyCurrentY - this.joyStartY;
    const dist = Math.hypot(dx, dy);
    const max = this.joyMaxDist;
    if (dist > max) {
      dx = (dx / dist) * max;
      dy = (dy / dist) * max;
    }
    this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;

    this.game.input.touchMoveX = dx / max;
    this.game.input.touchMoveZ = -dy / max;
  }
}

/* ============================================================
   GAME
   ============================================================ */
class Game {
  constructor({ gameRow, profile }) {
    this.gameRow = gameRow;
    this.profile = profile;
    this.username = profile?.username || 'Player';
    window.__playerName = this.username;

    this.settings = { sensitivity: 0.0024, invertY: false };
    this.fatalError = false;
    this.isTouchDevice =
      window.matchMedia('(pointer: coarse)').matches &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    this.touchControls = null;

    this.canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fd4ff);
    this.scene.fog = new THREE.Fog(0xbfe3ff, 95, 280);

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 1400);
    this.camera.position.set(0, 12, 22);

    this.physics = new PhysicsWorld();
    this.input = new InputManager();
    this.hud = new HUD();
    this.chat = new ChatSystem();

    this.firstPerson = false;
    this.camYaw = 0;
    this.camPitch = 0.28;
    this.camDistance = CONFIG.camera.distance;
    this.camDistanceSmooth = CONFIG.camera.distance;
    this.camTarget = null;
    this.fps = 0; this.fpsFrames = 0; this.fpsTime = 0;
    this._gameStarted = false;
    this.escMenu = null;
    this._particles = [];
    this._restartLock = false;

    this.ragdoll = null;
    this._respawnTimer = null;

    this._build();
  }

  _build() {
    this._setupLights();
    this._setupSky();
    this._buildWorldFromData();
    this._setupPlayer();
    this._setupNetwork();
    this._setupPresence();
    this._setupTouch();
    this._setupEvents();
    this._setupHealthBar();
    this.escMenu = new EscMenu(this);
    this.hud.setUser(this.username);
    this.hud.setGame(this.gameRow.name || 'Game');
    this._updateHudPlayers();
    this._updateHealthBar();
  }

  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x4a6b3a, 0.85));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.28));
    const sun = new THREE.DirectionalLight(0xfff4d6, 1.15);
    sun.position.set(60, 105, 42);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 82;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.045;
    this.scene.add(sun); this.scene.add(sun.target);
    this.sun = sun;
  }

  _setupSky() {
    const skyGeo = new THREE.SphereGeometry(600, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x2a6fd6) },
        bottomColor: { value: new THREE.Color(0xd6ecff) },
        offset: { value: 80 }, exponent: { value: 0.72 }
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPosition = wp.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor; uniform vec3 bottomColor;
        uniform float offset; uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(
            mix(bottomColor, topColor, max(pow(max(h,0.0), exponent), 0.0)),
            1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));

    const cloudMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, fog: false
    });
    for (let i = 0; i < 12; i++) {
      const g = new THREE.Group();
      const count = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < count; j++) {
        const s = 8 + Math.random() * 12;
        const puff = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.5, s * 0.8), cloudMat);
        puff.position.set(
          (Math.random() - 0.5) * 16,
          (Math.random() - 0.5) * 3,
          (Math.random() - 0.5) * 12
        );
        g.add(puff);
      }
      g.position.set(
        (Math.random() - 0.5) * 260,
        85 + Math.random() * 30,
        (Math.random() - 0.5) * 260
      );
      this.scene.add(g);
    }
  }

  _buildWorldFromData() {
    const genName = this.gameRow.generator || 'empty';
    const generator = GENERATORS[genName] || GENERATORS.empty;
    try {
      generator(this.scene, this.physics, this.gameRow.data || {});
    } catch (e) {
      console.warn('Generator error:', e);
      try { GENERATORS.empty(this.scene, this.physics); } catch (_) {}
    }
  }

  _setupPlayer() {
    const colors = avatarColorsFromProfile(this.profile);
    const equippedItems = this.profile?.equipped_items || null;

    this.player = new Character({
      name: this.username,
      colors,
      equippedItems,
      isLocal: true,
      subtitle: this.profile?.is_adm ? 'ADM' : 'YOU',
      subtitleColor: this.profile?.is_adm ? '#ff3b3b' : '#ffd24a'
    });
    this.player.setPosition(0, 3, 12);
    this.player.setYaw(Math.PI);
    this.scene.add(this.player.group);

    this.player.loadEquipment().catch(e => console.warn('[game] equipment load failed', e));
  }

  _setupNetwork() {
    this.network = new Network(this);
    this.network.onStatusChange = (s) => this.hud.setConnection(s);
    this.network.username = this.username;
    this.network.avatar_colors = this.profile?.avatar_colors || null;
    this.network.equipped_items = migrateEquipped(this.profile?.equipped_items);
    this.network.isAdm = !!this.profile?.is_adm;
    this.network.room = this.gameRow.slug || 'default';
    this.network.userId = this.profile?.id || null;

    this.chat.onOpen = () => { this.input.clear(); };
    this.chat.onClose = () => {};
    this.chat.onPlayerMessage = (text) => this.network.sendChat(text);
    this.chat.onCommand = (cmd, args) => this._handleChatCommand(cmd, args);
    this.network.connect();
  }

  _setupPresence() {
    if (!this.profile || !this.profile.id) return;
    this.presenceChannel = sb.channel('online-players', {
      config: { presence: { key: this.profile.id } }
    });
    this.presenceChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          await this.presenceChannel.track({
            username: this.username,
            game: this.gameRow.slug,
            room: this.gameRow.slug,
            online_at: new Date().toISOString()
          });
        } catch (e) {}
      }
    });
  }

  _setupTouch() {
    if (!this.isTouchDevice) return;
    this.touchControls = new TouchControls(this);
  }

  _showFatalError(message) {
    this.fatalError = true;
    const overlay = document.getElementById('error-overlay');
    const msgEl = document.getElementById('error-message');
    if (msgEl) msgEl.textContent = message;
    if (overlay) overlay.classList.add('show');
    if (document.pointerLockElement) document.exitPointerLock();
    const loading = document.getElementById('loading-game');
    if (loading) loading.classList.add('hidden');
  }

  _updateHudPlayers() {
    const remote = this.network ? this.network.realPlayerCount : 0;
    this.hud.setPlayers(1 + remote);
  }

  _setupHealthBar() {
    if (document.getElementById('health-bar')) {
      this.healthFill = document.getElementById('health-fill');
      this.healthVal  = document.getElementById('health-val');
      return;
    }
    const bar = document.createElement('div');
    bar.id = 'health-bar';
    bar.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'width:250px',
      'padding:8px 12px 10px',
      'background:rgba(0,20,40,.55)',
      'border:2px solid rgba(255,255,255,.25)',
      'border-radius:8px',
      'font-family:Verdana,Arial,sans-serif',
      'color:#fff',
      'z-index:60',
      'pointer-events:none',
      'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'user-select:none',
      'backdrop-filter:blur(3px)'
    ].join(';');

    bar.innerHTML =
      '<div style="display:flex;justify-content:space-between;font-size:10px;font-weight:bold;letter-spacing:1.5px;opacity:.85;margin-bottom:4px">' +
        '<span>HEALTH</span><span id="health-val">100 / 100</span>' +
      '</div>' +
      '<div style="height:14px;background:rgba(0,0,0,.55);border-radius:3px;overflow:hidden;border:1px solid rgba(0,0,0,.6)">' +
        '<div id="health-fill" style="height:100%;width:100%;' +
          'background:linear-gradient(180deg,#7ce87c 0%,#3fa13f 100%);' +
          'transition:width .18s ease-out;border-radius:2px"></div>' +
      '</div>';

    document.body.appendChild(bar);
    this.healthFill = bar.querySelector('#health-fill');
    this.healthVal  = bar.querySelector('#health-val');
  }

  _updateHealthBar() {
    if (!this.healthFill || !this.player) return;
    const pct = Math.max(0, (this.player.health / this.player.maxHealth) * 100);
    this.healthFill.style.width = pct + '%';
    this.healthVal.textContent = Math.round(this.player.health) + ' / ' + this.player.maxHealth;
    if (pct > 60)      this.healthFill.style.background = 'linear-gradient(180deg,#7ce87c 0%,#3fa13f 100%)';
    else if (pct > 30) this.healthFill.style.background = 'linear-gradient(180deg,#ffd166 0%,#c9a020 100%)';
    else               this.healthFill.style.background = 'linear-gradient(180deg,#ff7b7b 0%,#b02020 100%)';
  }

  _spawnBurst(pos, count = 40) {
    const colors = [0xf5cd30, 0x0d69ac, 0x4b974b, 0xa3a2a5, 0xff4444];
    for (let i = 0; i < count; i++) {
      const size = 0.3 + Math.random() * 0.7;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const mat = new THREE.MeshLambertMaterial({ color });
      const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
      m.position.copy(pos);
      m.castShadow = false;
      this.scene.add(m);
      const dir = new THREE.Vector3(
        (Math.random() - 0.5) * 2,
        Math.random() * 1.8 + 0.2,
        (Math.random() - 0.5) * 2
      ).normalize();
      this._particles.push({
        mesh: m,
        vel: dir.multiplyScalar(14 + Math.random() * 16),
        life: 1.4, maxLife: 1.4, gravity: 28
      });
    }
  }

  damagePlayer(amount) {
    if (!this.player || this.player.dead) return;
    const died = this.player.takeDamage(amount);
    this._updateHealthBar();
    if (died) this._onPlayerDeath();
  }

  _onPlayerDeath() {
    if (!this.player || this.player.dead) return;
    this.player.dead = true;
    this.input.clear();

    if (this.ragdoll) { try { this.ragdoll.dispose(); } catch(_) {} this.ragdoll = null; }
    this.ragdoll = new Ragdoll(this.player, this.scene, this.physics);

    this.player.setVisible(false);

    const p = this.player.body.pos.clone();
    p.y += 3;
    this._spawnBurst(p, 50);

    this.chat.addMessage('SYSTEM', `${this.player.name} died!`, '#ff5555');

    clearTimeout(this._respawnTimer);
    this._respawnTimer = setTimeout(() => this._respawnPlayer(), CONFIG.health.respawnDelay * 1000);
  }

  _respawnPlayer() {
    if (this.ragdoll) { try { this.ragdoll.dispose(); } catch(_) {} this.ragdoll = null; }

    this.player.resetHealth();
    this.player.setPosition(0, 3, 12);
    this.player.setYaw(Math.PI);
    this.player.body.vel.set(0, 0, 0);
    this.player.setVisible(true);

    this.camTarget = null;
    this.camYaw = 0;
    this.camPitch = 0.28;
    this.camDistance = CONFIG.camera.distance;

    this._updateHealthBar();
    this.chat.addMessage('SYSTEM', `${this.player.name} respawned.`, '#6fe36f');
    this._requestLock();
  }

  _handleChatCommand(cmd, args) {
    if (cmd === 'damage' || cmd === 'dmg') {
      const amt = parseFloat(args[0]);
      if (!isNaN(amt)) {
        this.damagePlayer(amt);
        this.chat.addMessage('SYSTEM', `-${amt} HP`, '#ffd166');
      } else {
        this.chat.addMessage('SYSTEM', 'Usage: /damage <amount>', '#ff8888');
      }
    } else if (cmd === 'kill') {
      this.damagePlayer(this.player.maxHealth + 1000);
    } else if (cmd === 'heal') {
      this.player.resetHealth();
      this._updateHealthBar();
      this.chat.addMessage('SYSTEM', 'Health restored.', '#6fe36f');
    } else if (cmd === 'respawn' || cmd === 'r') {
      if (this.player.dead) {
        clearTimeout(this._respawnTimer);
        this._respawnPlayer();
      } else {
        this.chat.addMessage('SYSTEM', 'You are not dead.', '#ff8888');
      }
    } else {
      this.chat.addMessage('SYSTEM', `Unknown command: /${cmd}`, '#ff8888');
    }
  }

  _setupEvents() {
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    document.addEventListener('mousemove', (e) => this._onMouseMove(e));
    document.addEventListener('pointerlockchange', () => this._onPointerLockChange());
    document.addEventListener('click', (e) => this._onClick(e));
    window.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('beforeunload', () => {
      if (this.network) this.network.disconnect();
      if (this.presenceChannel) {
        try { sb.removeChannel(this.presenceChannel); } catch (e) {}
        this.presenceChannel = null;
      }
    });
  }

  _onKeyDown(e) {
    if (this.fatalError) return;
    if (this.chat.isFocused()) return;

    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.escMenu) this.escMenu.toggle();
      return;
    }

    if (this.escMenu && this.escMenu.isOpen) return;

    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Slash') {
      e.preventDefault(); this.chat.open(); return;
    }
    if (e.code === 'KeyV') {
      this.firstPerson = !this.firstPerson;
      const ch = document.getElementById('crosshair');
      if (ch) ch.style.display = this.firstPerson ? 'block' : 'none';
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.player.dead) this.input.jumpQueued = true;
    }
    this.input.keys.add(e.code);
    if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
      e.preventDefault();
    }
  }
  _onKeyUp(e) { this.input.keys.delete(e.code); }
  _onMouseMove(e) {
    if (!this.input.locked) return;
    if (this.escMenu && this.escMenu.isOpen) return;
    this.input.mouseDX += e.movementX || 0;
    this.input.mouseDY += e.movementY || 0;
  }
  _onClick(e) {
    if (this.fatalError) return;
    if (this.chat.isFocused()) return;
    if (this.escMenu && this.escMenu.isOpen) return;
    if (e.target && e.target.closest && e.target.closest('#esc-menu')) return;
    if (e.target && e.target.closest && e.target.closest('#error-overlay')) return;
    if (e.target && e.target.closest && e.target.closest('#touch-controls')) return;
    if (this.isTouchDevice) return;
    if (!this.input.locked) this._requestLock();
  }
  _requestLock() {
    if (this.fatalError) return;
    if (this.escMenu && this.escMenu.isOpen) return;
    if (this.isTouchDevice) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  }
  _onPointerLockChange() {
    this.input.locked = document.pointerLockElement === this.canvas;
    if (!this.input.locked) { this.input.mouseDX = 0; this.input.mouseDY = 0; }
  }
  _onWheel(e) {
    e.preventDefault();
    if (this.escMenu && this.escMenu.isOpen) return;
    this.camDistance = THREE.MathUtils.clamp(
      this.camDistance + e.deltaY * 0.012,
      CONFIG.camera.minDistance, CONFIG.camera.maxDistance
    );
  }
  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _updateCameraAngles() {
    if (!this.input.locked) { this.input.mouseDX = 0; this.input.mouseDY = 0; return; }
    const s = this.settings.sensitivity;
    const invert = this.settings.invertY ? -1 : 1;
    this.camYaw -= this.input.mouseDX * s;
    this.camPitch += this.input.mouseDY * s * invert;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch, CONFIG.camera.minPitch, CONFIG.camera.maxPitch);
    this.input.mouseDX = 0; this.input.mouseDY = 0;
  }

  _updateCamera(dt) {
    const p = this.player.body.pos;
    const tx = p.x, ty = p.y + CONFIG.camera.targetHeight, tz = p.z;
    if (!this.camTarget) this.camTarget = new THREE.Vector3(tx, ty, tz);
    this.camTarget.x = damp(this.camTarget.x, tx, 18, dt);
    this.camTarget.y = damp(this.camTarget.y, ty, 12, dt);
    this.camTarget.z = damp(this.camTarget.z, tz, 18, dt);
    const cp = Math.cos(this.camPitch);
    const dir = new THREE.Vector3(
      Math.sin(this.camYaw) * cp,
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * cp
    ).normalize();
    let desired = this.camDistance;
    const hit = this.physics.raycast(this.camTarget, dir, desired + 0.6);
    if (hit < desired + 0.6) desired = Math.max(CONFIG.camera.minDistance, hit - 0.45);
    this.camDistanceSmooth = damp(this.camDistanceSmooth, desired, 22, dt);
    const finalDist = Math.min(desired, this.camDistanceSmooth);

    if (this.firstPerson && !this.player.dead) {
      this.player.setVisible(false);
      const head = new THREE.Vector3(p.x, p.y + 4.6, p.z);
      this.camera.position.copy(head);
      const look = new THREE.Vector3(-dir.x, -dir.y, -dir.z);
      this.camera.lookAt(head.x + look.x, head.y + look.y, head.z + look.z);
    } else {
      /* CORREÇÃO: garante que depois do respawn o personagem fica visível
         mesmo se o jogador estiver alternando entre 1ª e 3ª pessoa */
      if (!this.player.dead) this.player.setVisible(true);
      this.camera.position.set(
        this.camTarget.x + dir.x * finalDist,
        this.camTarget.y + dir.y * finalDist,
        this.camTarget.z + dir.z * finalDist
      );
      this.camera.lookAt(this.camTarget);
    }
  }

  _updatePlayer(dt) {
    if (this._restartLock || !this.player || this.player.dead) return;
    const body = this.player.body;

    let ix = 0, iz = 0;
    if (this.input.isDown('KeyW') || this.input.isDown('ArrowUp'))    iz += 1;
    if (this.input.isDown('KeyS') || this.input.isDown('ArrowDown'))  iz -= 1;
    if (this.input.isDown('KeyA') || this.input.isDown('ArrowLeft'))  ix -= 1;
    if (this.input.isDown('KeyD') || this.input.isDown('ArrowRight')) ix += 1;

    const tmX = this.input.touchMoveX || 0;
    const tmZ = this.input.touchMoveZ || 0;
    ix += tmX;
    iz += tmZ;

    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }

    const yaw = this.camYaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx =  Math.cos(yaw), rz = -Math.sin(yaw);
    const moveX = fx * iz + rx * ix;
    const moveZ = fz * iz + rz * ix;

    const kbRunning = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');
    const touchMag2 = tmX * tmX + tmZ * tmZ;
    const touchRunning = touchMag2 > 0.72;
    const running = kbRunning || touchRunning;
    const speed = running ? CONFIG.runSpeed : CONFIG.walkSpeed;

    const accel = body.grounded ? 20 : 5;
    body.vel.x = damp(body.vel.x, moveX * speed, accel, dt);
    body.vel.z = damp(body.vel.z, moveZ * speed, accel, dt);

    if ((this.input.jumpQueued || this.input.jumpHeld) && body.grounded) {
      body.vel.y = CONFIG.jumpSpeed;
      body.grounded = false;
    }
    this.input.jumpQueued = false;

    body.vel.y -= CONFIG.gravity * dt;
    if (body.vel.y < -CONFIG.maxFallSpeed) body.vel.y = -CONFIG.maxFallSpeed;
    this.physics.moveBody(body, dt);
    if (len > 0.01) this.player.targetYaw = Math.atan2(moveX, moveZ);
  }

  _updateHealthRegen(dt) {
    if (!this.player || this.player.dead) return;
    if (this.player.health >= this.player.maxHealth) return;
    const now = performance.now() / 1000;
    if (now - this.player.lastDamageTime < CONFIG.health.regenDelay) return;
    this.player.heal(CONFIG.health.regenRate * dt);
    this._updateHealthBar();
  }

  restartPlayer() {
    if (this._restartLock) return;
    this._restartLock = true;
    this.input.clear();

    if (this.ragdoll) { try { this.ragdoll.dispose(); } catch(_) {} this.ragdoll = null; }
    if (this.player && !this.player.dead) {
      this.ragdoll = new Ragdoll(this.player, this.scene, this.physics);
      this.player.dead = true;
    }
    this.player.setVisible(false);

    const p = this.player.body.pos.clone();
    p.y += 2;
    this._spawnBurst(p, 40);

    this.chat.addMessage('SYSTEM', 'Restarting character...', '#ffd166');

    clearTimeout(this._respawnTimer);
    this._respawnTimer = setTimeout(() => {
      if (this.ragdoll) { try { this.ragdoll.dispose(); } catch(_) {} this.ragdoll = null; }
      this.player.resetHealth();
      this.player.setPosition(0, 3, 12);
      this.player.setYaw(Math.PI);
      this.player.body.vel.set(0, 0, 0);
      this.player.setVisible(true);
      this.camTarget = null;
      this.camYaw = 0;
      this.camPitch = 0.28;
      this.camDistance = CONFIG.camera.distance;
      this._restartLock = false;
      this._updateHealthBar();
      this.chat.addMessage('SYSTEM', 'Character respawned.', '#6fe36f');
      this._requestLock();
    }, CONFIG.health.restartRespawnDelay * 1000);
  }

  _updateParticles(dt) {
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const pt = this._particles[i];
      pt.life -= dt;
      if (pt.life <= 0) {
        this.scene.remove(pt.mesh);
        pt.mesh.geometry.dispose();
        pt.mesh.material.dispose();
        this._particles.splice(i, 1);
        continue;
      }
      pt.vel.y -= pt.gravity * dt;
      pt.mesh.position.addScaledVector(pt.vel, dt);
      pt.mesh.rotation.x += dt * 10;
      pt.mesh.rotation.y += dt * 8;
      const s = Math.max(0.05, pt.life / pt.maxLife);
      pt.mesh.scale.setScalar(s);
    }
  }

  start() {
    if (this.fatalError) return;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    if (this.fatalError) return;
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (dt > 0.25) dt = 0.25;

    this.fpsFrames++; this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.hud.setFPS(this.fps);
      this.fpsFrames = 0; this.fpsTime = 0;
    }

    this._updateCameraAngles();

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= CONFIG.fixedStep && steps < CONFIG.maxSubSteps) {
      this._updatePlayer(CONFIG.fixedStep);
      this.accumulator -= CONFIG.fixedStep;
      steps++;
    }
    if (steps === CONFIG.maxSubSteps) this.accumulator = 0;

    this._updateHealthRegen(dt);
    this._updateParticles(dt);

    if (this.ragdoll) {
      try { this.ragdoll.update(dt); } catch (e) { console.warn(e); }
    }

    if (this.player && !this.player.dead) {
      const pv = this.player.body.vel;
      this.player.updateVisual(dt, Math.hypot(pv.x, pv.z));
    }

    this.network.update(dt);

    this._updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

/* ============================================================
   BOOT
   ============================================================ */
(async function boot() {
  const params = new URLSearchParams(location.search);
  const slug = params.get('game') || 'blocky-world';
  const statusEl = document.getElementById('loading-status');

  try {
    statusEl.textContent = 'Loading textures...';
    await __studReadyPromise;

    statusEl.textContent = 'Checking session...';
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user) {
      statusEl.textContent = 'Please log in on HTMLBlox first.';
      setTimeout(() => { location.href = 'index.html'; }, 1500);
      return;
    }

    statusEl.textContent = 'Loading profile...';
    const { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!profile) {
      statusEl.textContent = 'Profile not found.';
      setTimeout(() => { location.href = 'index.html'; }, 1500);
      return;
    }

    statusEl.textContent = 'Loading game data...';
    const { data: gameRow, error } = await sb.from('games').select('*').eq('slug', slug).maybeSingle();
    if (error || !gameRow) {
      statusEl.textContent = 'Game not found: ' + slug;
      setTimeout(() => { location.href = 'index.html'; }, 1800);
      return;
    }

    statusEl.textContent = 'Loading store items...';
    await loadStoreItems(sb);

    statusEl.textContent = 'Starting engine...';
    const game = new Game({ gameRow, profile });
    window.__blockyWorld = game;

    setTimeout(() => {
      document.getElementById('loading-game').classList.add('hidden');
      game._gameStarted = true;
      game._requestLock();
      game.start();
    }, 250);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Error: ' + err.message;
    setTimeout(() => { location.href = 'index.html'; }, 2200);
  }
})();
