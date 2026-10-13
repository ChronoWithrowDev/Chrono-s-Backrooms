import * as THREE from 'three';
import { EnemyKind, clamp, lerp, angleLerp, rand, dist2D } from './types';
import type { World, EnemySpawn } from './world';
import type { AudioEngine, EnemyVoice, EnemyVoiceKind } from './audio';
import type { Effects } from './effects';

export type EnemyState =
  | 'patrol' | 'investigate' | 'chase' | 'search' | 'attack'
  | 'stunned' | 'passive' | 'vanish' | 'dead' | 'gone';

export interface EnemyContext {
  dt: number;
  playerPos: THREE.Vector3; // feet
  playerEye: THREE.Vector3;
  playerNoise: number; // current hearing radius emitted by player
  playerCrouching: boolean;
  /** Player is up in the ducts: room entities can neither see nor reach them. */
  playerHidden?: boolean;
  world: World;
  effects: Effects;
  audio: AudioEngine;
  damagePlayer: (amount: number, fromPos: THREE.Vector3) => void;
  onDeath: (e: Enemy) => void;
  onWatcherVanish: (e: Enemy) => void;
  onHeavySlam: (pos: THREE.Vector3) => void;
  isLookedAt: (e: Enemy) => boolean;
}

interface Stats {
  health: number;
  patrolSpeed: number;
  chaseSpeed: number;
  attackRange: number;
  damage: number;
  attackCooldown: number;
  radius: number;
  eyeHeight: number;
  sightRange: number;
}

const STATS: Record<EnemyKind, Stats> = {
  stalker: { health: 110, patrolSpeed: 1.7, chaseSpeed: 4.55, attackRange: 2.1, damage: 16, attackCooldown: 1.25, radius: 0.42, eyeHeight: 2.35, sightRange: 30 },
  runner: { health: 55, patrolSpeed: 2.3, chaseSpeed: 6.15, attackRange: 2.3, damage: 11, attackCooldown: 0.95, radius: 0.4, eyeHeight: 1.15, sightRange: 27 },
  watcher: { health: 70, patrolSpeed: 0, chaseSpeed: 5.7, attackRange: 2.1, damage: 22, attackCooldown: 1.3, radius: 0.4, eyeHeight: 2.0, sightRange: 34 },
  heavy: { health: 460, patrolSpeed: 1.25, chaseSpeed: 2.65, attackRange: 2.7, damage: 30, attackCooldown: 1.7, radius: 0.66, eyeHeight: 2.2, sightRange: 27 },
  // The Nest Guardian: a territorial brute. Very hard to kill, but killable —
  // and it guards the only way deeper.
  guardian: { health: 950, patrolSpeed: 1.35, chaseSpeed: 3.1, attackRange: 3.1, damage: 38, attackCooldown: 1.9, radius: 0.82, eyeHeight: 2.35, sightRange: 30 },
};

interface ModelParts {
  group: THREE.Group;
  head: THREE.Object3D;
  torso: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  mats: THREE.MeshStandardMaterial[];
  jaw?: THREE.Object3D;
  baseY: number;
}

function mat(color: number, rough = 0.75, emissive = 0x000000, ei = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05, emissive, emissiveIntensity: ei });
  m.userData.baseEmissive = emissive;
  m.userData.baseEI = ei;
  return m;
}

function limb(matInst: THREE.Material, w: number, h: number, d: number): THREE.Group {
  // pivot at top of limb
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matInst);
  m.position.y = -h / 2;
  m.castShadow = true;
  g.add(m);
  return g;
}

/** Detail-mesh shorthand for the creature builders below. */
function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
  x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** A bone/keratin spike (cone, apex +Y before rotation). */
function spike(parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number,
  len = 0.2, r = 0.028, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  return part(parent, new THREE.ConeGeometry(r, len, 6), mat, x, y, z, rx, ry, rz);
}

/** Splayed talon fingers at the end of a hanging arm (arm-local, hangs -Y). */
function claws(parent: THREE.Object3D, mat: THREE.Material, y: number, len = 0.26, spread = 0.045, count = 4) {
  part(parent, new THREE.BoxGeometry(0.075, 0.1, 0.06), mat, 0, y + 0.03, 0);
  for (let i = 0; i < count; i++) {
    const c = spike(parent, mat, (i - (count - 1) / 2) * spread, y - len / 2, 0.012, len, 0.011);
    c.rotation.x = Math.PI; // apex down
    c.rotation.z = (i - (count - 1) / 2) * 0.16;
  }
}

/** Exposed ribs curving around the front (-Z) of a torso. */
function ribcage(parent: THREE.Object3D, mat: THREE.Material, y0: number, z: number, r: number, n = 3, step = 0.11, tube = 0.014) {
  for (let i = 0; i < n; i++) {
    const rib = part(parent, new THREE.TorusGeometry(r - i * 0.014, tube, 6, 16, Math.PI), mat, 0, y0 - i * step, z);
    rib.rotation.x = -Math.PI / 2; // bulge toward the front (-Z)
  }
}

/** A row of small teeth along X. flip=true points them up (lower jaw). */
function teeth(parent: THREE.Object3D, mat: THREE.Material, y: number, z: number, n: number, w: number, len = 0.035, flip = false) {
  for (let i = 0; i < n; i++) {
    const t = spike(parent, mat, (i - (n - 1) / 2) * (w / Math.max(1, n - 1)), y, z, len, 0.008);
    if (!flip) t.rotation.x = Math.PI;
  }
}

function buildModel(kind: EnemyKind): ModelParts {
  const group = new THREE.Group();
  const mats: THREE.MeshStandardMaterial[] = [];
  const M = (m: THREE.MeshStandardMaterial) => { mats.push(m); return m; };
  let head: THREE.Object3D;
  let torso: THREE.Object3D;
  let armL: THREE.Object3D, armR: THREE.Object3D, legL: THREE.Object3D, legR: THREE.Object3D;
  let jaw: THREE.Object3D | undefined;
  let baseY = 0;

  if (kind === 'stalker') {
    // A suit that outlived its owner: burst ribs, a neck that keeps growing,
    // fingers like knitting needles. The face looks down -Z (travel).
    const suit = M(mat(0x17171a, 0.85));
    const skin = M(mat(0xb8b09a, 0.6));
    const bone = M(mat(0xcfc4a8, 0.55));
    const gore = M(mat(0x3d0f0c, 0.7));
    legL = limb(suit, 0.13, 1.15, 0.15); legL.position.set(-0.14, 1.15, 0);
    legR = limb(suit, 0.13, 1.15, 0.15); legR.position.set(0.14, 1.15, 0);
    for (const leg of [legL, legR]) {
      part(leg, new THREE.BoxGeometry(0.1, 0.5, 0.02), bone, 0, -0.82, -0.085); // shin plate
      part(leg, new THREE.BoxGeometry(0.09, 0.05, 0.26), suit, 0, -1.12, -0.06); // too-long shoe
    }
    torso = new THREE.Group(); torso.position.y = 1.15;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.95, 0.27), suit);
    chest.position.y = 0.48; chest.castShadow = true;
    torso.add(chest);
    torso.rotation.x = 0.13;
    // burst-open chest: pale ribs over a dark hollow, shirt torn to a V
    part(torso, new THREE.BoxGeometry(0.34, 0.5, 0.02), gore, 0, 0.48, -0.135);
    ribcage(torso, bone, 0.66, -0.15, 0.2, 3, 0.12, 0.016);
    part(torso, new THREE.BoxGeometry(0.2, 0.3, 0.015), M(mat(0x9a917c, 0.8)), 0, 0.78, -0.14, 0, 0, 0.12);
    for (let i = 0; i < 4; i++) part(torso, new THREE.BoxGeometry(0.05, 0.07, 0.03), bone, 0, 0.75 - i * 0.16, 0.15); // spine knobs
    for (const sx of [-1, 1]) {
      const pad = part(torso, new THREE.SphereGeometry(0.11, 8, 8), suit, sx * 0.3, 0.88, 0);
      pad.scale.set(1, 0.7, 1);
    }
    armL = limb(suit, 0.09, 1.3, 0.11); armL.position.set(-0.33, 0.88, 0);
    armR = limb(suit, 0.09, 1.42, 0.11); armR.position.set(0.33, 0.88, 0); // the right one grew longer
    for (const [arm, len] of [[armL, 1.3], [armR, 1.42]] as const) {
      part(arm, new THREE.SphereGeometry(0.055, 8, 8), skin, 0, -len * 0.55, 0); // elbow knot
      claws(arm, skin, -len - 0.05, 0.3, 0.045);
    }
    torso.add(armL, armR);
    // a neck of stacked, slipping vertebrae
    for (let i = 0; i < 3; i++) {
      const v = part(torso, new THREE.CylinderGeometry(0.052 - i * 0.006, 0.058 - i * 0.006, 0.09, 8), skin, 0, 1.0 + i * 0.075, 0.02 - i * 0.008);
      v.rotation.x = 0.12 + i * 0.05;
    }
    head = new THREE.Group(); head.position.set(0, 1.13, 0.0);
    head.rotation.z = 0.1; // the permanent tilt of something listening
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 12), skin);
    skull.scale.set(0.85, 1.5, 0.9);
    skull.castShadow = true;
    head.add(skull);
    part(head, new THREE.BoxGeometry(0.018, 0.08, 0.26), bone, 0, 0.2, 0.02); // sagittal crest
    part(head, new THREE.BoxGeometry(0.17, 0.03, 0.03), skin, 0, 0.11, -0.11); // brow ridge
    const socket = M(mat(0x030303, 0.5));
    part(head, new THREE.SphereGeometry(0.034, 8, 8), socket, -0.05, 0.06, -0.115);
    part(head, new THREE.SphereGeometry(0.034, 8, 8), socket, 0.05, 0.06, -0.115);
    const eyeMat = M(mat(0x1a0505, 0.4, 0xff2a1a, 2.2));
    part(head, new THREE.SphereGeometry(0.015, 6, 6), eyeMat, -0.05, 0.06, -0.138);
    part(head, new THREE.SphereGeometry(0.015, 6, 6), eyeMat, 0.05, 0.06, -0.138);
    // a mouth that was sewn shut, then wasn't
    part(head, new THREE.BoxGeometry(0.1, 0.014, 0.01), socket, 0, -0.05, -0.128);
    teeth(head, bone, -0.062, -0.13, 5, 0.07, 0.03);
    torso.add(head);
    group.add(legL, legR, torso);
  } else if (kind === 'runner') {
    // All elbows and appetite: a ribcage with legs, built to run things down.
    const flesh = M(mat(0x5c564c, 0.7));
    const dark = M(mat(0x23211c, 0.9));
    const bone = M(mat(0xb8ab90, 0.55));
    const gore = M(mat(0x40120d, 0.75));
    legL = limb(dark, 0.14, 0.62, 0.16); legL.position.set(-0.15, 0.62, 0);
    legR = limb(dark, 0.14, 0.62, 0.16); legR.position.set(0.15, 0.62, 0);
    legL.rotation.x = 0.5; legR.rotation.x = -0.4;
    for (const leg of [legL, legR]) {
      for (let i = 0; i < 3; i++) spike(leg, bone, (i - 1) * 0.045, -0.64, -0.05, 0.09, 0.012, Math.PI + 0.5);
    }
    torso = new THREE.Group(); torso.position.y = 0.62;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.26), flesh);
    chest.position.y = 0.4; chest.castShadow = true;
    torso.add(chest);
    torso.rotation.x = 0.78; // hunched quadruped stance
    part(torso, new THREE.BoxGeometry(0.3, 0.6, 0.02), gore, 0, 0.4, -0.135);
    ribcage(torso, bone, 0.58, -0.145, 0.19, 3, 0.13, 0.015);
    for (let i = 0; i < 4; i++) spike(torso, bone, 0, 0.72 - i * 0.14, 0.15, 0.13 - i * 0.015, 0.02, -0.5); // dorsal spines
    // a tail that never learned when to stop growing
    for (let i = 0; i < 3; i++) {
      const seg = spike(torso, dark, 0, 0.12 - i * 0.05, 0.22 + i * 0.15, 0.3, 0.04 - i * 0.008);
      seg.rotation.x = Math.PI / 2 + 0.4 + i * 0.15;
    }
    armL = limb(flesh, 0.1, 0.95, 0.12); armL.position.set(-0.32, 0.72, 0);
    armR = limb(flesh, 0.1, 0.95, 0.12); armR.position.set(0.32, 0.72, 0);
    claws(armL, bone, -1.0, 0.16, 0.04, 3);
    claws(armR, bone, -1.0, 0.16, 0.04, 3);
    torso.add(armL, armR);
    head = new THREE.Group(); head.position.set(0, 0.82, 0.1);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), flesh);
    skull.scale.set(0.9, 1.1, 1.25);
    skull.castShadow = true;
    head.add(skull);
    part(head, new THREE.BoxGeometry(0.15, 0.09, 0.22), flesh, 0, -0.02, -0.16); // snout
    jaw = new THREE.Group(); jaw.position.set(0, -0.07, -0.04);
    part(jaw, new THREE.BoxGeometry(0.13, 0.045, 0.24), flesh, 0, -0.02, -0.08);
    teeth(jaw, bone, 0.005, -0.16, 4, 0.09, 0.04, true); // lower fangs
    head.add(jaw);
    teeth(head, bone, -0.075, -0.2, 5, 0.1, 0.045); // uppers overhanging the bite
    const eyeMat = M(mat(0x0a0a0a, 0.4, 0xff7722, 1.8));
    part(head, new THREE.SphereGeometry(0.02, 6, 6), eyeMat, -0.06, 0.05, -0.17);
    part(head, new THREE.SphereGeometry(0.02, 6, 6), eyeMat, 0.06, 0.05, -0.17);
    for (const sx of [-1, 1]) spike(head, dark, sx * 0.09, 0.16, 0.02, 0.09, 0.016, -0.3, 0, sx * 0.4); // ear spikes
    torso.add(head);
    group.add(legL, legR, torso);
  } else if (kind === 'watcher') {
    // It does not walk. It attends. Layered burial cloth, fingers like
    // bookmarks, ribs pressing through, and a face that is mostly holes.
    const robe = M(mat(0x0a0a10, 0.5));
    const robe2 = M(mat(0x12121c, 0.55));
    const skin = M(mat(0xd6d0c0, 0.55));
    const bone = M(mat(0x8f887a, 0.6));
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.52, 1.9, 10), robe);
    cone.position.y = 0.95;
    cone.castShadow = true;
    group.add(cone);
    const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.4, 1.25, 10), robe2);
    shroud.position.y = 1.28;
    group.add(shroud);
    ribcage(group, bone, 1.18, -0.04, 0.3, 2, 0.14, 0.013); // pressing through the cloth
    // torn hem, worrying at the floor
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const hem = spike(group, robe, Math.cos(a) * 0.44, 0.06, Math.sin(a) * 0.44, 0.3, 0.05);
      hem.rotation.x = Math.PI + Math.sin(a) * 0.25;
      hem.rotation.z = Math.cos(a) * 0.25;
    }
    torso = new THREE.Group(); torso.position.y = 1.55;
    armL = limb(robe, 0.07, 1.0, 0.09); armL.position.set(-0.3, 0.28, 0);
    armR = limb(robe, 0.07, 1.0, 0.09); armR.position.set(0.3, 0.28, 0);
    claws(armL, skin, -1.04, 0.34, 0.032);
    claws(armR, skin, -1.04, 0.34, 0.032);
    torso.add(armL, armR);
    part(torso, new THREE.CylinderGeometry(0.032, 0.042, 0.24, 8), skin, 0, 0.36, 0); // long thin neck
    head = new THREE.Group(); head.position.set(0, 0.48, 0);
    head.rotation.z = 0.07;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), skin);
    skull.scale.set(0.82, 1.65, 0.9);
    skull.castShadow = true;
    head.add(skull);
    const hole = M(mat(0x020204, 0.4));
    part(head, new THREE.SphereGeometry(0.03, 8, 8), hole, -0.048, 0.05, -0.112);
    part(head, new THREE.SphereGeometry(0.03, 8, 8), hole, 0.048, 0.05, -0.112);
    const eyeMat = M(mat(0xffffff, 0.3, 0xffffff, 3.4));
    part(head, new THREE.SphereGeometry(0.012, 6, 6), eyeMat, -0.048, 0.05, -0.132);
    part(head, new THREE.SphereGeometry(0.012, 6, 6), eyeMat, 0.048, 0.05, -0.132);
    part(head, new THREE.SphereGeometry(0.009, 6, 6), eyeMat, 0, 0.17, -0.1); // the third, patient eye
    part(head, new THREE.BoxGeometry(0.011, 0.055, 0.01), hole, 0, -0.07, -0.122); // mouth slit
    // a broken halo of black splines behind the skull
    for (let i = 0; i < 5; i++) {
      const s = spike(head, hole, (i - 2) * 0.055, 0.16, 0.1, 0.2, 0.008);
      s.rotation.x = -0.5;
      s.rotation.z = (i - 2) * 0.3;
    }
    torso.add(head);
    group.add(torso);
    legL = new THREE.Group(); legR = new THREE.Group(); // floats — no legs
    baseY = 0.35;
  } else if (kind === 'guardian') {
    // The Nest Guardian: a knuckle-dragging brute grown wrong for the ducts.
    // Its chest never closed — ribs cage a heart that burns where you can see it.
    const hide = M(mat(0x4d4238, 0.85));
    const plate = M(mat(0x8f8474, 0.6));
    const dark = M(mat(0x1e1a16, 0.95));
    const bone = M(mat(0xcabfa4, 0.55));
    legL = limb(dark, 0.3, 0.62, 0.34); legL.position.set(-0.34, 0.62, 0);
    legR = limb(dark, 0.3, 0.62, 0.34); legR.position.set(0.34, 0.62, 0);
    for (const leg of [legL, legR]) {
      for (let i = 0; i < 3; i++) spike(leg, bone, (i - 1) * 0.09, -0.64, -0.1, 0.14, 0.022, Math.PI + 0.4);
    }
    torso = new THREE.Group(); torso.position.y = 0.62;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.35, 1.1, 0.72), hide);
    chest.position.y = 0.55; chest.castShadow = true;
    torso.add(chest);
    // the open chest: ribs, and the heart behind them
    const heart = part(torso, new THREE.SphereGeometry(0.13, 10, 10), M(mat(0xff5a1a, 0.4, 0xff4400, 2.6)), 0, 0.55, -0.3);
    heart.scale.set(1, 1.25, 0.8);
    ribcage(torso, bone, 0.82, -0.38, 0.52, 3, 0.17, 0.032);
    part(torso, new THREE.BoxGeometry(0.9, 0.3, 0.05), dark, 0, 0.08, -0.34); // belly plate
    const pauldronL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.6), plate);
    pauldronL.position.set(-0.83, 1.02, 0); pauldronL.castShadow = true;
    const pauldronR = pauldronL.clone(); pauldronR.position.x = 0.83;
    torso.add(pauldronL, pauldronR);
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      spike(torso, plate, sx * 0.83 + (i - 1) * 0.13, 1.24, 0, 0.22, 0.035);
    }
    // dorsal plates marching down the spine
    for (let i = 0; i < 5; i++) {
      const sp = spike(torso, plate, 0, 1.06 - i * 0.12, 0.32 - i * 0.03, 0.34 - i * 0.03, 0.09 - i * 0.008);
      sp.rotation.x = -0.5;
    }
    armL = limb(hide, 0.24, 1.55, 0.28); armL.position.set(-0.88, 0.98, 0);
    armR = limb(hide, 0.24, 1.55, 0.28); armR.position.set(0.88, 0.98, 0);
    for (const [arm, sx] of [[armL, -1], [armR, 1]] as const) {
      spike(arm, bone, sx * 0.14, -0.8, 0, 0.2, 0.03, 0, 0, sx * 1.2); // elbow spur
      const fist = part(arm, new THREE.BoxGeometry(0.26, 0.22, 0.3), plate, 0, -1.62, 0);
      void fist;
      for (let i = 0; i < 4; i++) spike(arm, bone, (i - 1.5) * 0.06, -1.78, -0.06, 0.15, 0.02, Math.PI);
    }
    torso.add(armL, armR);
    part(torso, new THREE.CylinderGeometry(0.15, 0.19, 0.2, 8), hide, 0, 1.16, 0.04); // bull neck
    head = new THREE.Group(); head.position.set(0, 1.34, 0.06);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 12), plate);
    skull.scale.set(1.05, 0.8, 1.1);
    skull.castShadow = true;
    head.add(skull);
    part(head, new THREE.BoxGeometry(0.34, 0.07, 0.06), plate, 0, 0.09, -0.15); // brow shelf
    jaw = new THREE.Group(); jaw.position.set(0, -0.1, -0.02);
    part(jaw, new THREE.BoxGeometry(0.24, 0.09, 0.2), hide, 0, -0.03, -0.04);
    teeth(jaw, bone, 0.02, -0.11, 4, 0.14, 0.05, true);
    head.add(jaw);
    for (const sx of [-1, 1]) spike(head, bone, sx * 0.09, -0.06, -0.13, 0.13, 0.02); // tusks
    for (const sx of [-1, 1]) {
      const horn = spike(head, plate, sx * 0.14, 0.14, 0.04, 0.3, 0.035);
      horn.rotation.z = sx * -0.7;
      horn.rotation.x = -0.45;
    }
    const eyeMat = M(mat(0x140a04, 0.4, 0xff8822, 2.6));
    part(head, new THREE.SphereGeometry(0.024, 6, 6), eyeMat, -0.075, 0.02, -0.16);
    part(head, new THREE.SphereGeometry(0.024, 6, 6), eyeMat, 0.075, 0.02, -0.16);
    torso.add(head);
    group.add(legL, legR, torso);
  } else {
    // heavy — a maintenance rig that decided the maintenance was people:
    // layered blast plate, exhaust stacks, a furnace behind cage bars.
    const armor = M(mat(0x2a2721, 0.6, 0x1a0500, 0.4));
    const plate = M(mat(0x3d4340, 0.5));
    const cloth = M(mat(0x1c1a16, 0.9));
    const rust = M(mat(0x5a3a26, 0.7));
    legL = limb(cloth, 0.24, 0.85, 0.28); legL.position.set(-0.26, 0.85, 0);
    legR = limb(cloth, 0.24, 0.85, 0.28); legR.position.set(0.26, 0.85, 0);
    for (const leg of [legL, legR]) {
      part(leg, new THREE.BoxGeometry(0.26, 0.2, 0.05), plate, 0, -0.45, -0.15); // knee plate
      part(leg, new THREE.BoxGeometry(0.24, 0.09, 0.36), armor, 0, -0.82, -0.04); // boot
    }
    torso = new THREE.Group(); torso.position.y = 0.85;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 0.55), armor);
    chest.position.y = 0.55; chest.castShadow = true;
    torso.add(chest);
    // overlapping blast plates, riveted and rust-streaked
    part(torso, new THREE.BoxGeometry(0.86, 0.5, 0.05), plate, 0, 0.72, -0.29, 0.04);
    part(torso, new THREE.BoxGeometry(0.8, 0.42, 0.05), plate, 0, 0.3, -0.3, -0.03);
    for (const rx of [-0.38, 0.38]) for (const ry of [0.9, 0.55, 0.15]) {
      part(torso, new THREE.SphereGeometry(0.02, 6, 6), rust, rx, ry, -0.32);
    }
    part(torso, new THREE.BoxGeometry(0.7, 0.22, 0.04), rust, 0, 0.06, -0.29); // rust belly band
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10), M(mat(0xff4400, 0.4, 0xff3300, 2.4)));
    core.position.set(0, 0.52, -0.31);
    torso.add(core);
    part(torso, new THREE.BoxGeometry(0.03, 0.3, 0.02), plate, -0.06, 0.52, -0.36); // core cage
    part(torso, new THREE.BoxGeometry(0.03, 0.3, 0.02), plate, 0.06, 0.52, -0.36);
    part(torso, new THREE.BoxGeometry(0.24, 0.03, 0.02), plate, 0, 0.52, -0.36);
    // exhaust stacks coughing heat behind the shoulders
    for (const sx of [-1, 1]) {
      part(torso, new THREE.CylinderGeometry(0.045, 0.055, 0.5, 8), plate, sx * 0.32, 1.12, 0.22);
      part(torso, new THREE.SphereGeometry(0.032, 8, 8), M(mat(0xff6a22, 0.4, 0xff5a14, 1.8)), sx * 0.32, 1.38, 0.22);
    }
    // a cable looped where a neck chain used to be
    const cable = part(torso, new THREE.TorusGeometry(0.17, 0.02, 6, 14, Math.PI), rust, 0, 1.06, 0.1);
    cable.rotation.x = 0.4;
    const padL = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.5), armor);
    padL.position.set(-0.62, 1.0, 0); padL.castShadow = true;
    const padR = padL.clone(); padR.position.x = 0.62;
    torso.add(padL, padR);
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      spike(torso, plate, sx * 0.62 + (i - 1) * 0.12, 1.2, 0, 0.16, 0.025);
    }
    armL = limb(armor, 0.2, 1.05, 0.22); armL.position.set(-0.66, 0.95, 0);
    armR = limb(armor, 0.2, 1.05, 0.22); armR.position.set(0.66, 0.95, 0);
    for (const arm of [armL, armR]) {
      part(arm, new THREE.BoxGeometry(0.24, 0.18, 0.26), plate, 0, -1.08, 0); // fist block
      for (let i = 0; i < 3; i++) spike(arm, plate, (i - 1) * 0.07, -1.2, -0.06, 0.1, 0.018, Math.PI);
    }
    torso.add(armL, armR);
    head = new THREE.Group(); head.position.set(0, 1.18, 0.02);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 12), M(mat(0x8f887a, 0.65)));
    skull.scale.set(1, 0.95, 1);
    skull.castShadow = true;
    head.add(skull);
    part(head, new THREE.BoxGeometry(0.22, 0.2, 0.05), plate, 0, -0.01, -0.15); // face plate
    part(head, new THREE.BoxGeometry(0.24, 0.05, 0.06), plate, 0, 0.13, -0.13); // helmet brow
    const eyeMat = M(mat(0x110b06, 0.4, 0xffaa22, 2.2));
    part(head, new THREE.SphereGeometry(0.019, 6, 6), eyeMat, -0.055, 0.03, -0.175);
    part(head, new THREE.SphereGeometry(0.019, 6, 6), eyeMat, 0.055, 0.03, -0.175);
    for (let i = 0; i < 3; i++) part(head, new THREE.BoxGeometry(0.016, 0.09, 0.02), M(mat(0x0c0c0e, 0.6)), (i - 1) * 0.045, -0.12, -0.165); // jaw grille
    for (const sx of [-1, 1]) part(head, new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), plate, sx * 0.17, -0.02, 0, 0, 0, Math.PI / 2); // ear vents
    torso.add(head);
    group.add(legL, legR, torso);
  }

  return { group, head: head!, torso: torso!, armL: armL!, armR: armR!, legL: legL!, legR: legR!, mats, baseY, jaw };
}

let NEXT_ID = 1;

export class Enemy {
  id = NEXT_ID++;
  kind: EnemyKind;
  stats: Stats;
  pos: THREE.Vector3;
  yaw = 0;
  health: number;
  state: EnemyState;
  scripted: boolean;
  group: THREE.Group;
  private model: ModelParts;
  private voice: EnemyVoice | null = null;

  alert = 0;
  lastKnown = new THREE.Vector3();
  private hasLastKnown = false;
  private path: THREE.Vector3[] = [];
  private pathIdx = 0;
  private repathTimer = 0;
  private perceptTimer = 0;
  private searchTimer = 0;
  private waitTimer = 0;
  private patrolIdx = 0;
  private patrolPoints: THREE.Vector3[];
  private attackTimer = 0;
  private attackWindup = -1;
  private flashTimer = 0;
  private stunTimer = 0;
  private deathTimer = 0;
  private walkPhase = 0;
  private speedActual = 0;
  private knockback = new THREE.Vector3();
  private gazeTimer = 0;
  private vanishCooldown = 0;
  private chargeState: 'none' | 'telegraph' | 'charging' | 'recover' = 'none';
  private chargeTimer = 0;
  private chargeDir = new THREE.Vector3();
  private chargeCooldown = 0;
  private stepAccum = 0;
  private dead = false;
  deathNotified = false;
  private canSeePlayer = false;
  private timeSinceSeen = 99;

  constructor(spawn: EnemySpawn, audio: AudioEngine) {
    this.kind = spawn.kind;
    this.stats = STATS[spawn.kind];
    this.pos = spawn.pos.clone();
    this.health = this.stats.health;
    this.patrolPoints = spawn.patrol.length ? spawn.patrol : [spawn.pos.clone()];
    this.scripted = !!spawn.scripted;
    this.state = spawn.kind === 'watcher' ? 'passive' : 'patrol';
    this.model = buildModel(spawn.kind);
    this.group = this.model.group;
    this.group.position.copy(this.pos).setY(this.model.baseY);
    this.yaw = rand(0, Math.PI * 2);
    this.voice = audio.enemyVoice(spawn.kind === 'guardian' ? 'heavy' : spawn.kind);
    this.home = spawn.pos.clone();
    this.repathTimer = rand(0, 0.4);
  }

  /** The Guardian borrows the Heavy's voice (and its ground-shaking register). */
  private get voiceKind(): EnemyVoiceKind {
    return this.kind === 'guardian' ? 'heavy' : this.kind;
  }

  /** Where this entity spawned (the Guardian's nest centre). */
  home: THREE.Vector3;

  /** Bosses barely budge in the anti-matter well. */
  get anomalyResist(): number {
    return this.kind === 'guardian' ? 0.85 : this.kind === 'heavy' ? 0.55 : 0;
  }

  /**
   * Drag toward a singularity. Movement goes through world.collide, so the
   * pull can never drag a body through a wall; speed is capped for stability.
   */
  pullToward(center: THREE.Vector3, strength: number, dt: number, world: World) {
    if (this.dead || this.state === 'gone') return;
    const to = center.clone().sub(this.pos).setY(0);
    const d = to.length();
    if (d < 0.25) return;
    const speed = Math.min(5.5, strength) * (1 - this.anomalyResist);
    this.pos.addScaledVector(to.normalize(), Math.min(d, speed * dt));
    world.collide(this.pos, this.stats.radius, true);
    this.stunTimer = Math.max(this.stunTimer, 0.15 * (1 - this.anomalyResist));
  }

  /** DamageTarget plumbing (room entities and vent creatures share it). */
  get radius() { return this.stats.radius; }
  get eyeHeight() { return this.stats.eyeHeight; }

  get alive() { return !this.dead && this.state !== 'gone'; }
  get isDead() { return this.dead; }
  get chasing() { return this.state === 'chase' || this.state === 'attack'; }
  get eyePos(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.stats.eyeHeight, this.pos.z);
  }

  /** weapons.ts FireResult target interface */
  applyDamage(amount: number, _part: 'head' | 'body', point: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (this.dead || this.state === 'gone') return true;
    void point; void _part;
    this.health -= amount;
    this.flashTimer = 0.09;
    if (this.kind !== 'heavy') {
      this.knockback.addScaledVector(dir, clamp(amount * 0.03, 0.2, 1.4));
    }
    if (this.kind === 'watcher' && this.state === 'passive') {
      this.becomeHostile();
    } else if (this.state !== 'chase') {
      this.alert = 1;
      this.hasLastKnown = true;
      this.lastKnown.copy(this.pos); // will snap to player via perception next tick
      this.state = 'chase';
      this.repathTimer = 0;
    }
    if (amount >= 42 && this.kind !== 'heavy') this.stunTimer = Math.max(this.stunTimer, 0.32);
    if (this.health <= 0 && !this.dead) {
      this.dead = true;
      this.state = 'dead';
      this.deathTimer = 0;
      return true;
    }
    return false;
  }

  private becomeHostile() {
    if (this.scripted) return;
    this.state = 'chase';
    this.alert = 1;
  }

  hearNoise(pos: THREE.Vector3, radius: number, loud: boolean) {
    if (this.dead || this.state === 'gone' || this.state === 'passive') return;
    const d = dist2D(this.pos, pos);
    if (d > radius) return;
    this.lastKnown.copy(pos);
    this.hasLastKnown = true;
    if (loud && d < radius * 0.55) {
      this.alert = 1;
      this.state = 'chase';
    } else {
      this.alert = Math.max(this.alert, 0.62);
      if (this.state === 'patrol' || this.state === 'search') {
        this.state = 'investigate';
        this.repathTimer = 0;
      }
    }
  }

  private perceive(ctx: EnemyContext) {
    const s = this.stats;
    if (ctx.playerHidden) {
      // the prey vanished into the ceiling: keep hunting the last known spot
      this.canSeePlayer = false;
      this.timeSinceSeen += 0.12;
      this.alert = Math.max(0, this.alert - 0.012);
      return;
    }
    const eye = this.eyePos;
    const toPlayer = ctx.playerPos.clone().sub(this.pos);
    const dist = toPlayer.length();
    this.canSeePlayer = false;
    if (dist < s.sightRange) {
      const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const dirN = toPlayer.clone().setY(0).normalize();
      const inFov = dist < 3.2 || facing.dot(dirN) > 0.12;
      if (inFov && ctx.world.lineOfSight(eye, ctx.playerEye)) {
        this.canSeePlayer = true;
      }
    }
    if (this.canSeePlayer) {
      this.timeSinceSeen = 0;
      this.lastKnown.copy(ctx.playerPos);
      this.hasLastKnown = true;
      const prox = 1 - clamp(dist / s.sightRange, 0, 1);
      let rate = 0.55 + prox * 2.3;
      if (ctx.playerCrouching) rate *= 0.5;
      this.alert = Math.min(1, this.alert + rate * 0.12);
      if (this.kind === 'watcher' && this.state === 'passive' && !this.scripted) {
        // watcher notices instantly but chooses
        this.alert = Math.min(1, this.alert + 0.004);
      }
    } else {
      this.timeSinceSeen += 0.12;
      this.alert = Math.max(0, this.alert - 0.012);
    }
    // player movement noise
    if (ctx.playerNoise > 0 && dist < ctx.playerNoise && this.state !== 'passive') {
      this.lastKnown.copy(ctx.playerPos);
      this.hasLastKnown = true;
      this.alert = Math.max(this.alert, 0.55);
      if (this.state === 'patrol') this.state = 'investigate';
    }
  }

  update(ctx: EnemyContext) {
    const dt = ctx.dt;
    if (this.state === 'gone') return;

    // ---------------- death sequence
    if (this.state === 'dead') {
      this.deathTimer += dt;
      const m = this.model;
      const fall = clamp(this.deathTimer / 0.55, 0, 1);
      m.group.rotation.x = -fall * (Math.PI / 2) * 0.9;
      if (this.deathTimer > 2.2) {
        m.group.position.y = this.model.baseY - (this.deathTimer - 2.2) * 0.5;
      }
      if (!this.deathNotified) {
        this.deathNotified = true;
        ctx.audio.enemyDie(this.voiceKind, this.pos);
        ctx.effects.deathBurst(new THREE.Vector3(this.pos.x, 1, this.pos.z));
        ctx.onDeath(this);
        if (this.voice) this.voice.update(this.pos, 0, 0);
      }
      if (this.deathTimer > 4) {
        this.state = 'gone';
        this.group.visible = false;
        this.voice?.dispose();
        this.voice = null;
      }
      return;
    }

    // ---------------- perception (staggered)
    this.perceptTimer -= dt;
    if (this.perceptTimer <= 0) {
      this.perceptTimer = 0.12;
      this.perceive(ctx);
    }

    const distToPlayer = dist2D(this.pos, ctx.playerPos);
    const s = this.stats;

    // ---------------- state machine
    if (this.stunTimer > 0) {
      this.stunTimer -= dt;
    } else if (this.kind === 'watcher' && this.state === 'passive') {
      this.updateWatcherPassive(ctx, distToPlayer);
    } else {
      // alert → chase transitions
      if (this.alert >= 1 && this.state !== 'chase' && this.state !== 'attack') {
        this.state = 'chase';
        this.repathTimer = 0;
        if (this.kind === 'stalker' || this.kind === 'heavy' || this.kind === 'guardian') ctx.audio.enemyAttack(this.voiceKind, this.pos);
      }
      switch (this.state) {
        case 'patrol': {
          const target = this.patrolPoints[this.patrolIdx % this.patrolPoints.length];
          if (this.moveAlong(ctx, target, s.patrolSpeed)) {
            this.waitTimer -= dt;
            if (this.waitTimer <= 0) {
              this.patrolIdx++;
              this.waitTimer = rand(0.6, 2.2);
            }
          }
          break;
        }
        case 'investigate': {
          if (!this.hasLastKnown) { this.state = 'patrol'; break; }
          if (this.moveAlong(ctx, this.lastKnown, s.patrolSpeed * 1.5)) {
            this.state = 'search';
            this.searchTimer = rand(3, 5);
          }
          break;
        }
        case 'search': {
          this.searchTimer -= dt;
          this.yaw += Math.sin(ctx.dt * 40 + this.id) * 0.01 + dt * 0.7 * (this.id % 2 === 0 ? 1 : -1);
          if (this.searchTimer <= 0) {
            this.alert = Math.min(this.alert, 0.3);
            this.state = 'patrol';
          }
          break;
        }
        case 'chase':
        case 'attack': {
          this.updateChase(ctx, distToPlayer);
          break;
        }
        default:
          break;
      }
    }

    // ---------------- timers
    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.chargeCooldown > 0) this.chargeCooldown -= dt;
    if (this.vanishCooldown > 0) this.vanishCooldown -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const on = this.flashTimer > 0;
      for (const m of this.model.mats) {
        if (on) {
          m.emissive.setHex(0x7a1414);
          m.emissiveIntensity = 1.4;
        } else {
          m.emissive.setHex(m.userData.baseEmissive ?? 0x000000);
          m.emissiveIntensity = m.userData.baseEI ?? 0;
        }
      }
    }

    // ---------------- integrate knockback
    if (this.knockback.lengthSq() > 0.001) {
      this.pos.addScaledVector(this.knockback, dt * 4);
      this.knockback.multiplyScalar(Math.pow(0.0001, dt));
      ctx.world.collide(this.pos, s.radius, true);
    }

    // ---------------- voice
    if (this.voice) {
      const active = clamp(1.15 - distToPlayer / 40, 0, 1);
      const agit = this.chasing ? 1 : this.alert > 0.4 ? 0.55 : 0.25;
      this.voice.update(new THREE.Vector3(this.pos.x, this.stats.eyeHeight, this.pos.z), this.state === 'passive' ? active * 0.5 : active, agit);
    }

    this.animate(ctx, distToPlayer);
  }

  private updateWatcherPassive(ctx: EnemyContext, distToPlayer: number) {
    // face the player, slow and deliberate
    const toP = Math.atan2(-(ctx.playerPos.x - this.pos.x), -(ctx.playerPos.z - this.pos.z));
    this.yaw = angleLerp(this.yaw, toP, 1 - Math.pow(0.01, ctx.dt));
    this.speedActual = 0;

    const threatRange = this.scripted ? 11 : 6.5;
    if (this.vanishCooldown <= 0 && distToPlayer < threatRange) {
      this.vanish(ctx);
      return;
    }
    if (!this.scripted) {
      if (ctx.isLookedAt(this) && distToPlayer < 30) {
        this.gazeTimer += ctx.dt;
        if (this.gazeTimer > 2.3) {
          this.becomeHostile();
          ctx.audio.enemyAttack('watcher', this.pos);
          ctx.onWatcherVanish(this); // reuse as "flicker + stinger" hook
        }
      } else {
        this.gazeTimer = Math.max(0, this.gazeTimer - ctx.dt * 1.5);
      }
    } else {
      // scripted: vanish when player gets close or stares briefly
      if (ctx.isLookedAt(this) && distToPlayer < 26) {
        this.gazeTimer += ctx.dt;
        if (this.gazeTimer > 1.1) this.vanish(ctx);
      }
    }
  }

  private vanish(ctx: EnemyContext) {
    ctx.effects.burst(new THREE.Vector3(this.pos.x, 1.4, this.pos.z), {
      count: 22, color: [0x22222e, 0x555566, 0x111118], speed: 1.4, life: 0.7, size: 7, gravity: -0.5, up: 0.4,
    });
    ctx.onWatcherVanish(this);
    if (this.scripted) {
      this.state = 'gone';
      this.group.visible = false;
      this.voice?.dispose();
      this.voice = null;
      return;
    }
    const dest = ctx.world.randomFloorNear(ctx.playerPos, 17, 30);
    if (dest) {
      // prefer spots the player can't currently see
      this.pos.copy(dest);
      this.group.position.copy(this.pos).setY(this.model.baseY);
    }
    this.gazeTimer = 0;
    this.vanishCooldown = 6;
    this.alert = 0;
  }

  private updateChase(ctx: EnemyContext, distToPlayer: number) {
    const s = this.stats;
    const dt = ctx.dt;

    // lost the player → search
    if (this.timeSinceSeen > 6.5 && !this.canSeePlayer) {
      this.state = 'search';
      this.searchTimer = rand(4, 6);
      this.alert = 0.55;
      return;
    }

    // ------- heavy charge attack
    if (this.kind === 'heavy') {
      if (this.chargeState === 'telegraph') {
        this.chargeTimer -= dt;
        this.speedActual = 0;
        if (this.chargeTimer <= 0) {
          this.chargeState = 'charging';
          this.chargeTimer = 0.85;
          this.chargeDir.copy(ctx.playerPos).sub(this.pos).setY(0).normalize();
          ctx.audio.enemyAttack('heavy', this.pos);
        }
        this.animateChargeLean();
        return;
      }
      if (this.chargeState === 'charging') {
        this.chargeTimer -= dt;
        const before = this.pos.clone();
        this.pos.addScaledVector(this.chargeDir, 8.4 * dt);
        ctx.world.collide(this.pos, s.radius, true);
        const moved = before.distanceTo(this.pos);
        this.speedActual = 8.4;
        this.yaw = Math.atan2(-this.chargeDir.x, -this.chargeDir.z);
        if (!ctx.playerHidden && distToPlayer < 1.7) {
          ctx.damagePlayer(26, this.pos);
          ctx.effects.shockwave(this.pos, 3);
          this.chargeState = 'recover';
          this.chargeTimer = 1.1;
          this.chargeCooldown = 6;
          return;
        }
        if (this.chargeTimer <= 0 || moved < 8.4 * dt * 0.35) {
          // slammed into something / ran out
          if (moved < 8.4 * dt * 0.35) {
            ctx.effects.shockwave(this.pos, 4.2);
            ctx.audio.impactWall(this.pos, true);
            ctx.onHeavySlam(this.pos);
            this.stunTimer = 1.5;
          }
          this.chargeState = 'recover';
          this.chargeTimer = 0.7;
          this.chargeCooldown = 6;
        }
        return;
      }
      if (this.chargeState === 'recover') {
        this.chargeTimer -= dt;
        this.speedActual = 0;
        if (this.chargeTimer <= 0) this.chargeState = 'none';
        return;
      }
      if (this.chargeCooldown <= 0 && distToPlayer > 6 && distToPlayer < 13.5 && this.canSeePlayer) {
        this.chargeState = 'telegraph';
        this.chargeTimer = 0.65;
        return;
      }
    }

    // ------- guardian: territorial — it never strays far from the nest
    if (this.kind === 'guardian' && dist2D(ctx.playerPos, this.home) > 15) {
      this.state = 'search';
      this.searchTimer = 2;
      this.alert = 0.4;
      this.lastKnown.copy(this.home);
      return;
    }

    // ------- melee attack (never through the ceiling at a crawling player)
    if (!ctx.playerHidden && distToPlayer < s.attackRange && this.attackTimer <= 0 && this.attackWindup < 0) {
      this.attackWindup = 0;
      ctx.audio.enemyAttack(this.voiceKind, this.pos);
    }
    if (this.attackWindup >= 0) {
      this.attackWindup += dt;
      const windupTime = this.kind === 'heavy' ? 0.55 : this.kind === 'guardian' ? 0.7 : 0.34;
      // runner lunges forward mid-windup
      if (this.kind === 'runner' && this.attackWindup > windupTime * 0.5) {
        const toP = ctx.playerPos.clone().sub(this.pos).setY(0).normalize();
        this.pos.addScaledVector(toP, 5.2 * dt);
        ctx.world.collide(this.pos, s.radius, true);
      }
      if (this.attackWindup >= windupTime) {
        this.attackWindup = -1;
        this.attackTimer = s.attackCooldown;
        const d2 = dist2D(this.pos, ctx.playerPos);
        if (!ctx.playerHidden && d2 < s.attackRange * 1.3 && ctx.world.lineOfSight(this.eyePos, ctx.playerEye)) {
          ctx.damagePlayer(s.damage, this.pos);
        }
      }
      // face player while winding up
      const toP = Math.atan2(-(ctx.playerPos.x - this.pos.x), -(ctx.playerPos.z - this.pos.z));
      this.yaw = angleLerp(this.yaw, toP, 1 - Math.pow(0.0001, dt));
      this.speedActual = 0;
      return;
    }

    // ------- movement toward player / last known
    const target = this.canSeePlayer || this.timeSinceSeen < 1.2 ? ctx.playerPos : this.lastKnown;
    const speed = this.kind === 'watcher' ? s.chaseSpeed : s.chaseSpeed;
    this.moveAlong(ctx, target, speed, true);
  }

  private animateChargeLean() {
    this.model.torso.rotation.x = 0.35 + Math.sin(performance.now() * 0.03) * 0.03;
  }

  /**
   * Pathfind toward target; move. Returns true when arrived.
   */
  private moveAlong(ctx: EnemyContext, target: THREE.Vector3, speed: number, chasing = false): boolean {
    const dt = ctx.dt;
    const s = this.stats;
    this.repathTimer -= dt;

    const distT = dist2D(this.pos, target);
    if (distT < (chasing ? s.attackRange * 0.8 : 0.9)) {
      this.speedActual = lerp(this.speedActual, 0, 1 - Math.pow(0.001, dt));
      return !chasing;
    }

    const needPath =
      this.repathTimer <= 0 ||
      this.path.length === 0 ||
      (this.pathIdx >= this.path.length && distT > 2);
    if (needPath) {
      this.repathTimer = chasing ? rand(0.45, 0.7) : rand(0.9, 1.4);
      const p = ctx.world.findPath(this.pos, target);
      if (p.length) {
        this.path = p;
        this.pathIdx = 0;
      } else if (this.path.length === 0) {
        // no path: shuffle directly (will bump into door/walls)
        this.path = [target.clone()];
        this.pathIdx = 0;
      }
    }

    let wp = this.path[Math.min(this.pathIdx, this.path.length - 1)];
    if (!wp) { this.speedActual = 0; return true; }
    let toWp = wp.clone().sub(this.pos).setY(0);
    let dWp = toWp.length();
    if (dWp < 0.55 && this.pathIdx < this.path.length - 1) {
      this.pathIdx++;
      wp = this.path[this.pathIdx];
      toWp = wp.clone().sub(this.pos).setY(0);
      dWp = toWp.length();
    }

    // door handling: if blocked ahead by a closed normal door, open it
    const ahead = this.pos.clone().addScaledVector(toWp.clone().normalize(), 1.1);
    const dtx = Math.floor(ahead.x / 4);
    const dty = Math.floor(ahead.z / 4);
    const door = ctx.world.doorAt(dtx, dty);
    if (door && door.closed) {
      if (door.kind === 'normal') {
        if (dist2D(this.pos, door.pos) < 3.4) ctx.world.enemyOpenDoor(door);
      }
    }

    const dir = toWp.normalize();
    const desiredYaw = Math.atan2(-dir.x, -dir.z);
    this.yaw = angleLerp(this.yaw, desiredYaw, 1 - Math.pow(0.0005, dt));
    const stepSpeed = speed;
    this.pos.addScaledVector(dir, stepSpeed * dt);
    ctx.world.collide(this.pos, s.radius, true);
    this.speedActual = lerp(this.speedActual, stepSpeed, 1 - Math.pow(0.001, dt));

    // step sounds
    this.stepAccum += this.speedActual * dt;
    const stride = this.kind === 'heavy' ? 2.6 : 2.0;
    if (this.stepAccum > stride) {
      this.stepAccum = 0;
      ctx.audio.enemyStep(this.voiceKind, this.pos.clone().setY(1));
    }
    return false;
  }

  private animate(ctx: EnemyContext, distToPlayer: number) {
    void distToPlayer;
    const dt = ctx.dt;
    const m = this.model;
    const speedK = clamp(this.speedActual / 3, 0, 1.8);
    this.walkPhase += dt * (3 + this.speedActual * 1.9);
    const ph = this.walkPhase;
    const amp = 0.5 * speedK;

    if (this.kind !== 'watcher') {
      m.legL.rotation.x = Math.sin(ph) * amp;
      m.legR.rotation.x = Math.sin(ph + Math.PI) * amp;
      if (this.kind === 'runner') {
        m.armL.rotation.x = Math.sin(ph + Math.PI) * amp * 0.9 - 0.7;
        m.armR.rotation.x = Math.sin(ph) * amp * 0.9 - 0.7;
      } else {
        m.armL.rotation.x = Math.sin(ph + Math.PI) * amp * 0.6;
        m.armR.rotation.x = Math.sin(ph) * amp * 0.6;
      }
    } else {
      // watcher drifts, arms hang limp with slight sway
      m.armL.rotation.x = Math.sin(ph * 0.4) * 0.06;
      m.armR.rotation.x = Math.cos(ph * 0.33) * 0.06;
      m.group.position.y = this.model.baseY + Math.sin(performance.now() * 0.0016 + this.id) * 0.07;
    }

    // attack pose overrides
    if (this.attackWindup >= 0) {
      const k = clamp(this.attackWindup / 0.34, 0, 1);
      m.armL.rotation.x = -2.3 * k;
      m.armR.rotation.x = -2.3 * k;
      m.torso.rotation.x = (this.kind === 'runner' ? 0.78 : 0.13) - 0.25 * k;
      if (m.jaw) m.jaw.rotation.x = 0.55 * k; // jaws gape as it commits
    } else if (this.kind !== 'heavy' || this.chargeState === 'none') {
      const baseTorso = this.kind === 'runner' ? 0.78 : this.kind === 'stalker' ? 0.13 : this.kind === 'guardian' ? 0.38 : 0;
      m.torso.rotation.x = lerp(m.torso.rotation.x, baseTorso + Math.sin(ph * 2) * 0.03 * speedK, 1 - Math.pow(0.001, dt));
      if (m.jaw) m.jaw.rotation.x = lerp(m.jaw.rotation.x, Math.sin(ph * 1.4) * 0.04, 1 - Math.pow(0.001, dt));
    }

    // body bob + placement
    if (this.kind !== 'watcher') {
      m.group.position.set(this.pos.x, Math.abs(Math.sin(ph)) * 0.045 * speedK, this.pos.z);
    } else {
      m.group.position.x = this.pos.x;
      m.group.position.z = this.pos.z;
    }
    m.group.rotation.y = this.yaw;

    // head tracks player when close & aware (stalkers/watchers)
    if ((this.kind === 'stalker' || this.kind === 'watcher') && this.alert > 0.3) {
      const toP = Math.atan2(-(ctx.playerPos.x - this.pos.x), -(ctx.playerPos.z - this.pos.z));
      let rel = toP - this.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      m.head.rotation.y = clamp(rel, -0.7, 0.7);
    }
    if (this.kind === 'stalker') {
      // it tilts its head like a dog hearing a new kind of pain
      m.head.rotation.z = 0.1 + Math.sin(performance.now() * 0.009) * 0.035;
    }
  }

  /** Fade the voice out (used when the run is paused / over). */
  silence() {
    if (this.voice) this.voice.update(this.pos, 0, 0);
  }

  dispose() {
    this.voice?.dispose();
    this.voice = null;
  }
}

export function spawnEnemies(world: World, audio: AudioEngine): Enemy[] {
  return world.enemySpawns.map((s) => new Enemy(s, audio));
}
