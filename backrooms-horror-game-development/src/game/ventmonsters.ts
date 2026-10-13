import * as THREE from 'three';
import { DamageTarget, clamp, angleLerp, rand } from './types';
import { VentNetwork, VentPortal, VentFoothold, footholdPos, footholdNodeDistance } from './vents';
import type { World } from './world';
import type { AudioEngine, EnemyVoice } from './audio';
import type { Effects } from './effects';

export interface VentMonsterContext {
  dt: number;
  /** Player's body position (room feet, or duct position while crawling). */
  playerPos: THREE.Vector3;
  playerEye: THREE.Vector3;
  playerLookDir: THREE.Vector3;
  playerInVent: VentFoothold | null;
  /** 0 = still, 1 = crawling, 2 = fast crawl, 3 = gunshot-tier noise. */
  playerNoiseLevel: number;
  world: World;
  audio: AudioEngine;
  effects: Effects;
  damagePlayer: (amount: number, fromPos: THREE.Vector3) => void;
  onKill: (m: VentMonster) => void;
}

export type VentMonster = Crawler | VentStalker;

/** Moves a creature along vent-graph segments at a steady speed. */
export class GraphMover {
  net: VentNetwork;
  pos: THREE.Vector3;
  node: number;
  yaw = 0;
  private path: number[] = [];
  private target = -1;
  private segFrom: number;
  private segTo: number;
  private segT = 1;
  moving = false;

  constructor(net: VentNetwork, startNode: number) {
    this.net = net;
    this.node = startNode;
    this.segFrom = startNode;
    this.segTo = startNode;
    this.pos = net.nodes[startNode].pos.clone();
  }

  get currentTarget() { return this.target; }
  get arrived() { return this.target === -1 || (this.node === this.target && this.segT >= 1); }

  setDestination(node: number) {
    if (node === this.target && this.path.length) return;
    this.target = node;
    const from = this.segT < 1 ? this.segTo : this.node;
    this.path = this.net.findPath(from, node);
    if (this.segT >= 1 && this.path.length > 1) this.beginSegment(this.path[1]);
  }

  private beginSegment(next: number) {
    this.segFrom = this.node;
    this.segTo = next;
    this.segT = 0;
  }

  /** Returns true on the frame the final destination is reached. */
  advance(dt: number, speed: number): boolean {
    this.moving = false;
    if (this.arrived) return true;
    if (this.segT >= 1) {
      // standing at a node: pick the next hop
      const idx = this.path.indexOf(this.node);
      const next = this.path[idx + 1];
      if (next === undefined) { this.target = -1; return true; }
      this.beginSegment(next);
    }
    const a = this.net.nodes[this.segFrom].pos;
    const b = this.net.nodes[this.segTo].pos;
    const len = a.distanceTo(b);
    if (len < 0.001) { this.segT = 1; this.node = this.segTo; return false; }
    this.segT = Math.min(1, this.segT + (speed * dt) / len);
    this.pos.lerpVectors(a, b, this.segT);
    const dir = b.clone().sub(a).setY(0);
    if (dir.lengthSq() > 0.001) {
      const targetYaw = Math.atan2(-dir.x, -dir.z);
      this.yaw = angleLerp(this.yaw, targetYaw, 1 - Math.pow(0.0001, dt));
    }
    this.moving = true;
    if (this.segT >= 1) {
      this.node = this.segTo;
      if (this.node === this.target) { this.target = -1; return true; }
    }
    return false;
  }

  teleportToNode(node: number) {
    this.node = node;
    this.segFrom = node;
    this.segTo = node;
    this.segT = 1;
    this.path = [];
    this.target = -1;
    this.pos.copy(this.net.nodes[node].pos);
  }
}

// ==================================================================== models
function sm(color: number, rough = 0.8, emissive = 0, ei = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05, emissive, emissiveIntensity: ei });
  m.userData.baseEmissive = emissive;
  m.userData.baseEI = ei;
  return m;
}

interface VentModel {
  group: THREE.Group;
  head: THREE.Object3D;
  legs: THREE.Object3D[];
  mats: THREE.MeshStandardMaterial[];
}

function buildCrawlerModel(): VentModel {
  const mats: THREE.MeshStandardMaterial[] = [];
  const M = (m: THREE.MeshStandardMaterial) => { mats.push(m); return m; };
  const skin = M(sm(0x8f8672, 0.65));
  const dark = M(sm(0x2e2a24, 0.9));
  const bone = M(sm(0xcabfa4, 0.55));
  const g = new THREE.Group();

  // four shrinking segments of spine, each with its own dorsal barb
  const segs: [number, number, number][] = [[0, 0.26, 0.2], [0.42, 0.23, 0.18], [0.8, 0.19, 0.15], [1.12, 0.15, 0.12]];
  for (const [sz, w, h] of segs) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.42), skin);
    seg.position.set(0, 0.42, sz);
    seg.castShadow = true;
    g.add(seg);
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.12, 5), bone);
    barb.position.set(0, 0.42 + h / 2 + 0.04, sz);
    barb.rotation.x = -0.4;
    g.add(barb);
  }
  // a barbed tail curling up off the last segment
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.34, 6), dark);
  tail.position.set(0, 0.5, 1.38);
  tail.rotation.x = Math.PI / 2 + 0.5;
  g.add(tail);
  const tailTip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.16, 5), bone);
  tailTip.position.set(0, 0.62, 1.52);
  tailTip.rotation.x = Math.PI / 2 + 1.1;
  g.add(tailTip);

  // head: low skull, four eyes, mandibles that click in the dark
  const head = new THREE.Group();
  head.position.set(0, 0.44, -0.38);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), skin);
  skull.scale.set(0.75, 0.85, 1.5);
  skull.castShadow = true;
  head.add(skull);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.04, 0.18), dark);
  jaw.position.set(0, -0.07, -0.06);
  head.add(jaw);
  for (const sx of [-1, 1]) {
    const mand = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.14, 5), bone);
    mand.position.set(sx * 0.07, -0.05, -0.12);
    mand.rotation.x = Math.PI / 2 + 0.4;
    mand.rotation.z = sx * -0.5;
    head.add(mand);
  }
  const eyeMat = M(sm(0xd8dcc8, 0.4, 0xcfd8b8, 2.4));
  for (const [ex, ey, er] of [[-0.045, 0.02, 0.017], [0.045, 0.02, 0.017], [-0.02, 0.065, 0.01], [0.02, 0.065, 0.01]] as const) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(er, 6, 6), eyeMat);
    e.position.set(ex, ey, -0.125);
    head.add(e);
  }
  g.add(head);

  // six legs in three pairs — it scuttles like it owns the duct (it does)
  const legs: THREE.Object3D[] = [];
  const mkLeg = (x: number, z: number) => {
    const leg = new THREE.Group();
    leg.position.set(x, 0.42, z);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.04), skin);
    upper.position.y = -0.22;
    upper.castShadow = true;
    leg.add(upper);
    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.3, 5), bone);
    claw.position.set(0, -0.52, 0.07);
    claw.rotation.x = 0.7;
    leg.add(claw);
    g.add(leg);
    legs.push(leg);
    return leg;
  };
  for (const z of [-0.18, 0.3, 0.78]) { mkLeg(-0.16, z); mkLeg(0.16, z); }
  return { group: g, head, legs, mats };
}

function buildStalkerModel(): VentModel {
  const mats: THREE.MeshStandardMaterial[] = [];
  const M = (m: THREE.MeshStandardMaterial) => { mats.push(m); return m; };
  const robe = M(sm(0x0b0b10, 0.55));
  const skin = M(sm(0xcfc9b8, 0.55));
  const bone = M(sm(0x9a917e, 0.6));
  const g = new THREE.Group();
  // hangs inverted from the duct roof: layered cloth, arms like ropes,
  // and a head full of hair and eyes at the bottom of it all
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.3, 0.85, 8), robe);
  body.position.y = 0.55;
  body.castShadow = true;
  g.add(body);
  const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.2, 0.5, 8), robe);
  shroud.position.y = 0.78;
  g.add(shroud);
  const mkArm = (sx: number) => {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.2, 0.85, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.72, 0.05), robe);
    mesh.position.y = -0.36;
    mesh.castShadow = true;
    arm.add(mesh);
    // four rope-fingers with bone tips
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.2, 4), bone);
      f.position.set((i - 1.5) * 0.018, -0.8, 0.005);
      f.rotation.x = Math.PI;
      f.rotation.z = (i - 1.5) * 0.2;
      arm.add(f);
    }
    g.add(arm);
    return arm;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);
  const head = new THREE.Group();
  head.position.set(0, 0.18, 0);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 10), skin);
  skull.scale.set(0.8, 1.4, 0.85);
  skull.castShadow = true;
  head.add(skull);
  const eyeMat = M(sm(0xffffff, 0.3, 0xffffff, 3.2));
  for (const [ex, ey, er] of [[-0.034, 0.02, 0.016], [0.034, 0.02, 0.016], [0, 0.075, 0.011]] as const) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(er, 6, 6), eyeMat);
    e.position.set(ex, ey, -0.075);
    head.add(e);
  }
  // mouth: a small, patient o
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), M(sm(0x020204, 0.4)));
  mouth.position.set(0, -0.055, -0.07);
  mouth.scale.set(1, 1.3, 0.5);
  head.add(mouth);
  // hair: dark strands hanging past the face toward the floor
  for (let i = 0; i < 7; i++) {
    const h = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.26 + (i % 3) * 0.05, 4), robe);
    h.position.set((i - 3) * 0.02, -0.16, -0.02 + (i % 2) * 0.03);
    h.rotation.x = Math.PI + (i - 3) * 0.05;
    head.add(h);
  }
  g.add(head);
  return { group: g, head, legs: [armL, armR], mats };
}

// ==================================================================== CRAWLER
export type CrawlerState =
  | 'patrol' | 'investigate' | 'hunt' | 'retreat' | 'emerge' | 'return' | 'bash' | 'dead';

export class Crawler implements DamageTarget {
  readonly isVentCreature = true;
  heightTotal = 0.95;
  net: VentNetwork;
  mover: GraphMover;
  group: THREE.Group;
  private model: VentModel;
  private voice: EnemyVoice | null;
  state: CrawlerState = 'patrol';
  pos: THREE.Vector3;
  radius = 0.34;
  eyeHeight = 0.55;
  health = 150;
  private alert = 0;
  private deadFlag = false;
  private killNotified = false;
  private perceptTimer = 0;
  private repathTimer = 0;
  private noHuntTimer = 0;
  private emergeTimer = 0;
  private roomPath: THREE.Vector3[] = [];
  private roomRepath = 0;
  private targetPortal: VentPortal | null = null;
  private flashTimer = 0;
  private walkPhase = 0;
  private stepTimer = 0;
  private deadTimer = 0;

  constructor(net: VentNetwork, startNode: number, audio: AudioEngine) {
    this.net = net;
    this.mover = new GraphMover(net, startNode);
    this.pos = this.mover.pos;
    this.model = buildCrawlerModel();
    this.group = this.model.group;
    this.group.position.copy(this.pos);
    this.voice = audio.enemyVoice('runner');
  }

  get alive() { return !this.deadFlag; }
  get isDead() { return this.deadFlag; }
  get hunting() { return this.state === 'hunt' || this.state === 'emerge'; }
  get inVent() { return this.state !== 'emerge' && this.state !== 'return' && this.state !== 'dead'; }

  applyDamage(amount: number, _part: 'head' | 'body', _point: THREE.Vector3, _dir: THREE.Vector3): boolean {
    void _part; void _point; void _dir;
    if (this.deadFlag) return true;
    this.health -= amount;
    this.flashTimer = 0.09;
    this.alert = 1;
    if (this.inVent && this.state !== 'hunt') this.state = 'hunt';
    if (this.health <= 0) {
      this.deadFlag = true;
      this.state = 'dead';
      this.deadTimer = 0;
      return true;
    }
    return false;
  }

  hearNoise(pos: THREE.Vector3, radius: number, loud: boolean, audio: AudioEngine) {
    if (this.deadFlag || !this.inVent) return;
    const near = this.net.nearestNode(new THREE.Vector3(pos.x, this.pos.y, pos.z));
    const d = this.net.graphDistance(this.mover.node, near);
    if (d > radius && pos.distanceTo(this.pos) > radius) return;
    if (loud) {
      this.alert = Math.min(1, this.alert + 0.5);
      if (this.state === 'patrol') {
        this.state = 'investigate';
        this.mover.setDestination(near);
      }
    } else {
      this.alert = Math.min(1, this.alert + 0.22);
      if (this.state === 'patrol') {
        this.state = 'investigate';
        this.mover.setDestination(near);
      }
    }
    void audio;
  }

  update(ctx: VentMonsterContext) {
    const dt = ctx.dt;
    if (this.state === 'dead') {
      this.deadTimer += dt;
      this.model.group.rotation.x = -clamp(this.deadTimer / 0.5, 0, 1) * 1.3;
      if (!this.killNotified) {
        this.killNotified = true;
        ctx.audio.enemyDie('runner', this.pos);
        ctx.effects.deathBurst(this.pos.clone().setY(this.pos.y + 0.4));
        ctx.onKill(this);
        this.voice?.update(this.pos, 0, 0);
      }
      if (this.deadTimer > 3.5) {
        this.group.visible = false;
        this.voice?.dispose();
        this.voice = null;
      }
      return;
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const on = this.flashTimer > 0;
      for (const m of this.model.mats) {
        if (on) { m.emissive.setHex(0x7a1414); m.emissiveIntensity = 1.4; }
        else { m.emissive.setHex(m.userData.baseEmissive ?? 0); m.emissiveIntensity = m.userData.baseEI ?? 0; }
      }
    }
    if (this.noHuntTimer > 0) this.noHuntTimer -= dt;

    // ---------------- perception
    this.perceptTimer -= dt;
    const playerVentPos = ctx.playerInVent ? footholdPos(ctx.playerInVent, new THREE.Vector3()) : null;
    if (this.perceptTimer <= 0) {
      this.perceptTimer = 0.15;
      if (this.inVent && ctx.playerInVent && ctx.playerInVent.network === this.net && this.noHuntTimer <= 0) {
        const myNode = this.net.nearestNode(this.pos);
        const dist = footholdNodeDistance(this.net, myNode, ctx.playerInVent);
        const inAlcove = ctx.playerInVent.network.nodes[
          ctx.playerInVent.t < 0.5 ? ctx.playerInVent.a : ctx.playerInVent.b
        ].alcove && ctx.playerNoiseLevel === 0;
        let rate = 0;
        if (dist < 16) {
          rate = (ctx.playerNoiseLevel === 0 ? 0.05 : ctx.playerNoiseLevel === 1 ? 0.34 : ctx.playerNoiseLevel === 2 ? 0.8 : 2.2)
            * clamp(1.2 - dist / 16, 0.15, 1.2);
          if (inAlcove) rate *= 0.15;
        }
        if (playerVentPos && this.pos.distanceTo(playerVentPos) < 2.4) rate = Math.max(rate, 1.6);
        this.alert = clamp(this.alert + rate * 0.15 * 6.6, 0, 1);
        if (this.alert >= 1 && this.state !== 'hunt') {
          this.state = 'hunt';
          ctx.audio.crawlerScreech(this.pos.clone().setY(this.pos.y + 0.4));
          ctx.effects.shockwave(this.pos.clone(), 1.6);
        }
      } else if (!ctx.playerInVent) {
        this.alert = Math.max(0, this.alert - 0.01);
      }
    }

    // ---------------- states
    switch (this.state) {
      case 'patrol': {
        if (this.mover.arrived) this.mover.setDestination(this.net.randomNode());
        this.mover.advance(dt, 1.55);
        break;
      }
      case 'investigate': {
        if (this.mover.advance(dt, 2.3)) {
          this.state = 'patrol';
          this.alert = Math.min(this.alert, 0.35);
        }
        break;
      }
      case 'hunt': {
        if (!ctx.playerInVent || ctx.playerInVent.network !== this.net) {
          // prey left the ducts — spill out after it if we're near a grate
          const portal = this.nearestPortal();
          if (portal && this.net.graphDistance(this.mover.node, portal.nodeId) < 9 && ctx.playerPos.distanceTo(portal.roomPos) < 16) {
            this.targetPortal = portal;
            this.mover.setDestination(portal.nodeId);
            if (this.mover.node === portal.nodeId || this.mover.arrived) {
              if (portal.grateOpen) this.beginEmerge(ctx, portal);
              else { this.state = 'bash'; portal.bashTime = 3.2; }
            }
          } else {
            this.state = 'retreat';
            this.mover.setDestination(this.net.randomNode(ctx.playerPos, 14));
          }
          break;
        }
        this.repathTimer -= dt;
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.45;
          this.mover.setDestination(ctx.playerInVent.t < 0.5 ? ctx.playerInVent.a : ctx.playerInVent.b);
        }
        this.mover.advance(dt, 3.35);
        if (playerVentPos && this.pos.distanceTo(playerVentPos) < 1.05) {
          ctx.damagePlayer(14, this.pos.clone());
          ctx.audio.enemyAttack('runner', this.pos.clone());
          this.state = 'retreat';
          this.noHuntTimer = 7;
          this.alert = 0.25;
          this.mover.setDestination(this.net.randomNode(playerVentPos, 15));
        }
        break;
      }
      case 'retreat': {
        if (this.mover.advance(dt, 3.0)) this.state = 'patrol';
        break;
      }
      case 'bash': {
        const portal = this.targetPortal;
        if (!portal) { this.state = 'patrol'; break; }
        portal.bashTime -= dt;
        // rattling the grate is LOUD — the player hears exactly where it is
        if (Math.random() < dt * 6) ctx.audio.ventTap(this.pos.clone().setY(this.pos.y + 0.4));
        if (portal.bashTime <= 0) {
          portal.grateOpen = true;
          ctx.audio.doorMove(true, portal.roomPos, false);
          this.beginEmerge(ctx, portal);
        }
        break;
      }
      case 'emerge': {
        this.updateRoomChase(ctx, 3.55, 12);
        break;
      }
      case 'return': {
        const portal = this.targetPortal;
        if (!portal) { this.state = 'patrol'; break; }
        const done = this.moveAlongRoomPath(ctx, portal.roomPos, 3.2);
        if (done || this.pos.distanceTo(portal.roomPos) < 1.2) {
          // slide back into the duct
          ctx.effects.burst(this.pos.clone().setY(1), { count: 8, color: 0x4a463c, speed: 1, life: 0.5, size: 6, gravity: 1 });
          this.mover.teleportToNode(portal.nodeId);
          this.pos.y = this.net.nodes[portal.nodeId].pos.y;
          this.state = 'retreat';
          this.noHuntTimer = 5;
          this.alert = 0.2;
          this.mover.setDestination(this.net.randomNode(ctx.playerPos, 12));
        }
        break;
      }
    }

    this.syncVisual(ctx);
  }

  private nearestPortal(): VentPortal | null {
    let best: VentPortal | null = null;
    let bd = Infinity;
    for (const p of this.net.portals) {
      const d = this.net.graphDistance(this.mover.node, p.nodeId);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private beginEmerge(ctx: VentMonsterContext, portal: VentPortal) {
    this.state = 'emerge';
    this.emergeTimer = 6.5;
    this.targetPortal = portal;
    this.pos.copy(portal.roomPos).setY(0);
    this.roomPath = [];
    ctx.audio.crawlerScreech(this.pos.clone().setY(1));
    ctx.effects.burst(this.pos.clone().setY(1.4), { count: 10, color: 0x55504a, speed: 1.4, life: 0.5, size: 6, gravity: 2 });
  }

  private updateRoomChase(ctx: VentMonsterContext, speed: number, damage: number) {
    this.emergeTimer -= ctx.dt;
    const done = this.moveAlongRoomPath(ctx, ctx.playerPos, speed);
    void done;
    const d = Math.hypot(this.pos.x - ctx.playerPos.x, this.pos.z - ctx.playerPos.z);
    if (d < 1.7) {
      ctx.damagePlayer(damage, this.pos.clone());
      ctx.audio.enemyAttack('runner', this.pos.clone());
      this.state = 'return';
      this.roomPath = [];
    } else if (this.emergeTimer <= 0) {
      this.state = 'return';
      this.roomPath = [];
    }
  }

  /** Walk a world-grid path toward a room position. Returns true when close. */
  private moveAlongRoomPath(ctx: VentMonsterContext, target: THREE.Vector3, speed: number): boolean {
    this.roomRepath -= ctx.dt;
    if (this.roomRepath <= 0 || this.roomPath.length === 0) {
      this.roomRepath = 0.5;
      this.roomPath = ctx.world.findPath(this.pos, target);
    }
    const wp = this.roomPath[0];
    if (!wp) return Math.hypot(this.pos.x - target.x, this.pos.z - target.z) < 1.2;
    const dir = wp.clone().sub(this.pos).setY(0);
    const dist = dir.length();
    if (dist < 0.6) {
      this.roomPath.shift();
      return false;
    }
    dir.normalize();
    this.pos.addScaledVector(dir, speed * ctx.dt);
    ctx.world.collide(this.pos, this.radius, true);
    this.mover.yaw = angleLerp(this.mover.yaw, Math.atan2(-dir.x, -dir.z), 1 - Math.pow(0.0001, ctx.dt));
    return false;
  }

  private syncVisual(ctx: VentMonsterContext) {
    const inRoom = this.state === 'emerge' || this.state === 'return';
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.mover.yaw;
    // scuttle animation
    const speedK = this.mover.moving || inRoom ? 1 : 0.15;
    this.walkPhase += ctx.dt * (6 + (this.state === 'hunt' ? 7 : 0)) * speedK;
    const ph = this.walkPhase;
    this.model.legs.forEach((leg, i) => {
      leg.rotation.x = Math.sin(ph + (i % 2) * Math.PI + Math.floor(i / 2) * 0.6) * 0.55 * speedK;
      leg.rotation.z = (i % 2 === 0 ? 1 : -1) * (0.5 + Math.sin(ph * 0.7 + i) * 0.08);
    });
    this.model.head.rotation.y = Math.sin(ph * 0.23) * 0.4;
    this.model.head.rotation.x = 0.15 + Math.sin(ph * 0.4) * 0.08;
    // voice
    if (this.voice) {
      const d = this.pos.distanceTo(ctx.playerPos);
      const active = clamp(1.2 - d / 34, 0, 1) * (inRoom ? 1 : 0.75);
      this.voice.update(this.pos.clone().setY(this.pos.y + 0.5), active, this.hunting ? 1 : 0.4);
    }
    // metallic skittering when close
    if (this.mover.moving && this.pos.distanceTo(ctx.playerPos) < 15) {
      this.stepTimer -= ctx.dt;
      if (this.stepTimer <= 0) {
        this.stepTimer = this.state === 'hunt' ? 0.16 : 0.3;
        ctx.audio.ventTap(this.pos.clone().setY(this.pos.y + 0.4));
      }
    }
  }

  silence() {
    this.voice?.update(this.pos, 0, 0);
  }

  dispose() {
    this.voice?.dispose();
    this.voice = null;
  }
}

// ==================================================================== STALKER
export type StalkerState = 'lurk' | 'shadow' | 'frozen' | 'hunt' | 'gone';

export class VentStalker implements DamageTarget {
  readonly isVentCreature = true;
  heightTotal = 1.15;
  net: VentNetwork;
  mover: GraphMover;
  group: THREE.Group;
  private model: VentModel;
  private voice: EnemyVoice | null;
  state: StalkerState = 'lurk';
  pos: THREE.Vector3;
  radius = 0.3;
  eyeHeight = 0.35;
  private noiseScore = 0;
  private stareTimer = 0;
  private tapTimer = rand(4, 9);
  private repathTimer = 0;
  private flashTimer = 0;

  constructor(net: VentNetwork, startNode: number, audio: AudioEngine) {
    this.net = net;
    this.mover = new GraphMover(net, startNode);
    this.pos = this.mover.pos;
    this.model = buildStalkerModel();
    this.group = this.model.group;
    this.group.position.copy(this.pos);
    this.voice = audio.enemyVoice('watcher');
  }

  get alive() { return this.state !== 'gone'; }
  get isDead() { return false; }
  get hunting() { return this.state === 'hunt'; }
  get inVent() { return true; }

  /** It cannot be killed in the ducts. It can only be made to leave. */
  applyDamage(_amount: number, _part: 'head' | 'body', _point: THREE.Vector3, _dir: THREE.Vector3): boolean {
    void _amount; void _part; void _point; void _dir;
    this.flashTimer = 0.09;
    this.vanish();
    return false;
  }

  hearNoise(_pos: THREE.Vector3, _radius: number, loud: boolean) {
    void _pos; void _radius;
    if (loud) this.noiseScore = Math.min(8, this.noiseScore + 1.6);
  }

  private vanish() {
    // reappear somewhere far along the graph
    const far = this.net.randomNode();
    this.mover.teleportToNode(far);
    this.stareTimer = 0;
    this.state = 'lurk';
  }

  update(ctx: VentMonsterContext) {
    const dt = ctx.dt;
    if (this.state === 'gone') return;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const on = this.flashTimer > 0;
      for (const m of this.model.mats) {
        if (on) { m.emissive.setHex(0x7a1414); m.emissiveIntensity = 1.2; }
        else { m.emissive.setHex(m.userData.baseEmissive ?? 0); m.emissiveIntensity = m.userData.baseEI ?? 0; }
      }
    }
    this.noiseScore = Math.max(0, this.noiseScore - dt * 0.05);

    const playerHere = !!ctx.playerInVent && ctx.playerInVent.network === this.net;
    const myNode = this.net.nearestNode(this.pos);
    const distToPlayer = playerHere && ctx.playerInVent
      ? footholdNodeDistance(this.net, myNode, ctx.playerInVent)
      : Infinity;
    const playerVentPos = ctx.playerInVent ? footholdPos(ctx.playerInVent, new THREE.Vector3()) : null;

    // is the player looking at it?
    let lookedAt = false;
    if (playerVentPos) {
      const to = this.pos.clone().setY(this.pos.y + 0.3).sub(ctx.playerEye);
      const d = to.length();
      if (d < 16) {
        to.normalize();
        lookedAt = ctx.playerLookDir.dot(to) > 0.9;
      }
    }

    // tap-tap: let them know the ceiling has ears
    this.tapTimer -= dt;
    if (this.tapTimer <= 0) {
      this.tapTimer = rand(6, 14);
      if (ctx.playerPos.distanceTo(this.pos) < 26) ctx.audio.ventTap(this.pos.clone().setY(this.pos.y + 0.6));
    }

    switch (this.state) {
      case 'lurk': {
        if (this.mover.arrived) this.mover.setDestination(this.net.randomNode());
        this.mover.advance(dt, 1.1);
        if (playerHere) this.state = 'shadow';
        break;
      }
      case 'shadow': {
        if (!playerHere) { this.state = 'lurk'; break; }
        if (this.noiseScore >= 5) {
          this.state = 'hunt';
          ctx.audio.crawlerScreech(this.pos.clone().setY(this.pos.y + 0.4));
          break;
        }
        if (lookedAt && distToPlayer < 15) {
          this.state = 'frozen';
          this.stareTimer = 0;
          break;
        }
        // hold a following distance: neither too close nor too far
        this.repathTimer -= dt;
        if (this.repathTimer <= 0 && ctx.playerInVent) {
          this.repathTimer = 0.8;
          const playerNode = ctx.playerInVent.t < 0.5 ? ctx.playerInVent.a : ctx.playerInVent.b;
          if (distToPlayer > 15) this.mover.setDestination(playerNode);
          else if (distToPlayer < 8.5) {
            // drift away: pick the neighbour that increases distance most
            let bestNode = myNode;
            let bestD = -1;
            for (const n of this.net.adjacency[myNode]) {
              const d = this.net.graphDistance(n, playerNode);
              if (d > bestD) { bestD = d; bestNode = n; }
            }
            if (bestNode !== myNode) this.mover.setDestination(bestNode);
          } else if (this.mover.arrived) {
            // idle sway at range
            this.mover.setDestination(this.net.adjacency[myNode][0] ?? myNode);
          }
        }
        this.mover.advance(dt, 2.65);
        break;
      }
      case 'frozen': {
        // it stops when watched — and hates being stared at
        if (!lookedAt) { this.state = playerHere ? 'shadow' : 'lurk'; break; }
        this.stareTimer += dt;
        if (this.stareTimer > 1.5) {
          ctx.effects.burst(this.pos.clone().setY(this.pos.y + 0.5), {
            count: 14, color: [0x181820, 0x3a3a48], speed: 1.1, life: 0.6, size: 6, gravity: -0.3,
          });
          // relocate far from the player
          if (ctx.playerInVent) {
            let farNode = this.net.randomNode();
            for (let tries = 0; tries < 10; tries++) {
              const cand = this.net.randomNode();
              if (footholdNodeDistance(this.net, cand, ctx.playerInVent) > 16) { farNode = cand; break; }
            }
            this.mover.teleportToNode(farNode);
          } else this.vanish();
          this.state = 'lurk';
        }
        break;
      }
      case 'hunt': {
        if (!playerHere || !ctx.playerInVent) { this.state = 'lurk'; this.noiseScore = 0; break; }
        this.repathTimer -= dt;
        if (this.repathTimer <= 0) {
          this.repathTimer = 0.4;
          this.mover.setDestination(ctx.playerInVent.t < 0.5 ? ctx.playerInVent.a : ctx.playerInVent.b);
        }
        this.mover.advance(dt, 3.45);
        if (playerVentPos && this.pos.distanceTo(playerVentPos) < 1.05) {
          ctx.damagePlayer(10, this.pos.clone());
          ctx.audio.enemyAttack('watcher', this.pos.clone());
          this.noiseScore = 0;
          ctx.effects.burst(this.pos.clone().setY(this.pos.y + 0.5), {
            count: 16, color: [0x181820, 0x444455], speed: 1.3, life: 0.6, size: 6, gravity: -0.3,
          });
          this.vanish();
        }
        break;
      }
    }

    // visual: hangs from the roof, swaying gently; turns to face travel
    this.group.position.copy(this.pos);
    this.group.position.y += 0.28;
    this.group.rotation.y = this.mover.yaw;
    this.group.rotation.z = Math.sin(performance.now() * 0.0011 + this.net.id * 7) * 0.05;
    this.model.head.rotation.x = 0.25;
    const t = performance.now() * 0.001;
    this.model.legs[0].rotation.x = Math.sin(t * 0.9) * 0.1;
    this.model.legs[1].rotation.x = Math.cos(t * 0.8) * 0.1;

    if (this.voice) {
      const d = this.pos.distanceTo(ctx.playerPos);
      const active = clamp(1.15 - d / 30, 0, 1) * 0.8;
      this.voice.update(this.pos.clone().setY(this.pos.y + 0.4), active, this.state === 'hunt' ? 1 : 0.3);
    }
  }

  silence() {
    this.voice?.update(this.pos, 0, 0);
  }

  dispose() {
    this.voice?.dispose();
    this.voice = null;
  }
}
