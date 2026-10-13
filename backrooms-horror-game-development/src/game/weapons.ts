import * as THREE from 'three';
import { WeaponId, AmmoKind, DamageTarget, clamp, lerp, rand } from './types';
import { gunmetalTexture, polymerTexture, woodTexture } from './textures';
import type { AudioEngine } from './audio';
import type { Effects } from './effects';

export interface FireResult {
  dist: number;
  point: THREE.Vector3;
  nx: number;
  nz: number;
  target: DamageTarget | null;
  part: 'head' | 'body' | null;
}

export interface WeaponHooks {
  fireRay: (origin: THREE.Vector3, dir: THREE.Vector3, range: number) => FireResult;
  onShotFired: (weapon: WeaponId) => void;
  applyRecoil: (pitch: number, yaw: number) => void;
  onHit: (kill: boolean) => void;
  /** Spawn a physical projectile (launchers). dir is normalised. */
  launch: (kind: NonNullable<WeaponDef['projectile']>, origin: THREE.Vector3, dir: THREE.Vector3) => void;
  /** Veto a shot (e.g. no launchers inside a duct). Return false to block. */
  canFire: (def: WeaponDef) => boolean;
}

export type FireMode = 'semi' | 'auto' | 'burst';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: number;
  damage: number;
  pellets: number;
  interval: number;
  mode: FireMode;
  magSize: number;
  startReserve: number;
  maxReserve: number;
  reloadTime: number;
  range: number;
  spreadHip: number;
  spreadAds: number;
  recoilPitch: number;
  recoilYaw: number;
  kick: number;
  noiseRadius: number;
  pumpAction?: boolean;
  /** Sniper: cycles a bolt handle after every shot. */
  boltAction?: boolean;
  /** Sniper: ADS becomes a magnified scope (FOV dive + overlay). */
  scoped?: boolean;
  /** Minimum damage multiplier at long range (default: falls to 0.55). */
  falloffMin?: number;
  /** Launchers fire physical projectiles instead of hitscan rounds. */
  projectile?: 'bazooka' | 'rocket' | 'antimatter';
  /** Seconds the weapon winds up before the shot leaves (anti-matter). */
  chargeTime?: number;
  /** Melee weapon: swings instead of firing; no ammunition. */
  melee?: boolean;
  /** Swing choreography for melee weapons. */
  swingStyle?: 'slash' | 'chop' | 'draw';
  /** Swing arc amplitude multiplier (katana swings widest). */
  swingAmp?: number;
  /** Three-letter HUD tag. */
  short: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'P229 HANDGUN', slot: 1, damage: 34, pellets: 1, interval: 0.27,
    mode: 'semi', magSize: 12, startReserve: 36, maxReserve: 120, reloadTime: 1.15,
    range: 90, spreadHip: 0.011, spreadAds: 0.0025, recoilPitch: 0.011, recoilYaw: 0.0035, kick: 0.05, noiseRadius: 34,
  },
  shotgun: {
    id: 'shotgun', name: 'M870 PUMP SHOTGUN', slot: 2, damage: 13, pellets: 8, interval: 0.92,
    mode: 'semi', magSize: 6, startReserve: 12, maxReserve: 48, reloadTime: 2.4,
    range: 42, spreadHip: 0.045, spreadAds: 0.032, recoilPitch: 0.045, recoilYaw: 0.008, kick: 0.16, noiseRadius: 46, pumpAction: true,
  },
  smg: {
    id: 'smg', name: 'MP5 SUBMACHINE GUN', slot: 3, damage: 16, pellets: 1, interval: 0.072,
    mode: 'auto', magSize: 32, startReserve: 96, maxReserve: 320, reloadTime: 1.5,
    range: 70, spreadHip: 0.02, spreadAds: 0.006, recoilPitch: 0.006, recoilYaw: 0.003, kick: 0.028, noiseRadius: 30,
  },
  rifle: {
    id: 'rifle', name: 'AR-15 ASSAULT RIFLE', slot: 4, damage: 30, pellets: 1, interval: 0.108,
    mode: 'auto', magSize: 30, startReserve: 60, maxReserve: 240, reloadTime: 1.7,
    range: 110, spreadHip: 0.016, spreadAds: 0.0035, recoilPitch: 0.0095, recoilYaw: 0.0035, kick: 0.045, noiseRadius: 40,
  },
  // The late-game hand cannon: huge damage, a 6-round cylinder, scarce ammo.
  // Body-shots delete Runners and Watchers outright; the Heavy still takes work.
  magnum: {
    id: 'magnum', name: 'M29 .44 MAGNUM', slot: 5, damage: 96, pellets: 1, interval: 0.78,
    mode: 'semi', magSize: 6, startReserve: 12, maxReserve: 30, reloadTime: 2.6,
    range: 100, spreadHip: 0.006, spreadAds: 0.0012, recoilPitch: 0.058, recoilYaw: 0.011, kick: 0.2, noiseRadius: 52,
  },
  // The Kalashnikov: harder hits and a heavier kick than the AR, slower cycle,
  // sloppier on the move. Found in the facility's west storage rooms.
  ak: {
    id: 'ak', name: 'AK-47 ASSAULT RIFLE', slot: 6, damage: 40, pellets: 1, interval: 0.118,
    mode: 'auto', magSize: 30, startReserve: 60, maxReserve: 210, reloadTime: 2.0,
    range: 105, spreadHip: 0.022, spreadAds: 0.0085, recoilPitch: 0.014, recoilYaw: 0.005, kick: 0.058, noiseRadius: 44,
  },
  // The M16: fires disciplined 3-round bursts. Weakest kick of the rifles,
  // tightest ADS grouping, shares 5.56 ammunition with the AR-15.
  m16: {
    id: 'm16', name: 'M16 ASSAULT RIFLE', slot: 7, damage: 28, pellets: 1, interval: 0.34,
    mode: 'burst', magSize: 30, startReserve: 60, maxReserve: 240, reloadTime: 1.6,
    range: 115, spreadHip: 0.017, spreadAds: 0.0022, recoilPitch: 0.008, recoilYaw: 0.0022, kick: 0.038, noiseRadius: 40,
  },
  // The L96: one bolt-cycled .338 per deliberate breath. Deletes anything but
  // the Heavy — but misses are punished hard and the rounds are rare.
  sniper: {
    id: 'sniper', name: 'L96 SNIPER RIFLE', slot: 8, damage: 150, pellets: 1, interval: 1.45,
    mode: 'semi', magSize: 5, startReserve: 15, maxReserve: 40, reloadTime: 2.9,
    range: 220, spreadHip: 0.032, spreadAds: 0.0004, recoilPitch: 0.075, recoilYaw: 0.012, kick: 0.26,
    noiseRadius: 56, boltAction: true, scoped: true, falloffMin: 0.92,
  },
  // M9 Bazooka: a single fat HE rocket per long, deliberate reload.
  // Biggest blast in the game; dumb-fire only; will hurt you in a corridor.
  bazooka: {
    id: 'bazooka', name: 'M9 BAZOOKA', slot: 9, damage: 300, pellets: 1, interval: 1.0,
    mode: 'semi', magSize: 1, startReserve: 2, maxReserve: 6, reloadTime: 3.3,
    range: 160, spreadHip: 0.012, spreadAds: 0.003, recoilPitch: 0.085, recoilYaw: 0.01, kick: 0.24,
    noiseRadius: 60, projectile: 'bazooka',
  },
  // HL-4 Rocket Launcher: a 3-round clip of faster, smaller missiles that
  // home on a locked target (hold aim on an enemy to acquire).
  rocket: {
    id: 'rocket', name: 'HL-4 ROCKET LAUNCHER', slot: 10, damage: 190, pellets: 1, interval: 0.95,
    mode: 'semi', magSize: 3, startReserve: 3, maxReserve: 9, reloadTime: 3.8,
    range: 180, spreadHip: 0.01, spreadAds: 0.002, recoilPitch: 0.05, recoilYaw: 0.008, kick: 0.17,
    noiseRadius: 58, projectile: 'rocket',
  },
  // The anti-matter projector: winds up, then throws a singularity that
  // drags everything nearby into itself and implodes. Three charges, total.
  antimatter: {
    id: 'antimatter', name: 'ANTI-MATTER PROJECTOR', slot: 11, damage: 420, pellets: 1, interval: 2.8,
    mode: 'semi', magSize: 1, startReserve: 1, maxReserve: 3, reloadTime: 3.0,
    range: 120, spreadHip: 0.004, spreadAds: 0.001, recoilPitch: 0.06, recoilYaw: 0.006, kick: 0.2,
    noiseRadius: 40, projectile: 'antimatter', chargeTime: 0.75,
  },
  // ---- blades: no ammunition, almost no noise, worthless past arm's reach
  knife: {
    id: 'knife', name: 'COMBAT KNIFE', slot: 12, damage: 30, pellets: 1, interval: 0.38,
    mode: 'semi', magSize: 0, startReserve: 0, maxReserve: 0, reloadTime: 0,
    range: 2.35, spreadHip: 0, spreadAds: 0, recoilPitch: 0.002, recoilYaw: 0.001, kick: 0.01,
    noiseRadius: 2.5, melee: true, swingStyle: 'slash', swingAmp: 0.7,
  },
  kitchen: {
    id: 'kitchen', name: 'KITCHEN KNIFE', slot: 13, damage: 38, pellets: 1, interval: 0.46,
    mode: 'semi', magSize: 0, startReserve: 0, maxReserve: 0, reloadTime: 0,
    range: 2.3, spreadHip: 0, spreadAds: 0, recoilPitch: 0.003, recoilYaw: 0.001, kick: 0.014,
    noiseRadius: 3, melee: true, swingStyle: 'chop', swingAmp: 0.9,
  },
  machete: {
    id: 'machete', name: 'MACHETE', slot: 14, damage: 58, pellets: 1, interval: 0.68,
    mode: 'semi', magSize: 0, startReserve: 0, maxReserve: 0, reloadTime: 0,
    range: 2.55, spreadHip: 0, spreadAds: 0, recoilPitch: 0.005, recoilYaw: 0.002, kick: 0.02,
    noiseRadius: 5, melee: true, swingStyle: 'slash', swingAmp: 1.0,
  },
  katana: {
    id: 'katana', name: 'KATANA', slot: 15, damage: 76, pellets: 1, interval: 0.6,
    mode: 'semi', magSize: 0, startReserve: 0, maxReserve: 0, reloadTime: 0,
    range: 2.75, spreadHip: 0, spreadAds: 0, recoilPitch: 0.004, recoilYaw: 0.002, kick: 0.018,
    noiseRadius: 4, melee: true, swingStyle: 'draw', swingAmp: 1.15,
  },
} satisfies Record<WeaponId, Omit<WeaponDef, 'short'>> as unknown as Record<WeaponId, WeaponDef>;

const SHORT: Record<WeaponId, string> = {
  pistol: 'PST', shotgun: 'SHT', smg: 'SMG', rifle: 'RFL', magnum: 'MGN', ak: 'AK', m16: 'M16',
  sniper: 'SNP', bazooka: 'BZK', rocket: 'RKT', antimatter: 'AMX',
  knife: 'KNF', kitchen: 'CHEF', machete: 'MCH', katana: 'KAT',
};

/** Melee weapons in slot order (B key cycles them; TAB equips directly). */
export const MELEE_IDS: WeaponId[] = ['knife', 'kitchen', 'machete', 'katana'];
(Object.keys(WEAPONS) as WeaponId[]).forEach((id) => { WEAPONS[id].short = SHORT[id]; });

/**
 * The single source of truth for the arsenal, ordered by slot. HUD slots,
 * number keys, the mouse wheel and the ` cheat all read from this list, so a
 * weapon added to WEAPONS appears everywhere automatically.
 */
export const WEAPON_ORDER: WeaponId[] = (Object.keys(WEAPONS) as WeaponId[])
  .sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot);

/** Keyboard key shown for a slot (slots 10 and 11 map to 0 and -). */
export function slotKeyLabel(slot: number): string {
  return slot === 10 ? '0' : slot === 11 ? '-' : String(slot);
}

/** Ammo consumable that benefits each weapon (melee has none). */
export const AMMO_FOR_WEAPON: Partial<Record<WeaponId, AmmoKind>> = {
  pistol: 'ammo-pistol', shotgun: 'shells', smg: 'ammo-smg', rifle: 'ammo-rifle', magnum: 'ammo-magnum',
  ak: 'ammo-ak', m16: 'ammo-rifle', sniper: 'ammo-sniper',
  bazooka: 'ammo-rocket', rocket: 'ammo-missile', antimatter: 'ammo-antimatter',
};
/** Which weapon a given ammo pickup feeds (first claimant wins shared pools). */
export const WEAPON_FOR_AMMO: Record<AmmoKind, WeaponId> = {
  'ammo-pistol': 'pistol', shells: 'shotgun', 'ammo-smg': 'smg', 'ammo-rifle': 'rifle', 'ammo-magnum': 'magnum',
  'ammo-ak': 'ak', 'ammo-sniper': 'sniper',
  'ammo-rocket': 'bazooka', 'ammo-missile': 'rocket', 'ammo-antimatter': 'antimatter',
};
/** Rounds granted by one ammo pickup. */
export const AMMO_PER_PICKUP: Record<AmmoKind, number> = {
  'ammo-pistol': 8, shells: 4, 'ammo-smg': 24, 'ammo-rifle': 20, 'ammo-magnum': 6, 'ammo-ak': 30, 'ammo-sniper': 5,
  'ammo-rocket': 1, 'ammo-missile': 2, 'ammo-antimatter': 1,
};

// ================================================================= materials
// Procedurally finished surfaces: blued steel with scratches & fouling,
// stippled polymer, oiled walnut. envMapIntensity makes the metals respond
// to the scene's image-based lighting in the dim halls.
const MAT = {
  metal: new THREE.MeshStandardMaterial({ map: gunmetalTexture(), roughness: 0.42, metalness: 0.85, envMapIntensity: 1.15 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x787e86, roughness: 0.3, metalness: 0.95, envMapIntensity: 1.35 }),
  bore: new THREE.MeshStandardMaterial({ color: 0x070708, roughness: 0.65, metalness: 0.4 }),
  polymer: new THREE.MeshStandardMaterial({ map: polymerTexture(), roughness: 0.78, metalness: 0.12, envMapIntensity: 0.55 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.96, metalness: 0.0 }),
  wood: new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.52, metalness: 0.0, envMapIntensity: 0.45 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xa07c33, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 }),
  shellRed: new THREE.MeshStandardMaterial({ color: 0x8e2318, roughness: 0.48, metalness: 0.05 }),
  glow: new THREE.MeshStandardMaterial({ color: 0x0a140c, roughness: 0.4, emissive: 0x46ff7a, emissiveIntensity: 1.9 }),
  blade: new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.24, metalness: 0.96, envMapIntensity: 1.6 }),
  bladeDark: new THREE.MeshStandardMaterial({ color: 0x565d63, roughness: 0.42, metalness: 0.9, envMapIntensity: 1.1 }),
};

function box(parent: THREE.Object3D, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}
function cyl(parent: THREE.Object3D, mat: THREE.Material, r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'z'): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  else if (axis === 'x') m.rotation.z = Math.PI / 2;
  // 'y' keeps the cylinder's native vertical orientation (turrets, posts)
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function torus(parent: THREE.Object3D, mat: THREE.Material, r: number, tube: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 24), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function dot(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.0042): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 8), MAT.glow);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
/** Trigger guard from three segments — reads far better than a slab. */
function triggerGuard(parent: THREE.Object3D, frontZ: number, y: number, len: number) {
  box(parent, MAT.metal, 0.013, 0.05, 0.013, 0, y - 0.012, frontZ);
  box(parent, MAT.metal, 0.013, 0.012, len, 0, y - 0.04, frontZ + len / 2 + 0.004);
  box(parent, MAT.steel, 0.01, 0.04, 0.011, 0, y - 0.014, frontZ + len * 0.42, 0.35);
}

interface ViewModel {
  group: THREE.Group;
  muzzle: THREE.Object3D;
  slide?: THREE.Object3D;
  pump?: THREE.Object3D;
  mag?: THREE.Object3D;
  /** Revolver only: cocks back between shots. */
  hammer?: THREE.Object3D;
  /** Revolver only: spins a chamber forward per shot, swings out to reload. */
  cylinder?: THREE.Object3D;
  /** Sniper only: handle lifts and draws back after each shot. */
  bolt?: THREE.Object3D;
  /** Launchers: the visible warhead, hidden while the tube is empty. */
  warhead?: THREE.Object3D;
  /** Anti-matter: energy rings orbiting the chamber + the singularity core. */
  rings?: THREE.Object3D[];
  core?: THREE.Object3D;
  glowMats?: THREE.MeshStandardMaterial[];
  /** HL-4 seeker screen (red searching / green locked). */
  screenMat?: THREE.MeshStandardMaterial;
  /** Horizontal ADS offset for side-mounted sights (bazooka). */
  adsX?: number;
  adsY: number;
}

// ================================================================= models
function buildPistol(): ViewModel {
  const g = new THREE.Group();

  // ---- slide assembly (animated: recoils as one unit, barrel included)
  const slide = new THREE.Group();
  g.add(slide);
  box(slide, MAT.metal, 0.082, 0.058, 0.3, 0, 0.062, -0.095); // slide body
  box(slide, MAT.metal, 0.058, 0.02, 0.285, 0, 0.099, -0.095); // top bevel flat
  cyl(slide, MAT.steel, 0.0165, 0.04, 0, 0.058, -0.252); // barrel muzzle
  cyl(slide, MAT.bore, 0.0105, 0.008, 0, 0.058, -0.272); // bore
  cyl(slide, MAT.steel, 0.006, 0.05, 0, 0.032, -0.245); // guide rod
  for (let i = 0; i < 5; i++) box(slide, MAT.metal, 0.086, 0.042, 0.0055, 0, 0.062, 0.032 - i * 0.0135, 0.28); // rear serrations
  for (let i = 0; i < 3; i++) box(slide, MAT.metal, 0.086, 0.04, 0.005, 0, 0.06, -0.168 - i * 0.0125, 0.28); // front serrations
  box(slide, MAT.bore, 0.02, 0.02, 0.075, 0.034, 0.086, -0.085); // ejection port
  box(slide, MAT.steel, 0.008, 0.012, 0.03, 0.043, 0.066, -0.048); // extractor
  box(slide, MAT.metal, 0.011, 0.027, 0.011, 0, 0.117, -0.222); // front sight post
  dot(slide, 0, 0.118, -0.2155); // front tritium
  box(slide, MAT.metal, 0.02, 0.024, 0.013, -0.022, 0.113, 0.04); // rear sight L
  box(slide, MAT.metal, 0.02, 0.024, 0.013, 0.022, 0.113, 0.04); // rear sight R
  dot(slide, -0.022, 0.114, 0.0475);
  dot(slide, 0.022, 0.114, 0.0475);
  box(slide, MAT.metal, 0.07, 0.05, 0.008, 0, 0.058, 0.056); // rear plate

  // ---- frame
  box(g, MAT.metal, 0.078, 0.052, 0.27, 0, 0.002, -0.075);
  box(g, MAT.bore, 0.06, 0.007, 0.012, 0, -0.02, -0.196); // accessory rail slots
  box(g, MAT.bore, 0.06, 0.007, 0.012, 0, -0.02, -0.168);
  triggerGuard(g, -0.148, -0.026, 0.072);
  box(g, MAT.metal, 0.06, 0.03, 0.05, 0, 0.03, 0.048, -0.3); // beavertail
  box(g, MAT.steel, 0.014, 0.034, 0.02, 0, 0.05, 0.06, -0.5); // hammer
  box(g, MAT.polymer, 0.074, 0.175, 0.1, 0, -0.105, 0.028, -0.27); // grip (raked back toward shooter)
  box(g, MAT.polymer, 0.08, 0.02, 0.106, 0, -0.192, 0.051, -0.27); // magwell flare
  cyl(g, MAT.steel, 0.007, 0.02, -0.043, 0.012, 0.0, 'x'); // decocker
  cyl(g, MAT.steel, 0.006, 0.02, -0.043, 0.032, -0.032, 'x'); // slide stop

  // ---- magazine (animated: drops on reload)
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.058, 0.1, 0.072, 0, -0.222, 0.06, -0.27);
  box(mag, MAT.polymer, 0.066, 0.022, 0.08, 0, -0.262, 0.07, -0.27);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.058, -0.278);
  slide.add(muzzle);
  return { group: g, muzzle, slide, mag, adsY: -0.128 };
}

function buildShotgun(): ViewModel {
  const g = new THREE.Group();

  // ---- receiver & stock (static)
  box(g, MAT.metal, 0.082, 0.108, 0.36, 0, 0.012, -0.14); // receiver
  box(g, MAT.metal, 0.07, 0.02, 0.3, 0, 0.074, -0.14); // top cover
  box(g, MAT.bore, 0.018, 0.045, 0.1, 0.036, 0.02, -0.2); // ejection port
  box(g, MAT.steel, 0.04, 0.012, 0.09, 0, -0.048, -0.1); // loading gate
  box(g, MAT.wood, 0.072, 0.135, 0.3, 0, -0.028, 0.16, -0.12); // stock
  box(g, MAT.wood, 0.05, 0.04, 0.16, -0.0, 0.048, 0.18, -0.12); // cheek rise
  box(g, MAT.wood, 0.06, 0.1, 0.13, 0, -0.048, 0.02, -0.45); // wrist
  box(g, MAT.rubber, 0.076, 0.15, 0.028, 0, -0.012, 0.316, -0.12); // recoil pad
  triggerGuard(g, -0.075, -0.048, 0.06);
  // side shell carrier — two spare shells on the receiver
  for (const z of [-0.245, -0.155]) {
    cyl(g, MAT.shellRed, 0.0115, 0.062, -0.052, 0.005, z);
    cyl(g, MAT.brass, 0.0115, 0.016, -0.052, 0.005, z + 0.038);
  }

  // ---- barrel group
  cyl(g, MAT.steel, 0.0235, 0.66, 0, 0.064, -0.6); // barrel
  cyl(g, MAT.steel, 0.0255, 0.06, 0, 0.064, -0.94); // choke
  cyl(g, MAT.bore, 0.0135, 0.008, 0, 0.064, -0.972); // bore
  box(g, MAT.metal, 0.011, 0.009, 0.52, 0, 0.093, -0.58); // vent rib
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), MAT.brass);
  bead.position.set(0, 0.1, -0.9);
  g.add(bead);
  cyl(g, MAT.metal, 0.0185, 0.56, 0, -0.002, -0.55); // magazine tube
  cyl(g, MAT.steel, 0.021, 0.03, 0, -0.002, -0.84); // tube cap

  // ---- pump (animated: racks back after each shot)
  const pump = new THREE.Group();
  g.add(pump);
  box(pump, MAT.wood, 0.102, 0.092, 0.27, 0, -0.002, -0.52);
  for (let i = 0; i < 6; i++) box(pump, MAT.wood, 0.107, 0.097, 0.013, 0, -0.002, -0.622 + i * 0.04); // grip ribs
  box(pump, MAT.metal, 0.02, 0.03, 0.2, -0.04, 0.03, -0.44); // action bars
  box(pump, MAT.metal, 0.02, 0.03, 0.2, 0.04, 0.03, -0.44);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.064, -0.975);
  g.add(muzzle);
  g.scale.setScalar(0.94);
  return { group: g, muzzle, pump, adsY: -0.112 };
}

function buildSmg(): ViewModel {
  const g = new THREE.Group();

  // ---- receiver
  box(g, MAT.metal, 0.084, 0.108, 0.44, 0, 0.012, -0.24);
  box(g, MAT.metal, 0.05, 0.018, 0.4, 0, 0.075, -0.24); // top rib
  box(g, MAT.bore, 0.018, 0.04, 0.08, 0.036, 0.03, -0.18); // ejection port
  cyl(g, MAT.steel, 0.0155, 0.3, 0, 0.078, -0.4); // cocking tube
  cyl(g, MAT.steel, 0.019, 0.15, 0, 0.042, -0.545); // barrel
  cyl(g, MAT.metal, 0.023, 0.055, 0, 0.042, -0.632); // muzzle nut
  cyl(g, MAT.bore, 0.011, 0.008, 0, 0.042, -0.662);

  // ---- front sight: protective ring + post (MP5 signature), aligned with rear drum
  torus(g, MAT.metal, 0.0335, 0.0058, 0, 0.104, -0.5);
  box(g, MAT.metal, 0.008, 0.05, 0.008, 0, 0.078, -0.5);
  box(g, MAT.metal, 0.008, 0.046, 0.012, -0.031, 0.088, -0.5);
  box(g, MAT.metal, 0.008, 0.046, 0.012, 0.031, 0.088, -0.5);
  box(g, MAT.metal, 0.05, 0.014, 0.03, 0, 0.045, -0.5);

  // ---- handguard with ribs
  box(g, MAT.polymer, 0.096, 0.102, 0.3, 0, 0.012, -0.42);
  for (let i = 0; i < 5; i++) box(g, MAT.polymer, 0.1, 0.106, 0.012, 0, 0.012, -0.545 + i * 0.052);

  // ---- rear drum sight
  box(g, MAT.metal, 0.04, 0.022, 0.04, 0, 0.084, -0.045);
  cyl(g, MAT.metal, 0.03, 0.034, 0, 0.104, -0.045, 'x');
  cyl(g, MAT.bore, 0.009, 0.038, 0, 0.104, -0.045, 'x');

  // ---- charging handle (animated as the "slide")
  const slide = new THREE.Group();
  g.add(slide);
  box(slide, MAT.steel, 0.045, 0.016, 0.028, -0.045, 0.078, -0.31);
  cyl(slide, MAT.steel, 0.011, 0.03, -0.062, 0.078, -0.31, 'x');

  // ---- curved magazine (animated)
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.056, 0.2, 0.088, 0, -0.155, -0.155, 0.14);
  box(mag, MAT.steel, 0.056, 0.16, 0.088, 0, -0.3, -0.126, 0.36);
  box(mag, MAT.polymer, 0.06, 0.018, 0.092, 0, -0.378, -0.108, 0.36);

  box(g, MAT.polymer, 0.068, 0.15, 0.085, 0, -0.115, 0.005, -0.28); // grip
  triggerGuard(g, -0.1, -0.045, 0.062);
  cyl(g, MAT.steel, 0.009, 0.026, -0.048, -0.008, -0.02, 'x'); // selector
  box(g, MAT.polymer, 0.068, 0.105, 0.26, 0, 0.005, 0.14); // fixed stock
  box(g, MAT.rubber, 0.07, 0.125, 0.024, 0, 0.005, 0.28); // butt pad
  box(g, MAT.metal, 0.07, 0.09, 0.04, 0, 0.005, 0.015); // stock hinge

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.042, -0.668);
  g.add(muzzle);
  g.scale.setScalar(0.95);
  return { group: g, muzzle, slide, mag, adsY: -0.118 };
}

function buildRifle(): ViewModel {
  const g = new THREE.Group();

  // ---- receivers
  box(g, MAT.metal, 0.078, 0.095, 0.3, 0, -0.002, -0.13); // lower
  box(g, MAT.metal, 0.084, 0.07, 0.11, 0, -0.045, -0.155); // magwell flare
  box(g, MAT.metal, 0.08, 0.068, 0.5, 0, 0.078, -0.27); // upper
  for (let i = 0; i < 9; i++) box(g, MAT.metal, 0.052, 0.014, 0.032, 0, 0.119, -0.48 + i * 0.052); // top rail
  box(g, MAT.bore, 0.016, 0.04, 0.09, 0.034, 0.08, -0.14); // ejection port
  cyl(g, MAT.steel, 0.011, 0.03, 0.046, 0.055, -0.045, 'x'); // forward assist

  // ---- charging handle (animated as the "slide")
  const slide = new THREE.Group();
  g.add(slide);
  box(slide, MAT.steel, 0.046, 0.015, 0.05, 0, 0.102, 0.008);
  box(slide, MAT.steel, 0.07, 0.012, 0.02, 0, 0.102, 0.026);

  // ---- handguard + barrel
  box(g, MAT.polymer, 0.094, 0.096, 0.36, 0, 0.048, -0.55);
  for (let i = 0; i < 6; i++) box(g, MAT.metal, 0.05, 0.013, 0.03, 0, 0.103, -0.68 + i * 0.055); // rail
  for (let i = 0; i < 4; i++) box(g, MAT.bore, 0.097, 0.018, 0.045, 0, 0.062, -0.45 - i * 0.07); // vents
  cyl(g, MAT.steel, 0.0175, 0.3, 0, 0.05, -0.8); // barrel
  box(g, MAT.metal, 0.032, 0.06, 0.045, 0, 0.078, -0.68); // gas block
  box(g, MAT.metal, 0.008, 0.034, 0.008, 0, 0.122, -0.68); // front post
  dot(g, 0, 0.126, -0.674, 0.0036);
  box(g, MAT.metal, 0.006, 0.05, 0.01, -0.02, 0.1, -0.68); // sight wings
  box(g, MAT.metal, 0.006, 0.05, 0.01, 0.02, 0.1, -0.68);
  cyl(g, MAT.steel, 0.024, 0.075, 0, 0.05, -0.955); // muzzle brake
  for (const z of [-0.932, -0.952, -0.972]) cyl(g, MAT.bore, 0.0255, 0.011, 0, 0.05, z); // brake grooves
  cyl(g, MAT.bore, 0.0105, 0.008, 0, 0.05, -0.995);

  // ---- rear aperture sight
  box(g, MAT.metal, 0.04, 0.025, 0.07, 0, 0.126, -0.05);
  cyl(g, MAT.metal, 0.017, 0.042, 0, 0.142, -0.05, 'x');
  cyl(g, MAT.bore, 0.008, 0.046, 0, 0.142, -0.05, 'x');

  // ---- curved STANAG magazine (animated)
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.057, 0.19, 0.09, 0, -0.15, -0.15, 0.16);
  box(mag, MAT.steel, 0.057, 0.15, 0.09, 0, -0.283, -0.124, 0.38);
  box(mag, MAT.polymer, 0.061, 0.018, 0.094, 0, -0.352, -0.104, 0.38);
  for (let i = 0; i < 3; i++) box(mag, MAT.bore, 0.059, 0.008, 0.07, 0, -0.1 - i * 0.055, -0.158 - i * 0.008, 0.16); // mag ribs

  box(g, MAT.polymer, 0.07, 0.155, 0.088, 0, -0.125, 0.01, -0.3); // pistol grip
  triggerGuard(g, -0.085, -0.05, 0.06);
  cyl(g, MAT.metal, 0.019, 0.16, 0, 0.035, 0.1); // buffer tube
  box(g, MAT.polymer, 0.066, 0.115, 0.25, 0, 0.005, 0.245); // stock
  box(g, MAT.polymer, 0.05, 0.035, 0.18, 0, 0.056, 0.25); // cheek weld
  box(g, MAT.rubber, 0.068, 0.13, 0.022, 0, 0.005, 0.378); // butt pad

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, -0.998);
  g.add(muzzle);
  g.scale.setScalar(0.88);
  return { group: g, muzzle, slide, mag, adsY: -0.148 };
}

/** M29-style .44: full underlug barrel, swing-out cylinder, ramp front sight. */
function buildMagnum(): ViewModel {
  const g = new THREE.Group();

  // ---- frame: top strap over the cylinder, standing breech, crane
  box(g, MAT.metal, 0.05, 0.024, 0.15, 0, 0.088, -0.02);
  box(g, MAT.metal, 0.05, 0.064, 0.055, 0, 0.052, 0.06);
  box(g, MAT.metal, 0.046, 0.05, 0.05, 0, 0.012, 0.052);
  box(g, MAT.metal, 0.034, 0.032, 0.1, 0, 0.0, -0.038);

  // ---- barrel, full underlug and ejector rod housing
  cyl(g, MAT.steel, 0.0205, 0.27, 0, 0.08, -0.2);
  box(g, MAT.metal, 0.036, 0.036, 0.27, 0, 0.05, -0.2);
  cyl(g, MAT.metal, 0.0095, 0.2, 0, 0.032, -0.25);
  cyl(g, MAT.steel, 0.0075, 0.032, 0, 0.032, -0.148);
  cyl(g, MAT.bore, 0.0115, 0.012, 0, 0.08, -0.336);
  box(g, MAT.metal, 0.014, 0.012, 0.26, 0, 0.098, -0.2);

  // ---- sights: ramp front with red insert, notched rear
  box(g, MAT.metal, 0.012, 0.018, 0.034, 0, 0.102, -0.312);
  box(g, MAT.shellRed, 0.014, 0.007, 0.016, 0, 0.1075, -0.316);
  dot(g, 0, 0.1085, -0.316, 0.0034);
  box(g, MAT.metal, 0.03, 0.026, 0.022, 0, 0.096, 0.052);
  box(g, MAT.bore, 0.009, 0.012, 0.012, 0, 0.104, 0.052);

  // ---- cylinder: chambers drilled along the bore axis, spins about Z
  const cylinder = new THREE.Group();
  cylinder.position.set(0, 0.042, -0.012);
  g.add(cylinder);
  const cBody = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.08, 14), MAT.metal);
  cBody.rotation.x = Math.PI / 2;
  cylinder.add(cBody);
  for (const z of [-0.042, 0.042]) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.0405, 0.0405, 0.009, 14), MAT.steel);
    rim.rotation.x = Math.PI / 2;
    rim.position.z = z;
    cylinder.add(rim);
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.0095, 0.0095, 0.088, 10), MAT.bore);
    chamber.rotation.x = Math.PI / 2;
    chamber.position.set(Math.cos(a) * 0.0235, Math.sin(a) * 0.0235, 0);
    cylinder.add(chamber);
  }
  // a live round peeking from the chamber nearest the top strap
  const round = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.02, 10), MAT.brass);
  round.rotation.x = Math.PI / 2;
  round.position.set(0, 0.0235, -0.048);
  cylinder.add(round);

  // ---- hammer
  const hammer = new THREE.Group();
  hammer.position.set(0, 0.086, 0.082);
  g.add(hammer);
  box(hammer, MAT.steel, 0.015, 0.011, 0.04, 0, 0.012, 0.03);
  box(hammer, MAT.steel, 0.014, 0.038, 0.015, 0, -0.006, 0);

  // ---- grip, trigger guard
  box(g, MAT.wood, 0.046, 0.155, 0.078, 0, -0.062, 0.072, -0.35);
  box(g, MAT.wood, 0.05, 0.022, 0.086, 0, -0.132, 0.094, -0.35);
  triggerGuard(g, -0.035, -0.022, 0.075);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.08, -0.344);
  g.add(muzzle);
  return { group: g, muzzle, hammer, cylinder, adsY: -0.12 };
}

/** AK-47: stamped receiver, wooden furniture, banana magazine, gas tube. */
function buildAk(): ViewModel {
  const g = new THREE.Group();
  box(g, MAT.metal, 0.08, 0.095, 0.34, 0, 0.012, -0.16); // receiver
  box(g, MAT.metal, 0.07, 0.02, 0.3, 0, 0.068, -0.16); // dust cover
  box(g, MAT.bore, 0.018, 0.042, 0.1, 0.036, 0.02, -0.2); // ejection port
  box(g, MAT.steel, 0.012, 0.05, 0.05, 0.044, 0.03, -0.06, 0, 0, 0.5); // safety lever
  box(g, MAT.wood, 0.062, 0.118, 0.3, 0, -0.018, 0.155, -0.07); // buttstock
  box(g, MAT.rubber, 0.064, 0.13, 0.02, 0, -0.005, 0.308, -0.07); // buttplate
  box(g, MAT.wood, 0.06, 0.14, 0.075, 0, -0.118, 0.015, -0.32); // grip
  triggerGuard(g, -0.045, -0.042, 0.06);

  cyl(g, MAT.steel, 0.019, 0.44, 0, 0.055, -0.53); // barrel
  box(g, MAT.metal, 0.032, 0.055, 0.04, 0, 0.068, -0.47); // gas block
  cyl(g, MAT.steel, 0.012, 0.3, 0, 0.098, -0.42); // gas tube
  box(g, MAT.wood, 0.058, 0.032, 0.22, 0, 0.092, -0.4); // gas tube cover
  box(g, MAT.wood, 0.076, 0.082, 0.24, 0, 0.028, -0.35); // handguard
  box(g, MAT.metal, 0.036, 0.038, 0.055, 0, 0.055, -0.762, 0.5); // slant brake
  cyl(g, MAT.bore, 0.011, 0.012, 0, 0.055, -0.79); // bore
  cyl(g, MAT.steel, 0.004, 0.36, 0, 0.02, -0.48); // cleaning rod

  // hooded front post, tangent rear leaf — sight line ≈ 0.126
  box(g, MAT.metal, 0.008, 0.058, 0.008, 0, 0.098, -0.68);
  box(g, MAT.metal, 0.006, 0.04, 0.014, -0.016, 0.09, -0.68);
  box(g, MAT.metal, 0.006, 0.04, 0.014, 0.016, 0.09, -0.68);
  dot(g, 0, 0.128, -0.68, 0.0034);
  box(g, MAT.metal, 0.034, 0.016, 0.05, 0, 0.082, -0.055, -0.25);
  box(g, MAT.bore, 0.01, 0.008, 0.02, 0, 0.09, -0.052);

  // the banana: three progressively raked segments
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.056, 0.17, 0.085, 0, -0.125, -0.135, 0.12);
  box(mag, MAT.steel, 0.056, 0.17, 0.085, 0, -0.248, -0.108, 0.34);
  box(mag, MAT.steel, 0.056, 0.14, 0.085, 0, -0.345, -0.062, 0.58);
  box(mag, MAT.polymer, 0.06, 0.018, 0.09, 0, -0.405, -0.032, 0.58);
  for (let i = 0; i < 4; i++) box(mag, MAT.bore, 0.058, 0.007, 0.07, 0, -0.08 - i * 0.07, -0.142 - i * 0.004, 0.12 + i * 0.05);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.055, -0.8);
  g.add(muzzle);
  g.scale.setScalar(0.92);
  return { group: g, muzzle, mag, adsY: -0.126 };
}

/** M16: carry handle, A-frame front sight, three-prong flash hider. */
function buildM16(): ViewModel {
  const g = new THREE.Group();
  box(g, MAT.metal, 0.08, 0.1, 0.28, 0, 0, -0.12); // lower receiver
  box(g, MAT.metal, 0.084, 0.062, 0.1, 0, -0.04, -0.18); // magwell
  box(g, MAT.metal, 0.058, 0.03, 0.32, 0, 0.062, -0.14); // upper receiver
  box(g, MAT.bore, 0.016, 0.038, 0.085, 0.034, 0.008, -0.12); // ejection port

  // ---- carry handle with twin aperture discs (sight line ≈ 0.132)
  box(g, MAT.metal, 0.052, 0.016, 0.27, 0, 0.112, -0.14); // handle bar
  box(g, MAT.metal, 0.046, 0.038, 0.03, 0, 0.092, -0.265); // rear pillar
  box(g, MAT.metal, 0.046, 0.038, 0.03, 0, 0.092, -0.03); // front pillar
  cyl(g, MAT.metal, 0.027, 0.05, 0, 0.129, -0.035, 'x'); // rear aperture housing
  cyl(g, MAT.bore, 0.010, 0.054, 0, 0.129, -0.035, 'x'); // aperture
  cyl(g, MAT.steel, 0.012, 0.056, 0, 0.104, -0.035, 'x'); // windage drum

  // ---- handguard + barrel
  box(g, MAT.polymer, 0.086, 0.1, 0.34, 0, 0.032, -0.45);
  box(g, MAT.metal, 0.06, 0.018, 0.32, 0, 0.088, -0.45); // heat shield
  cyl(g, MAT.metal, 0.034, 0.035, 0, 0.045, -0.27); // delta ring
  cyl(g, MAT.steel, 0.016, 0.36, 0, 0.055, -0.72); // pencil barrel

  // ---- A-frame front sight (post top ≈ 0.132)
  box(g, MAT.metal, 0.008, 0.085, 0.014, -0.024, 0.093, -0.62, 0, 0, 0.32);
  box(g, MAT.metal, 0.008, 0.085, 0.014, 0.024, 0.093, -0.62, 0, 0, -0.32);
  box(g, MAT.metal, 0.055, 0.01, 0.014, 0, 0.122, -0.62);
  box(g, MAT.metal, 0.007, 0.026, 0.007, 0, 0.12, -0.62);
  dot(g, 0, 0.132, -0.614, 0.0034);
  box(g, MAT.metal, 0.03, 0.028, 0.04, 0, 0.055, -0.62); // gas block base

  // ---- three-prong flash hider
  box(g, MAT.metal, 0.007, 0.016, 0.062, 0, 0.077, -0.905);
  box(g, MAT.metal, 0.007, 0.016, 0.062, -0.017, 0.041, -0.905, 0, 0, 0.5);
  box(g, MAT.metal, 0.007, 0.016, 0.062, 0.017, 0.041, -0.905, 0, 0, -0.5);

  // ---- curved 30-round magazine (animated), stock, grip
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.055, 0.18, 0.085, 0, -0.135, -0.165, 0.16);
  box(mag, MAT.steel, 0.055, 0.15, 0.085, 0, -0.268, -0.138, 0.4);
  box(mag, MAT.polymer, 0.059, 0.018, 0.09, 0, -0.338, -0.112, 0.4);

  const slide = new THREE.Group();
  g.add(slide);
  box(slide, MAT.steel, 0.048, 0.014, 0.045, 0, 0.078, 0.005); // charging handle

  box(g, MAT.polymer, 0.068, 0.152, 0.085, 0, -0.118, 0.005, -0.3); // grip
  triggerGuard(g, -0.075, -0.045, 0.06);
  cyl(g, MAT.metal, 0.018, 0.14, 0, 0.028, 0.08); // buffer tube
  box(g, MAT.polymer, 0.066, 0.128, 0.3, 0, 0.002, 0.21); // fixed stock
  box(g, MAT.rubber, 0.068, 0.14, 0.02, 0, 0.002, 0.368); // buttplate

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.055, -0.94);
  g.add(muzzle);
  g.scale.setScalar(0.92);
  return { group: g, muzzle, slide, mag, adsY: -0.132 };
}

/** L96-style precision rifle: fluted barrel, big brake, scope, bolt, bipod. */
function buildSniper(): ViewModel {
  const g = new THREE.Group();
  box(g, MAT.metal, 0.09, 0.095, 0.34, 0, 0.012, -0.16); // receiver
  box(g, MAT.metal, 0.06, 0.016, 0.3, 0, 0.066, -0.17); // top rail base
  for (let i = 0; i < 6; i++) box(g, MAT.metal, 0.04, 0.012, 0.026, 0, 0.078, -0.3 + i * 0.05);

  // ---- heavy fluted barrel + brake (bore y = 0.05)
  cyl(g, MAT.steel, 0.0245, 0.56, 0, 0.05, -0.6);
  for (const [fx, fy] of [[0, 0.0765], [-0.0245, 0.05], [0.0245, 0.05]] as const) {
    box(g, fx === 0 ? MAT.steel : MAT.bore, fx === 0 ? 0.008 : 0.005, fx === 0 ? 0.005 : 0.014, 0.4, fx, fy, -0.58);
  }
  box(g, MAT.metal, 0.048, 0.058, 0.11, 0, 0.05, -0.93); // brake body
  for (const z of [-0.9, -0.93, -0.96]) box(g, MAT.bore, 0.052, 0.02, 0.012, 0, 0.05, z); // brake slots
  cyl(g, MAT.bore, 0.012, 0.012, 0, 0.05, -0.99);

  // ---- scope: rings, bells, turrets (axis y = 0.135). The rings sit on
  // mounting posts bolted to the rail — previously the optic floated above
  // the gun with a visible gap underneath it.
  box(g, MAT.metal, 0.02, 0.032, 0.024, 0, 0.098, -0.27); // front mount post
  box(g, MAT.metal, 0.02, 0.032, 0.024, 0, 0.098, -0.43); // rear mount post
  torus(g, MAT.metal, 0.026, 0.006, 0, 0.112, -0.27);
  torus(g, MAT.metal, 0.026, 0.006, 0, 0.112, -0.43);
  cyl(g, MAT.metal, 0.018, 0.26, 0, 0.135, -0.35); // main tube
  cyl(g, MAT.metal, 0.028, 0.075, 0, 0.135, -0.5); // objective bell
  cyl(g, MAT.bore, 0.024, 0.01, 0, 0.135, -0.54); // glass
  cyl(g, MAT.metal, 0.024, 0.055, 0, 0.135, -0.19); // ocular
  cyl(g, MAT.rubber, 0.026, 0.025, 0, 0.135, -0.155); // eye cup
  cyl(g, MAT.metal, 0.016, 0.03, 0, 0.165, -0.35, 'y'); // elevation turret
  cyl(g, MAT.metal, 0.015, 0.026, -0.028, 0.135, -0.35, 'x'); // windage turret

  // ---- bolt handle (animated): shank + knob on a pivot group
  const bolt = new THREE.Group();
  bolt.position.set(0.045, 0.058, -0.02);
  g.add(bolt);
  cyl(bolt, MAT.steel, 0.008, 0.052, 0.026, 0, 0, 'x');
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.017, 10, 10), MAT.polymer);
  knob.position.set(0.058, -0.006, 0);
  bolt.add(knob);
  box(g, MAT.bore, 0.016, 0.03, 0.07, 0.036, 0.045, -0.05); // bolt raceway shadow

  // ---- chassis stock, cheek riser, magazine, bipod
  box(g, MAT.polymer, 0.07, 0.125, 0.32, 0, -0.008, 0.15);
  box(g, MAT.polymer, 0.056, 0.03, 0.16, 0, 0.07, 0.16); // cheek riser
  box(g, MAT.rubber, 0.072, 0.14, 0.024, 0, -0.002, 0.322); // buttpad
  box(g, MAT.polymer, 0.068, 0.15, 0.085, 0, -0.118, 0.01, -0.3); // grip
  triggerGuard(g, -0.06, -0.045, 0.062);
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.steel, 0.055, 0.13, 0.09, 0, -0.105, -0.14, 0.14);
  box(mag, MAT.polymer, 0.059, 0.018, 0.094, 0, -0.172, -0.128, 0.14);
  box(g, MAT.metal, 0.05, 0.03, 0.06, 0, 0.012, -0.68); // bipod mount
  cyl(g, MAT.steel, 0.006, 0.26, -0.032, 0.02, -0.72).rotation.x = 1.25; // folded leg L
  cyl(g, MAT.steel, 0.006, 0.26, 0.032, 0.02, -0.72).rotation.x = 1.25; // folded leg R

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, -1.0);
  g.add(muzzle);
  g.scale.setScalar(0.9);
  // adsY matches the lowered scope axis (0.135), so the reticle sits on the lens
  return { group: g, muzzle, mag, bolt, adsY: -0.135 };
}

/** M9 Bazooka: long olive tube, venturi flare, blast shield, side sight. */
function buildBazooka(): ViewModel {
  const g = new THREE.Group();
  const olive = new THREE.MeshStandardMaterial({ map: gunmetalTexture(), color: 0x7d8a55, roughness: 0.62, metalness: 0.45, envMapIntensity: 0.9 });
  // main tube (axis y = 0.06) running from behind the shoulder to the muzzle
  cyl(g, olive, 0.056, 1.12, 0, 0.06, -0.3);
  cyl(g, MAT.bore, 0.05, 1.13, 0, 0.06, -0.3); // inner shadow, seen at the ends
  // reinforcing bands
  for (const z of [-0.78, -0.45, -0.05, 0.18]) cyl(g, MAT.metal, 0.06, 0.03, 0, 0.06, z);
  // muzzle lip + rear venturi flare
  cyl(g, MAT.steel, 0.064, 0.04, 0, 0.06, -0.86);
  const flare = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.085, 0.14, 16, 1, true), MAT.metal);
  flare.rotation.x = Math.PI / 2;
  flare.position.set(0, 0.06, 0.32);
  g.add(flare);
  // blast shield (square plate the gunner peers past)
  box(g, MAT.metal, 0.16, 0.14, 0.008, -0.02, 0.07, -0.62);
  // shoulder rest pad + wiring box
  box(g, MAT.rubber, 0.05, 0.05, 0.16, 0, -0.005, 0.06);
  box(g, MAT.polymer, 0.04, 0.05, 0.1, 0.05, 0.03, -0.2);
  cyl(g, MAT.brass, 0.005, 0.32, 0.055, 0.02, -0.36);
  // side-mounted ring sight (sight line y=0.13, x=-0.075)
  box(g, MAT.metal, 0.03, 0.06, 0.03, -0.06, 0.1, -0.5);
  torus(g, MAT.metal, 0.022, 0.003, -0.075, 0.13, -0.5);
  box(g, MAT.metal, 0.03, 0.05, 0.02, -0.06, 0.1, -0.2);
  box(g, MAT.metal, 0.004, 0.02, 0.004, -0.075, 0.13, -0.2);
  dot(g, -0.075, 0.13, -0.5, 0.003);
  // pistol grip, trigger guard, forward grip
  box(g, MAT.wood, 0.05, 0.14, 0.07, 0, -0.07, -0.1, -0.25);
  triggerGuard(g, -0.17, 0.012, 0.06);
  box(g, MAT.wood, 0.045, 0.12, 0.06, 0, -0.06, -0.42, -0.1);
  // the warhead peeking out of the muzzle (hidden while empty)
  const warhead = new THREE.Group();
  g.add(warhead);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 14),
    new THREE.MeshStandardMaterial({ color: 0x5d6640, roughness: 0.5, metalness: 0.4 }));
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.06, -0.94);
  warhead.add(nose);
  cyl(warhead, MAT.brass, 0.03, 0.02, 0, 0.06, -1.01);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.06, -0.9);
  g.add(muzzle);
  g.scale.setScalar(0.9);
  return { group: g, muzzle, warhead, adsX: 0.068, adsY: -0.117 };
}

/** HL-4: boxy modern launcher with a top seeker unit and a 3-round clip. */
function buildRocketLauncher(): ViewModel {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ map: polymerTexture(), color: 0x5a5e62, roughness: 0.55, metalness: 0.3, envMapIntensity: 0.8 });
  box(g, shell, 0.15, 0.16, 0.92, 0, 0.04, -0.28); // body
  box(g, MAT.metal, 0.16, 0.03, 0.9, 0, 0.13, -0.28); // spine rail
  for (let i = 0; i < 7; i++) box(g, MAT.metal, 0.1, 0.012, 0.03, 0, 0.152, -0.6 + i * 0.09);
  box(g, MAT.metal, 0.17, 0.18, 0.06, 0, 0.04, -0.75); // front hood
  box(g, MAT.bore, 0.11, 0.11, 0.02, 0, 0.04, -0.785); // square bore
  box(g, MAT.metal, 0.12, 0.12, 0.05, 0, 0.04, 0.2); // rear exhaust frame
  box(g, MAT.bore, 0.09, 0.09, 0.02, 0, 0.04, 0.225);
  // side panel detail + hazard band
  box(g, MAT.metal, 0.005, 0.08, 0.3, 0.078, 0.04, -0.35);
  box(g, new THREE.MeshStandardMaterial({ color: 0xa58a2a, roughness: 0.5 }), 0.152, 0.02, 0.06, 0, -0.035, -0.62);
  // seeker / targeting unit on top: housing, lens, rear screen
  box(g, MAT.metal, 0.07, 0.06, 0.18, 0, 0.19, -0.22);
  cyl(g, MAT.steel, 0.026, 0.03, 0, 0.19, -0.32);
  cyl(g, new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.05, metalness: 0.6 }), 0.02, 0.005, 0, 0.19, -0.337);
  const screenMat = new THREE.MeshStandardMaterial({ color: 0x1a0505, emissive: 0xff3322, emissiveIntensity: 1.2, roughness: 0.3 });
  box(g, screenMat, 0.05, 0.035, 0.004, 0, 0.192, -0.128);
  // grips + stock
  box(g, MAT.polymer, 0.055, 0.14, 0.07, 0, -0.1, -0.05, -0.25);
  triggerGuard(g, -0.12, -0.04, 0.06);
  box(g, MAT.polymer, 0.05, 0.12, 0.06, 0, -0.08, -0.48);
  box(g, MAT.rubber, 0.09, 0.12, 0.05, 0, 0.0, 0.08);
  // clip of 3 missiles under the body (drops on reload)
  const mag = new THREE.Group();
  g.add(mag);
  box(mag, MAT.metal, 0.12, 0.06, 0.26, 0, -0.07, -0.28);
  for (const x of [-0.035, 0, 0.035]) cyl(mag, MAT.brass, 0.012, 0.24, x, -0.07, -0.28);
  // missile nose visible in the bore while loaded
  const warhead = new THREE.Group();
  g.add(warhead);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.06, 12), MAT.steel);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 0.04, -0.79);
  warhead.add(nose);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.04, -0.8);
  g.add(muzzle);
  g.scale.setScalar(0.9);
  return { group: g, muzzle, mag, warhead, screenMat, adsY: -0.171 };
}

/** The anti-matter projector: a caged singularity with orbiting energy rings. */
function buildAntimatter(): ViewModel {
  const g = new THREE.Group();
  const housing = new THREE.MeshStandardMaterial({ map: gunmetalTexture(), color: 0x9aa0aa, roughness: 0.3, metalness: 0.9, envMapIntensity: 1.4 });
  const glowA = new THREE.MeshStandardMaterial({ color: 0x120a24, emissive: 0x8a5cff, emissiveIntensity: 1.4, roughness: 0.4 });
  const glowB = new THREE.MeshStandardMaterial({ color: 0x120a24, emissive: 0x5ad8ff, emissiveIntensity: 1.1, roughness: 0.4 });
  // rear power block + cell
  box(g, housing, 0.1, 0.12, 0.2, 0, 0.03, 0.08);
  cyl(g, glowA, 0.03, 0.14, 0, -0.02, 0.1);
  // twin side rails caging the chamber
  box(g, housing, 0.02, 0.06, 0.42, -0.075, 0.05, -0.2);
  box(g, housing, 0.02, 0.06, 0.42, 0.075, 0.05, -0.2);
  box(g, housing, 0.17, 0.03, 0.05, 0, 0.1, -0.05);
  box(g, housing, 0.17, 0.03, 0.05, 0, 0.1, -0.36);
  box(g, housing, 0.17, 0.03, 0.05, 0, 0.0, -0.05);
  box(g, housing, 0.17, 0.03, 0.05, 0, 0.0, -0.36);
  // energy lines along the rails
  box(g, glowB, 0.004, 0.008, 0.38, -0.086, 0.06, -0.2);
  box(g, glowB, 0.004, 0.008, 0.38, 0.086, 0.06, -0.2);
  // the chamber: glass shell, black core, orbiting rings
  const glass = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0x8877ff, transparent: true, opacity: 0.18, roughness: 0.02, metalness: 0.1, envMapIntensity: 2 }));
  glass.position.set(0, 0.05, -0.205);
  g.add(glass);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.04, 18, 18), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  core.position.copy(glass.position);
  g.add(core);
  const rings: THREE.Object3D[] = [];
  [0.058, 0.068].forEach((r, i) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0035, 8, 32), i === 0 ? glowA : glowB);
    ring.position.copy(glass.position);
    ring.rotation.set(i * 1.1, i * 0.7, 0);
    g.add(ring);
    rings.push(ring);
  });
  // emitter barrel: three prongs with coil rings
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    box(g, housing, 0.012, 0.012, 0.18, Math.cos(a) * 0.035, 0.05 + Math.sin(a) * 0.035, -0.45);
  }
  for (const z of [-0.39, -0.45, -0.51]) torus(g, housing, 0.042, 0.005, 0, 0.05, z);
  const tipRing = torus(g, glowA, 0.03, 0.004, 0, 0.05, -0.54);
  // grip + guard + top sight ridge
  box(g, MAT.polymer, 0.055, 0.14, 0.07, 0, -0.08, 0.04, -0.28);
  triggerGuard(g, -0.03, -0.012, 0.06);
  box(g, housing, 0.02, 0.02, 0.3, 0, 0.125, -0.22);
  box(g, housing, 0.006, 0.02, 0.006, 0, 0.143, -0.36);
  dot(g, 0, 0.152, -0.36, 0.003);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, -0.56);
  g.add(muzzle);
  void tipRing;
  return { group: g, muzzle, rings, core, glowMats: [glowA, glowB], adsY: -0.152 };
}

/**
 * A blade from a 2D profile (x = length from guard, y = edge→spine),
 * extruded to thickness and turned to point down -Z like every muzzle.
 */
function bladeMesh(parent: THREE.Object3D, draw: (s: THREE.Shape) => void, thickness: number, mat: THREE.Material = MAT.blade): THREE.Mesh {
  const shape = new THREE.Shape();
  draw(shape);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0012, bevelSegments: 1 });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateY(Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  parent.add(m);
  return m;
}

/** Combat knife: tanto point, crossguard, ringed polymer grip. */
function buildKnife(): ViewModel {
  const g = new THREE.Group();
  bladeMesh(g, (s) => {
    s.moveTo(0, 0); s.lineTo(0.125, 0.002); s.lineTo(0.168, 0.014); s.lineTo(0.192, 0.031);
    s.lineTo(0.03, 0.035); s.lineTo(0, 0.033); s.closePath();
  }, 0.005);
  box(g, MAT.bladeDark, 0.0035, 0.004, 0.1, 0.004, 0.02, -0.075); // fuller shadow line
  box(g, MAT.steel, 0.056, 0.009, 0.02, 0, 0.016, -0.002); // crossguard
  box(g, MAT.polymer, 0.027, 0.033, 0.105, 0, 0.014, 0.058); // grip
  for (let i = 0; i < 3; i++) box(g, MAT.rubber, 0.029, 0.035, 0.008, 0, 0.014, 0.032 + i * 0.028); // grip rings
  cyl(g, MAT.steel, 0.016, 0.012, 0, 0.014, 0.116); // pommel cap
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.2);
  g.add(muzzle);
  return { group: g, muzzle, adsY: -0.16 };
}

/** Kitchen knife: wide chef's blade, riveted wooden handle, a cook's last argument. */
function buildKitchen(): ViewModel {
  const g = new THREE.Group();
  bladeMesh(g, (s) => {
    s.moveTo(0, 0); s.lineTo(0.14, 0.001);
    s.quadraticCurveTo(0.19, 0.004, 0.215, 0.032);
    s.lineTo(0.03, 0.05); s.lineTo(0, 0.048); s.closePath();
  }, 0.0035);
  box(g, MAT.bladeDark, 0.002, 0.002, 0.19, 0, 0.008, -0.1); // worn edge line
  box(g, MAT.steel, 0.03, 0.042, 0.012, 0, 0.024, 0.004); // bolster
  box(g, MAT.wood, 0.024, 0.036, 0.11, 0, 0.022, 0.062); // handle scales
  for (let i = 0; i < 3; i++) cyl(g, MAT.brass, 0.004, 0.028, 0, 0.022, 0.032 + i * 0.03, 'x'); // rivets
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.22);
  g.add(muzzle);
  return { group: g, muzzle, adsY: -0.16 };
}

/** Machete: broad heavy blade with a clipped point and a wrapped black grip. */
function buildMachete(): ViewModel {
  const g = new THREE.Group();
  bladeMesh(g, (s) => {
    s.moveTo(0, 0); s.lineTo(0.32, 0.003); s.lineTo(0.42, 0.016); s.lineTo(0.465, 0.052);
    s.lineTo(0.44, 0.062); s.lineTo(0.04, 0.06); s.lineTo(0, 0.056); s.closePath();
  }, 0.006, MAT.bladeDark);
  box(g, MAT.blade, 0.0025, 0.003, 0.4, 0, 0.004, -0.22); // sharpened edge catching light
  box(g, MAT.steel, 0.04, 0.05, 0.014, 0, 0.026, 0.002); // guard plate
  box(g, MAT.rubber, 0.028, 0.036, 0.115, 0, 0.024, 0.062); // grip
  for (let i = 0; i < 4; i++) box(g, MAT.polymer, 0.03, 0.038, 0.007, 0, 0.024, 0.028 + i * 0.026); // wrap ridges
  torus(g, MAT.brass, 0.011, 0.003, 0, 0.024, 0.125); // lanyard ring
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -0.47);
  g.add(muzzle);
  g.scale.setScalar(0.95);
  return { group: g, muzzle, adsY: -0.17 };
}

/** Katana: gently curved blade, brass tsuba, diamond-wrapped tsuka. */
function buildKatana(): ViewModel {
  const g = new THREE.Group();
  bladeMesh(g, (s) => {
    s.moveTo(0, 0);
    s.quadraticCurveTo(0.34, -0.014, 0.615, 0.026); // edge sweeps up to the kissaki
    s.lineTo(0.675, 0.052);
    s.quadraticCurveTo(0.34, 0.018, 0, 0.03); // spine
    s.closePath();
  }, 0.005);
  box(g, MAT.blade, 0.002, 0.0025, 0.55, 0, 0.002, -0.3); // edge highlight
  cyl(g, MAT.brass, 0.036, 0.007, 0, 0.015, -0.006); // tsuba
  cyl(g, MAT.steel, 0.02, 0.012, 0, 0.015, 0.004); // habaki collar
  cyl(g, new THREE.MeshStandardMaterial({ color: 0x14151c, roughness: 0.85 }), 0.0155, 0.235, 0, 0.015, 0.125); // tsuka core
  // diamond wrap: alternating tilted cords
  for (let i = 0; i < 6; i++) {
    box(g, new THREE.MeshStandardMaterial({ color: 0x23283a, roughness: 0.8 }), 0.034, 0.012, 0.02, 0, 0.015, 0.032 + i * 0.033, 0, 0, i % 2 === 0 ? 0.5 : -0.5);
  }
  cyl(g, MAT.brass, 0.016, 0.014, 0, 0.015, 0.248); // kashira pommel
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -0.68);
  g.add(muzzle);
  g.scale.setScalar(0.92);
  return { group: g, muzzle, adsY: -0.17 };
}

function buildViewModel(id: WeaponId): ViewModel {
  const vm = id === 'pistol' ? buildPistol()
    : id === 'shotgun' ? buildShotgun()
    : id === 'smg' ? buildSmg()
    : id === 'rifle' ? buildRifle()
    : id === 'magnum' ? buildMagnum()
    : id === 'ak' ? buildAk()
    : id === 'm16' ? buildM16()
    : id === 'sniper' ? buildSniper()
    : id === 'bazooka' ? buildBazooka()
    : id === 'rocket' ? buildRocketLauncher()
    : id === 'antimatter' ? buildAntimatter()
    : id === 'knife' ? buildKnife()
    : id === 'kitchen' ? buildKitchen()
    : id === 'machete' ? buildMachete()
    : buildKatana();
  vm.group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false; // camera-attached: never cull
    }
  });
  return vm;
}

// ================================================================= system
export class WeaponSystem {
  owned = new Set<WeaponId>(['pistol']);
  mags = Object.fromEntries(WEAPON_ORDER.map((id) => [id, id === 'pistol' ? 12 : 0])) as Record<WeaponId, number>;
  reserve = Object.fromEntries(WEAPON_ORDER.map((id) => [id, id === 'pistol' ? 36 : 0])) as Record<WeaponId, number>;
  current: WeaponId = 'pistol';

  private models = new Map<WeaponId, ViewModel>();
  private root = new THREE.Group();
  private hooks: WeaponHooks;
  private audio: AudioEngine;
  private effects: Effects;

  private cooldown = 0;
  private reloadTimer = 0;
  private reloadStage = 0;
  private pumpTimer = 0;
  private switchTimer = 0;
  private switchingTo: WeaponId | null = null;
  private triggerHeld = false;
  private triggerConsumed = false;
  /** Rounds remaining in an in-progress 3-round burst (M16). */
  private burstLeft = 0;
  /** Sniper bolt-cycle timer. */
  private boltTimer = 0;
  /** Melee swing remaining (0 = at rest); the hit lands near the apex. */
  private swingTimer = 0;
  private swingHitDone = true;
  /** Anti-matter wind-up remaining (shot leaves when it hits 0). */
  chargeTimer = 0;
  private ringSpin = 0;
  private idleT = 0;
  /** Set by Game each frame from the HL-4's seeker. */
  lockState: 'none' | 'seeking' | 'locked' = 'none';
  adsAmount = 0;
  private kickZ = 0;
  private swayX = 0;
  private swayY = 0;
  private magDrop = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  spreadBloom = 0;
  // revolver cylinder rotation (displayed / target, in radians)
  private cylSpin = 0;
  private cylTarget = 0;

  onAmmoChanged: (() => void) | null = null;

  constructor(camera: THREE.Camera, hooks: WeaponHooks, audio: AudioEngine, effects: Effects) {
    this.hooks = hooks;
    this.audio = audio;
    this.effects = effects;
    WEAPON_ORDER.forEach((id) => {
      const vm = buildViewModel(id);
      vm.group.visible = false;
      this.models.set(id, vm);
      this.root.add(vm.group);
    });
    this.models.get('pistol')!.group.visible = true;
    this.root.position.set(0.24, -0.22, -0.45);
    camera.add(this.root);
  }

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  get reloading() { return this.reloadTimer > 0; }
  get busy() { return this.reloadTimer > 0 || this.switchTimer > 0 || this.chargeTimer > 0; }

  /**
   * The ` cheat: own every registered weapon (read from WEAPON_ORDER, so new
   * weapons are included automatically). Already-owned weapons keep their
   * magazine and only get topped up — nothing is duplicated or erased.
   * Returns the weapons that were newly granted.
   */
  grantAll(): WeaponId[] {
    const granted: WeaponId[] = [];
    for (const id of WEAPON_ORDER) {
      const d = WEAPONS[id];
      const testReserve = Math.min(d.maxReserve, Math.max(d.startReserve, d.magSize * 2));
      if (!this.owned.has(id)) {
        this.owned.add(id);
        this.mags[id] = d.magSize;
        this.reserve[id] = testReserve;
        granted.push(id);
      } else {
        this.reserve[id] = Math.max(this.reserve[id], testReserve);
      }
    }
    this.onAmmoChanged?.();
    return granted;
  }

  /** True while looking through the sniper scope (drives FOV + overlay). */
  get scoped() { return !!this.def.scoped && this.adsAmount > 0.8; }

  /** Movement multiplier from aiming (the scoped sniper crawls). */
  moveFactor(): number {
    if (this.def.scoped) return 1 - this.adsAmount * 0.68;
    return 1 - this.adsAmount * 0.18;
  }

  giveWeapon(id: WeaponId) {
    if (!this.owned.has(id)) {
      this.owned.add(id);
      this.mags[id] = WEAPONS[id].magSize;
      // keep any rounds banked before the gun was found
      this.reserve[id] = Math.min(WEAPONS[id].maxReserve, this.reserve[id] + WEAPONS[id].startReserve);
    } else {
      this.reserve[id] = Math.min(WEAPONS[id].maxReserve, this.reserve[id] + WEAPONS[id].startReserve);
    }
    this.onAmmoChanged?.();
  }

  addAmmo(kind: AmmoKind, amount: number): boolean {
    // Reserves are tracked per weapon, but some calibres are shared (the M16
    // and AR-15 both eat 5.56). Credit the gun in your hands first, then the
    // canonical owner, then any other owned weapon chambered for it — so a
    // pickup never vanishes into a weapon you don't have yet.
    const candidates: WeaponId[] = [];
    if (AMMO_FOR_WEAPON[this.current] === kind) candidates.push(this.current);
    candidates.push(WEAPON_FOR_AMMO[kind]);
    (Object.keys(WEAPONS) as WeaponId[]).forEach((id) => {
      if (AMMO_FOR_WEAPON[id] === kind && !candidates.includes(id)) candidates.push(id);
    });
    for (const id of candidates) {
      if (!this.owned.has(id)) continue;
      if (this.reserve[id] >= WEAPONS[id].maxReserve) continue;
      this.reserve[id] = Math.min(WEAPONS[id].maxReserve, this.reserve[id] + amount);
      this.onAmmoChanged?.();
      return true;
    }
    // nobody owns a gun for this yet: bank it for the canonical weapon
    const canon = WEAPON_FOR_AMMO[kind];
    if (!this.owned.has(canon) && this.reserve[canon] < WEAPONS[canon].maxReserve) {
      this.reserve[canon] = Math.min(WEAPONS[canon].maxReserve, this.reserve[canon] + amount);
      return true;
    }
    return false;
  }

  select(id: WeaponId): boolean {
    if (!this.owned.has(id) || id === this.current || this.switchingTo) return false;
    this.switchingTo = id;
    this.switchTimer = 0.34;
    this.reloadTimer = 0;
    this.burstLeft = 0;
    this.chargeTimer = 0;
    this.audio.weaponSwitch();
    return true;
  }

  startReload() {
    if (this.reloading || this.switchTimer > 0 || this.chargeTimer > 0) return;
    const d = this.def;
    if (this.mags[this.current] >= d.magSize || this.reserve[this.current] <= 0) return;
    this.reloadTimer = d.reloadTime;
    this.reloadStage = 0;
    this.audio.reload(this.current, 'out');
  }

  setTrigger(held: boolean) {
    if (held && !this.triggerHeld) this.triggerConsumed = false;
    this.triggerHeld = held;
  }

  update(
    dt: number,
    ctx: {
      camera: THREE.Camera;
      eyePos: THREE.Vector3;
      yaw: number;
      pitch: number;
      bobPhase: number;
      bobAmount: number;
      speedFactor: number;
      adsHeld: boolean;
      alive: boolean;
    },
  ) {
    const d = this.def;
    this.cooldown -= dt;
    if (this.pumpTimer > 0) this.pumpTimer -= dt;
    if (this.boltTimer > 0) this.boltTimer -= dt;
    this.spreadBloom = Math.max(0, this.spreadBloom - dt * 3.2);

    // ---- switching
    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0.17 && this.switchingTo) {
        this.models.get(this.current)!.group.visible = false;
        this.current = this.switchingTo;
        this.models.get(this.current)!.group.visible = true;
        this.switchingTo = null;
        this.onAmmoChanged?.();
      }
      if (this.switchTimer < 0) this.switchTimer = 0;
    }

    // ---- reload sequencing
    if (this.reloadTimer > 0) {
      const before = this.reloadTimer;
      this.reloadTimer -= dt;
      const total = d.reloadTime;
      const elapsed = total - this.reloadTimer;
      if (this.reloadStage === 0 && elapsed > total * 0.45) {
        this.reloadStage = 1;
        this.audio.reload(this.current, 'in');
      }
      if (this.reloadStage === 1 && elapsed > total * 0.8) {
        this.reloadStage = 2;
        this.audio.reload(this.current, 'rack');
      }
      if (before > 0 && this.reloadTimer <= 0) {
        const need = d.magSize - this.mags[this.current];
        const take = Math.min(need, this.reserve[this.current]);
        this.mags[this.current] += take;
        this.reserve[this.current] -= take;
        this.onAmmoChanged?.();
      }
    }

    // ---- ADS
    const wantAds = ctx.adsHeld && !this.reloading && this.switchTimer <= 0 && ctx.alive;
    this.adsAmount = lerp(this.adsAmount, wantAds ? 1 : 0, 1 - Math.pow(0.00005, dt));

    // ---- melee swings
    if (d.melee) {
      if (ctx.alive && this.triggerHeld && !this.triggerConsumed && this.cooldown <= 0 && this.swingTimer <= 0 && !this.busy) {
        this.triggerConsumed = true;
        this.swingTimer = d.interval;
        this.swingHitDone = false;
        this.cooldown = d.interval * 0.85;
        this.audio.swing((d.swingAmp ?? 1) >= 1);
        this.hooks.onShotFired(this.current);
      }
      if (this.swingTimer > 0) {
        this.swingTimer -= dt;
        // the edge lands at ~60% through the swing
        if (!this.swingHitDone && this.swingTimer <= d.interval * 0.4) {
          this.swingHitDone = true;
          this.meleeHit(ctx);
        }
        if (this.swingTimer < 0) this.swingTimer = 0;
      }
    }

    // ---- firing
    if (ctx.alive && !this.busy) {
      if (d.melee) {
        // handled above — blades have no trigger group
      } else if (d.mode === 'burst') {
        // M16: one press queues a 3-round burst; rounds then leave on a timer
        if (this.triggerHeld && !this.triggerConsumed && this.cooldown <= 0 && this.burstLeft === 0) {
          this.triggerConsumed = true;
          if (this.mags[this.current] > 0) {
            this.burstLeft = 3;
          } else {
            this.audio.dryFire();
            this.cooldown = 0.3;
            if (this.reserve[this.current] > 0) this.startReload();
          }
        }
        if (this.burstLeft > 0 && this.cooldown <= 0) {
          if (this.mags[this.current] > 0) {
            this.fire(ctx);
            this.burstLeft--;
            // tight intra-burst spacing, deliberate pause after the third round
            this.cooldown = this.burstLeft > 0 ? 0.062 : d.interval;
          } else {
            this.burstLeft = 0;
          }
        }
      } else if (this.triggerHeld && this.cooldown <= 0) {
        if (d.mode === 'semi' && this.triggerConsumed) {
          // semi: wait for re-press
        } else if (this.mags[this.current] > 0) {
          this.triggerConsumed = true;
          if (!this.hooks.canFire(d)) {
            this.cooldown = 0.5;
          } else if (d.chargeTime) {
            // anti-matter: wind up first; the shot leaves when the charge peaks
            this.chargeTimer = d.chargeTime;
            this.audio.chargeHum();
          } else {
            this.fire(ctx);
          }
        } else {
          this.audio.dryFire();
          this.cooldown = 0.3;
          this.triggerConsumed = true;
          if (this.reserve[this.current] > 0) this.startReload();
        }
      }
    }
    if (this.chargeTimer > 0) {
      this.chargeTimer -= dt;
      if (this.chargeTimer <= 0) {
        this.chargeTimer = 0;
        if (ctx.alive && this.mags[this.current] > 0 && this.hooks.canFire(d)) this.fire(ctx);
      }
    }
    if (this.reloadTimer > 0 || this.switchTimer > 0 || d.mode !== 'burst') this.burstLeft = 0;
    if (!this.triggerHeld) this.triggerConsumed = false;

    // ---- viewmodel transform: sway, bob, kick, ads
    const vm = this.models.get(this.current)!;
    const yawVel = (ctx.yaw - this.lastYaw) / Math.max(dt, 0.001);
    const pitchVel = (ctx.pitch - this.lastPitch) / Math.max(dt, 0.001);
    this.lastYaw = ctx.yaw;
    this.lastPitch = ctx.pitch;
    this.swayX = lerp(this.swayX, clamp(-yawVel * 0.012, -0.05, 0.05), 1 - Math.pow(0.0001, dt));
    this.swayY = lerp(this.swayY, clamp(pitchVel * 0.010, -0.04, 0.04), 1 - Math.pow(0.0001, dt));

    const bobX = Math.cos(ctx.bobPhase) * 0.014 * ctx.bobAmount;
    const bobY = -Math.abs(Math.sin(ctx.bobPhase)) * 0.012 * ctx.bobAmount;
    this.kickZ = lerp(this.kickZ, 0, 1 - Math.pow(0.000001, dt));

    const hipPos = new THREE.Vector3(0.24, -0.22, -0.45);
    const adsPos = new THREE.Vector3(vm.adsX ?? 0, vm.adsY, -0.38);
    const pos = hipPos.lerp(adsPos, this.adsAmount);
    // subtle idle breathing so the gun never looks bolted to the screen
    this.idleT += dt;
    const idleK = (1 - clamp(ctx.bobAmount, 0, 1)) * (1 - this.adsAmount * 0.85);
    pos.x += Math.sin(this.idleT * 0.9) * 0.0022 * idleK;
    pos.y += Math.sin(this.idleT * 1.4) * 0.0028 * idleK;
    // reload dip
    let dipY = 0;
    let tiltZ = 0;
    let tiltX = 0;
    if (this.reloading) {
      const total = d.reloadTime;
      const k = 1 - this.reloadTimer / total;
      const curve = Math.sin(Math.min(1, k * 1.15) * Math.PI);
      dipY = -0.16 * curve;
      tiltZ = 0.5 * curve;
      tiltX = 0.25 * curve;
    }
    // switch dip
    if (this.switchTimer > 0) {
      const k = this.switchTimer / 0.34;
      dipY -= Math.sin(k * Math.PI) * 0.3;
      tiltX += Math.sin(k * Math.PI) * 0.4;
    }
    // a scoped rifle sinks out of its own sight picture, so the player looks
    // through the lens instead of at the back of the scope tube
    const scopeSink = d.scoped ? clamp((this.adsAmount - 0.72) / 0.28, 0, 1) : 0;
    this.root.position.set(
      pos.x + this.swayX * (1 - this.adsAmount * 0.8) + bobX * (1 - this.adsAmount),
      pos.y + this.swayY * (1 - this.adsAmount * 0.8) + bobY * (1 - this.adsAmount) + dipY - scopeSink * 0.34,
      pos.z + this.kickZ + scopeSink * 0.1,
    );
    this.root.rotation.set(tiltX + this.kickZ * 1.4, this.swayX * 1.6, tiltZ);

    // ---- melee presentation: distinct swing choreography per blade
    if (d.melee) {
      const amp = d.swingAmp ?? 1;
      if (this.swingTimer > 0) {
        const k = 1 - this.swingTimer / d.interval; // 0 → 1 over the swing
        const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
        const easeInOut = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
        // attack in the first 38%, recover over the rest; lands back at rest
        const sw = (from: number, to: number) =>
          lerp(from, to, easeOut(k / 0.38)) * (1 - easeInOut((k - 0.38) / 0.62));
        if (d.swingStyle === 'chop') {
          // kitchen knife: raised, then a short vertical cleaver chop
          this.root.rotation.x += sw(-0.55, 0.8) * amp;
          this.root.position.y += sw(0.03, -0.07) * amp;
          this.root.position.z += sw(0.02, -0.05) * amp;
        } else if (d.swingStyle === 'draw') {
          // katana: drawn across the body in one wide iaido arc
          this.root.rotation.y += sw(1.2, -1.3) * amp;
          this.root.rotation.z += sw(0.25, -0.4) * amp;
          this.root.position.x += sw(-0.17, 0.07) * amp;
          this.root.rotation.x += sw(-0.1, 0.18) * amp;
        } else {
          // combat knife / machete: fast horizontal slash (machete wider)
          this.root.rotation.y += sw(0.85, -1.05) * amp;
          this.root.rotation.z += sw(0.5, -0.55) * amp;
          this.root.position.x += sw(0.04, -0.06) * amp;
          this.root.position.y += sw(0.01, -0.03) * amp;
        }
      } else {
        // carried low and angled, edge forward
        this.root.rotation.y -= 0.1;
        this.root.rotation.z += 0.07;
        this.root.position.y -= 0.015;
      }
    }

    // ---- moving parts (animated groups are built at origin; offsets here)
    if (vm.slide) {
      // slide/charging handle snaps back while the shot cycles (incl. bursts)
      const cycling = this.burstLeft > 0 || this.cooldown > d.interval - 0.075;
      vm.slide.position.z = cycling ? clamp(this.kickZ * 1.6, 0, 0.055) : 0;
    }
    if (vm.pump) {
      vm.pump.position.z = this.pumpTimer > 0 ? Math.sin((this.pumpTimer / 0.5) * Math.PI) * 0.105 : 0;
    }
    if (vm.mag) {
      const dropTarget = this.reloading && this.reloadStage === 0 ? -0.13 : 0;
      this.magDrop = lerp(this.magDrop, dropTarget, 1 - Math.pow(0.0000001, dt));
      vm.mag.position.y = this.magDrop;
    }
    // revolver: hammer snaps forward on firing, then re-cocks
    if (vm.hammer) {
      const cycling = this.cooldown > d.interval - 0.1;
      const target = cycling ? 0 : 0.62;
      vm.hammer.rotation.x = lerp(vm.hammer.rotation.x, target, 1 - Math.pow(0.0000001, dt));
    }
    // launchers: the warhead sits in the muzzle only while a round is chambered
    if (vm.warhead) {
      vm.warhead.visible = this.mags[this.current] > 0 || (this.reloading && this.reloadStage >= 1);
    }
    // HL-4 seeker screen: red while searching, amber while acquiring, green locked
    if (vm.screenMat) {
      const col = this.lockState === 'locked' ? 0x33ff66 : this.lockState === 'seeking' ? 0xffaa22 : 0xff3322;
      vm.screenMat.emissive.setHex(col);
    }
    // anti-matter: rings orbit the singularity; winding up spins them hard
    if (vm.rings && vm.core) {
      const charging = this.chargeTimer > 0 && d.chargeTime ? 1 - this.chargeTimer / d.chargeTime : 0;
      const recovering = this.cooldown > 0 ? clamp(this.cooldown / d.interval, 0, 1) : 0;
      const spin = 1.4 + charging * 22 - recovering * 1.1;
      this.ringSpin += dt * spin;
      vm.rings.forEach((r, i) => {
        r.rotation.x = this.ringSpin * (i === 0 ? 1 : -0.8) + i;
        r.rotation.y = this.ringSpin * (i === 0 ? 0.6 : 1.1);
      });
      const empty = this.mags[this.current] <= 0 && !this.reloading;
      const pulse = 1 + Math.sin(this.idleT * 5) * 0.06 + charging * 0.5;
      vm.core.scale.setScalar(empty ? 0.25 : pulse * (1 - recovering * 0.6));
      for (const m of vm.glowMats ?? []) m.emissiveIntensity = empty ? 0.25 : 1.2 + charging * 4 - recovering * 0.8;
      // shiver while the charge peaks
      if (charging > 0) this.root.position.x += (Math.random() - 0.5) * 0.004 * charging;
    }
    // sniper: bolt handle lifts, draws back, and slams home after each shot
    if (vm.bolt) {
      const k = this.boltTimer > 0 ? 1 - this.boltTimer / 0.78 : 0;
      const pull = Math.sin(clamp(k, 0, 1) * Math.PI);
      vm.bolt.position.z = -0.02 + pull * 0.075; // -0.02 is the modeled rest position
      vm.bolt.rotation.z = pull * 0.85;
    }
    // revolver: cylinder indexes one chamber per shot and swings out to reload
    if (vm.cylinder) {
      this.cylSpin = lerp(this.cylSpin, this.cylTarget, 1 - Math.pow(0.0000001, dt));
      vm.cylinder.rotation.z = this.cylSpin;
      const k = this.reloading ? clamp((1 - this.reloadTimer / d.reloadTime) * 1.2, 0, 1) : 0;
      const swing = Math.sin(k * Math.PI) * 0.95;
      vm.cylinder.rotation.y = swing;
      vm.cylinder.position.x = swing * 0.055;
    }
  }

  /** One blade arc: probe a small fan of rays, wound the nearest thing in reach. */
  private meleeHit(ctx: { camera: THREE.Camera; eyePos: THREE.Vector3 }) {
    const d = this.def;
    const baseDir = new THREE.Vector3();
    ctx.camera.getWorldDirection(baseDir);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
    const origin = ctx.eyePos.clone();
    let bestTarget: FireResult | null = null;
    let bestWall: FireResult | null = null;
    for (const [ry, rp] of [[0, 0], [-0.16, 0], [0.16, 0], [0, -0.12], [0, 0.12]] as const) {
      const dir = baseDir.clone().addScaledVector(right, ry).addScaledVector(up, rp).normalize();
      const hit = this.hooks.fireRay(origin, dir, d.range);
      if (hit.target) {
        if (!bestTarget || hit.dist < bestTarget.dist) bestTarget = hit;
      } else if (hit.dist < d.range) {
        if (!bestWall || hit.dist < bestWall.dist) bestWall = hit;
      }
    }
    if (bestTarget) {
      const dmg = d.damage * (bestTarget.part === 'head' ? 1.8 : 1);
      const died = bestTarget.target!.applyDamage(dmg, bestTarget.part ?? 'body', bestTarget.point, baseDir);
      this.hooks.onHit(died);
      this.effects.impactFlesh(bestTarget.point);
      this.audio.hitFlesh(bestTarget.point);
      this.hooks.applyRecoil(0.0035, rand(-0.002, 0.002));
    } else if (bestWall) {
      // the edge rings off concrete and steel
      this.effects.impactWall(bestWall.point, bestWall.nx, bestWall.nz);
      this.audio.impactWall(bestWall.point, true);
      this.hooks.applyRecoil(0.002, 0);
    }
  }

  private fire(ctx: { camera: THREE.Camera; eyePos: THREE.Vector3 }) {
    const d = this.def;
    this.mags[this.current]--;
    this.cooldown = d.interval;
    if (this.current === 'magnum') this.cylTarget += Math.PI / 3;
    if (d.pumpAction) {
      this.pumpTimer = 0.5;
      this.audio.pump(0.32);
    }
    if (d.boltAction) this.boltTimer = 0.78;
    this.audio.shot(this.current);
    this.hooks.onShotFired(this.current);

    const vm = this.models.get(this.current)!;
    const muzzleWorld = new THREE.Vector3();
    vm.muzzle.getWorldPosition(muzzleWorld);
    this.effects.muzzle(muzzleWorld);

    // ---- launchers: physical projectile from the real muzzle, steered so it
    // lands where the crosshair points (aim ray from the eye, then muzzle→aim)
    if (d.projectile) {
      const camDir = new THREE.Vector3();
      ctx.camera.getWorldDirection(camDir);
      const aim = this.hooks.fireRay(ctx.eyePos.clone(), camDir.clone(), d.range);
      const dir = aim.point.clone().sub(muzzleWorld);
      if (aim.dist < 2.5 || dir.lengthSq() < 0.01) dir.copy(camDir);
      dir.normalize();
      this.hooks.launch(d.projectile, muzzleWorld.clone(), dir);
      const adsScaleL = 1 - this.adsAmount * 0.3;
      this.hooks.applyRecoil(d.recoilPitch * adsScaleL, d.recoilYaw * rand(-1, 1) * adsScaleL);
      this.kickZ = Math.min(0.2, this.kickZ + d.kick);
      this.onAmmoChanged?.();
      if (this.mags[this.current] === 0 && this.reserve[this.current] > 0) {
        window.setTimeout(() => { if (this.mags[this.current] === 0) this.startReload(); }, 450);
      }
      return;
    }

    // casing eject
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(ctx.camera.quaternion);
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ctx.camera.quaternion);
    this.effects.ejectCasing(muzzleWorld.clone().addScaledVector(camRight, -0.05), camRight, camUp);

    // recoil
    const adsScale = 1 - this.adsAmount * 0.35;
    this.hooks.applyRecoil(
      d.recoilPitch * adsScale * rand(0.9, 1.1),
      d.recoilYaw * rand(-1, 1) * adsScale,
    );
    this.kickZ = Math.min(0.16, this.kickZ + d.kick);
    this.spreadBloom = Math.min(1, this.spreadBloom + (d.mode === 'auto' ? 0.16 : 0.3));

    const spread = lerp(d.spreadHip, d.spreadAds, this.adsAmount) * (1 + this.spreadBloom * 0.9);
    const baseDir = new THREE.Vector3();
    ctx.camera.getWorldDirection(baseDir);
    const origin = ctx.eyePos.clone();

    for (let p = 0; p < d.pellets; p++) {
      const dir = baseDir.clone();
      dir.x += rand(-spread, spread);
      dir.y += rand(-spread, spread);
      dir.z += rand(-spread, spread);
      dir.normalize();
      const hit = this.hooks.fireRay(origin, dir, d.range);
      // tracer from muzzle toward hit point (skip very close hits)
      if (hit.dist > 2.2) this.effects.tracer(muzzleWorld, hit.point);
      if (hit.target) {
        let dmg = d.damage * (hit.part === 'head' ? 2.1 : 1);
        // distance falloff (the sniper keeps almost all of its sting)
        const fallMin = d.falloffMin ?? 0.55;
        if (hit.dist > 20) dmg *= lerp(1, fallMin, clamp((hit.dist - 20) / 30, 0, 1));
        const died = hit.target.applyDamage(dmg, hit.part ?? 'body', hit.point, dir);
        this.hooks.onHit(died);
        this.effects.impactFlesh(hit.point);
        this.audio.hitFlesh(hit.point);
      } else if (hit.dist < d.range) {
        if (hit.point.y <= 0.06) {
          // rounds that chew the floor leave a mark
          this.effects.groundHole(hit.point);
          this.audio.impactWall(hit.point, false);
        } else {
          this.effects.impactWall(hit.point, hit.nx, hit.nz);
        }
      }
    }
    this.onAmmoChanged?.();

    // auto reload prompt when empty
    if (this.mags[this.current] === 0 && this.reserve[this.current] > 0) {
      window.setTimeout(() => { if (this.mags[this.current] === 0) this.startReload(); }, 350);
    }
  }

  serialize(): { owned: WeaponId[]; current: WeaponId; mags: Record<WeaponId, number>; reserve: Record<WeaponId, number> } {
    return {
      owned: [...this.owned],
      current: this.current,
      mags: { ...this.mags },
      reserve: { ...this.reserve },
    };
  }

  restore(data: { owned: WeaponId[]; current: WeaponId; mags: Partial<Record<WeaponId, number>>; reserve: Partial<Record<WeaponId, number>> }) {
    this.owned = new Set(data.owned.length ? data.owned : ['pistol']);
    (Object.keys(this.mags) as WeaponId[]).forEach((k) => {
      this.mags[k] = data.mags[k] ?? this.mags[k];
      this.reserve[k] = data.reserve[k] ?? this.reserve[k];
    });
    // update visible model
    this.models.forEach((m, id) => (m.group.visible = id === data.current));
    this.current = data.current;
    if (!this.owned.has(this.current)) this.current = 'pistol';
    this.models.forEach((m, id) => (m.group.visible = id === this.current));
    this.onAmmoChanged?.();
  }
}
