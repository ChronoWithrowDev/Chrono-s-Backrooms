import * as THREE from 'three';
import { glowSprite, bulletHoleTexture } from './textures';
import { rand } from './types';

const MAX_PARTICLES = 1200;

/** Pooled GPU particle system + tracers + casings + muzzle flash. */
export class Effects {
  group = new THREE.Group();

  private points!: THREE.Points;
  private pPos!: Float32Array;
  private pCol!: Float32Array;
  private pSize!: Float32Array;
  private vel = new Float32Array(MAX_PARTICLES * 3);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private head = 0;

  private flashLight: THREE.PointLight;
  private flashSprite: THREE.Sprite;
  private flashTimer = 0;

  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private casings!: THREE.InstancedMesh;
  private casingData: { pos: THREE.Vector3; vel: THREE.Vector3; rot: THREE.Euler; rvel: THREE.Vector3; life: number }[] = [];
  private casingHead = 0;

  private rings: { mesh: THREE.Mesh; life: number; max: number }[] = [];
  /** Pooled floor bullet-hole decals (ring buffer, oldest recycled). */
  private holes!: THREE.InstancedMesh;
  private holeHead = 0;
  private dust!: THREE.Points;
  private dustPos!: Float32Array;

  quality = 1; // particle multiplier

  constructor() {
    // ---- particles
    const geo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) this.pPos[i * 3 + 1] = -50;
    geo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: glowSprite() } },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (140.0 / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, tex.a);
          if (gl_FragColor.a < 0.01) discard;
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    // ---- muzzle flash
    this.flashLight = new THREE.PointLight(0xffb45e, 0, 13, 1.8);
    this.group.add(this.flashLight);
    const smat = new THREE.SpriteMaterial({
      map: glowSprite(), color: 0xffc36b, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.flashSprite = new THREE.Sprite(smat);
    this.flashSprite.scale.setScalar(0.55);
    this.group.add(this.flashSprite);

    // ---- tracer pool
    const tGeo = new THREE.BoxGeometry(0.012, 0.012, 1);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(tGeo, new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      this.group.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // ---- casings
    this.casings = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.02, 0.02, 0.045),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.8 }),
      40,
    );
    this.casings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.casings.frustumCulled = false;
    this.group.add(this.casings);
    for (let i = 0; i < 40; i++) {
      this.casingData.push({ pos: new THREE.Vector3(0, -10, 0), vel: new THREE.Vector3(), rot: new THREE.Euler(), rvel: new THREE.Vector3(), life: 0 });
    }

    // ---- shockwave rings
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1, 40),
        new THREE.MeshBasicMaterial({ color: 0xcfc4a0, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.group.add(m);
      this.rings.push({ mesh: m, life: 0, max: 3 });
    }

    // ---- ground bullet-hole decals (hidden underground until used)
    const HOLES = 192;
    this.holes = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.11, 0.11),
      new THREE.MeshBasicMaterial({ map: bulletHoleTexture(), transparent: true, depthWrite: false }),
      HOLES,
    );
    const hm = new THREE.Matrix4();
    const hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const zero = new THREE.Vector3(0, 0, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < HOLES; i++) {
      hm.compose(zero, hq, one);
      hm.setPosition(0, -5, 0);
      this.holes.setMatrixAt(i, hm);
    }
    this.holes.instanceMatrix.needsUpdate = true;
    this.holes.frustumCulled = false;
    this.holes.renderOrder = 2;
    this.group.add(this.holes);

    // ---- ambient dust motes
    const dn = 260;
    this.dustPos = new Float32Array(dn * 3);
    for (let i = 0; i < dn; i++) {
      this.dustPos[i * 3] = rand(-16, 16);
      this.dustPos[i * 3 + 1] = rand(0.2, 3.2);
      this.dustPos[i * 3 + 2] = rand(-16, 16);
    }
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    this.dust = new THREE.Points(dGeo, new THREE.PointsMaterial({
      map: glowSprite(), color: 0xd8cba0, size: 0.035, transparent: true, opacity: 0.35,
      depthWrite: false, sizeAttenuation: true,
    }));
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  burst(pos: THREE.Vector3, opts: {
    count: number; color: number | number[]; speed?: number; life?: number;
    size?: number; gravity?: number; up?: number; spread?: number;
  }) {
    const count = Math.round(opts.count * this.quality);
    const colors = Array.isArray(opts.color) ? opts.color : [opts.color];
    const c = new THREE.Color();
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % MAX_PARTICLES;
      const i3 = i * 3;
      this.pPos[i3] = pos.x; this.pPos[i3 + 1] = pos.y; this.pPos[i3 + 2] = pos.z;
      const th = rand(0, Math.PI * 2);
      const ph = Math.acos(rand(-1, 1));
      const sp = (opts.speed ?? 2) * rand(0.25, 1);
      const spread = opts.spread ?? 1;
      this.vel[i3] = Math.sin(ph) * Math.cos(th) * sp * spread;
      this.vel[i3 + 1] = Math.cos(ph) * sp * 0.7 + (opts.up ?? 0);
      this.vel[i3 + 2] = Math.sin(ph) * Math.sin(th) * sp * spread;
      c.setHex(colors[Math.floor(Math.random() * colors.length)]);
      const dim = rand(0.6, 1.15);
      this.pCol[i3] = c.r * dim; this.pCol[i3 + 1] = c.g * dim; this.pCol[i3 + 2] = c.b * dim;
      this.maxLife[i] = this.life[i] = (opts.life ?? 0.55) * rand(0.5, 1.15);
      this.pSize[i] = (opts.size ?? 5) * rand(0.6, 1.3);
      this.grav[i] = opts.gravity ?? 2.2;
    }
  }

  /** Emit one particle with an explicit velocity (smoke trails, vortex). */
  emit(pos: THREE.Vector3, vel: THREE.Vector3, color: number, life: number, size: number, gravity = 0) {
    const i = this.head;
    this.head = (this.head + 1) % MAX_PARTICLES;
    const i3 = i * 3;
    this.pPos[i3] = pos.x; this.pPos[i3 + 1] = pos.y; this.pPos[i3 + 2] = pos.z;
    this.vel[i3] = vel.x; this.vel[i3 + 1] = vel.y; this.vel[i3 + 2] = vel.z;
    const c = new THREE.Color(color);
    this.pCol[i3] = c.r; this.pCol[i3 + 1] = c.g; this.pCol[i3 + 2] = c.b;
    this.maxLife[i] = this.life[i] = life;
    this.pSize[i] = size;
    this.grav[i] = gravity;
  }

  /** Rocket blast: fireball core, smoke, sparks, a light pulse and a ring. */
  explosion(pos: THREE.Vector3, scale = 1) {
    const p = pos.clone();
    p.y = Math.max(0.4, p.y);
    this.burst(p, { count: 34 * scale, color: [0xffd27a, 0xff8a2a, 0xff5a14], speed: 6.5 * scale, life: 0.45, size: 13 * scale, gravity: -0.5 });
    this.burst(p, { count: 26 * scale, color: [0x3a332a, 0x26221c, 0x4a4238], speed: 2.4 * scale, life: 1.6, size: 22 * scale, gravity: -0.9, up: 0.7 });
    this.burst(p, { count: 18, color: [0xffe6a8, 0xffb04a], speed: 11, life: 0.6, size: 3, gravity: 7 });
    this.flashLight.position.copy(p);
    this.flashLight.intensity = 140 * scale;
    this.flashLight.distance = 22;
    this.flashTimer = 0.14;
    this.shockwave(p, 5 * scale);
  }

  /** Punch a persistent bullet-hole decal into the floor at the hit point. */
  groundHole(pos: THREE.Vector3) {
    const i = this.holeHead;
    this.holeHead = (this.holeHead + 1) % this.holes.count;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, rand(0, Math.PI * 2)));
    const s = rand(0.75, 1.25);
    m.compose(new THREE.Vector3(pos.x, 0.012 + (i % 24) * 0.0005, pos.z), q, new THREE.Vector3(s, s, s));
    this.holes.setMatrixAt(i, m);
    this.holes.instanceMatrix.needsUpdate = true;
    // a breath of dust off the carpet/concrete
    this.burst(pos.clone().setY(0.05), { count: 3, color: 0x6e6248, speed: 0.4, life: 0.5, size: 7, gravity: -0.3, up: 0.25 });
  }

  impactWall(pos: THREE.Vector3, nx: number, nz: number) {
    const p = pos.clone();
    this.burst(p, { count: 7, color: [0xbfae86, 0x8a7c5c, 0xd8cba0], speed: 1.6, life: 0.4, size: 4, gravity: 3 });
    // bounce puff biased along normal
    const i = this.head;
    void i;
    this.burst(p, { count: 3, color: 0x6e6248, speed: 0.5, life: 0.7, size: 9, gravity: -0.4, up: 0.3 });
    void nx; void nz;
  }

  impactFlesh(pos: THREE.Vector3) {
    this.burst(pos, { count: 12, color: [0x5e0d0d, 0x7e1414, 0x3d0808], speed: 2.0, life: 0.6, size: 6, gravity: 4.5 });
  }

  deathBurst(pos: THREE.Vector3) {
    this.burst(pos, { count: 30, color: [0x5e0d0d, 0x2a0505, 0x7e1414], speed: 2.6, life: 0.9, size: 8, gravity: 4 });
  }

  muzzle(pos: THREE.Vector3) {
    this.flashSprite.position.copy(pos);
    (this.flashSprite.material as THREE.SpriteMaterial).opacity = 0.9;
    this.flashSprite.material.rotation = rand(0, Math.PI * 2);
    this.flashSprite.scale.setScalar(rand(0.4, 0.62));
    this.flashLight.position.copy(pos);
    this.flashLight.intensity = 30;
    this.flashLight.distance = 13;
    this.flashTimer = 0.045;
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3) {
    const t = this.tracers.find((x) => x.life <= 0);
    if (!t) return;
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1) return;
    t.mesh.position.copy(from).addScaledVector(dir, 0.5);
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    (t.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55;
    t.life = 0.055;
  }

  ejectCasing(pos: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3) {
    const c = this.casingData[this.casingHead];
    this.casingHead = (this.casingHead + 1) % this.casingData.length;
    c.pos.copy(pos);
    c.vel.copy(right).multiplyScalar(rand(0.7, 1.2)).addScaledVector(up, rand(1.2, 1.7));
    c.vel.x += rand(-0.2, 0.2); c.vel.z += rand(-0.2, 0.2);
    c.rvel.set(rand(-12, 12), rand(-12, 12), rand(-12, 12));
    c.life = 1.4;
  }

  shockwave(pos: THREE.Vector3, maxR = 3.4) {
    const r = this.rings.find((x) => x.life <= 0);
    if (!r) return;
    r.mesh.position.copy(pos).setY(0.06);
    r.max = maxR;
    r.life = 0.45;
    r.mesh.visible = true;
  }

  update(dt: number, camPos: THREE.Vector3) {
    // particles
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) { this.pPos[i3 + 1] = -50; continue; }
      this.vel[i3 + 1] -= this.grav[i] * dt;
      this.pPos[i3] += this.vel[i3] * dt;
      this.pPos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pPos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pPos[i3 + 1] < 0.02) { this.pPos[i3 + 1] = 0.02; this.vel[i3 + 1] *= -0.3; }
      const lr = this.life[i] / this.maxLife[i];
      this.pSize[i] = Math.max(0.4, this.pSize[i] * (0.4 + lr * 0.6) + 0.0);
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;

    // flash
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        this.flashLight.intensity = 0;
        (this.flashSprite.material as THREE.SpriteMaterial).opacity = 0;
      }
    }
    // tracers
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life / 0.055) * 0.55;
      if (t.life <= 0) t.mesh.visible = false;
    }
    // casings
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    this.casingData.forEach((c, i) => {
      if (c.life > 0) {
        c.life -= dt;
        c.vel.y -= 9.8 * dt;
        c.pos.addScaledVector(c.vel, dt);
        if (c.pos.y < 0.03) { c.pos.y = 0.03; c.vel.set(0, 0, 0); c.rvel.set(0, 0, 0); }
        c.rot.x += c.rvel.x * dt; c.rot.y += c.rvel.y * dt; c.rot.z += c.rvel.z * dt;
      }
      q.setFromEuler(c.rot);
      m4.compose(c.pos, q, one);
      this.casings.setMatrixAt(i, m4);
    });
    this.casings.instanceMatrix.needsUpdate = true;

    // rings
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = 1 - r.life / 0.45;
      r.mesh.scale.setScalar(0.3 + k * r.max);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.5;
      if (r.life <= 0) r.mesh.visible = false;
    }

    // dust drift around camera
    const t = performance.now() * 0.0001;
    this.dust.position.set(
      Math.round(camPos.x / 16) * 16 + Math.sin(t) * 1.5,
      0,
      Math.round(camPos.z / 16) * 16 + Math.cos(t * 0.8) * 1.5,
    );
  }

  setQuality(q: number) {
    this.quality = q;
  }

  setDust(on: boolean) {
    this.dust.visible = on;
  }
}
