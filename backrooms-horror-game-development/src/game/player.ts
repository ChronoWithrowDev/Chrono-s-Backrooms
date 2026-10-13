import * as THREE from 'three';
import { clamp, lerp } from './types';
import type { World } from './world';

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
}

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.02;

export class Player {
  pos = new THREE.Vector3(); // feet position
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  radius = 0.36;

  health = 100;
  maxHealth = 100;
  stamina = 100;
  maxStamina = 100;
  staminaRegenDelay = 0;
  exhausted = false;

  grounded = true;
  crouched = false;
  sprinting = false;
  moving = false;
  speed2D = 0;
  /** Set by the weapon system each frame (aiming through a scope slows you). */
  externalSpeedScale = 1;
  sprintAmount = 0; // smoothed 0..1 for FOV / sway
  crouchAmount = 0;

  bobPhase = 0;
  bobAmount = 0;
  private stepDistance = 0;
  private landDip = 0;
  private wasGrounded = true;
  private fallSpeed = 0;
  headBobEnabled = true;

  onStep: ((running: boolean, crouched: boolean) => void) | null = null;
  onLand: ((hard: boolean) => void) | null = null;
  onJump: (() => void) | null = null;

  spawn(pos: THREE.Vector3, yaw: number) {
    this.pos.copy(pos).setY(0);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.exhausted = false;
  }

  get eyeHeight() {
    return lerp(EYE_STAND, EYE_CROUCH, this.crouchAmount);
  }

  getEye(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.pos);
    out.y += this.eyeHeight;
    if (this.headBobEnabled && this.grounded) {
      const bobY = Math.sin(this.bobPhase * 2) * 0.026 * this.bobAmount;
      const bobX = Math.cos(this.bobPhase) * 0.016 * this.bobAmount;
      const fwdX = -Math.sin(this.yaw);
      const fwdZ = -Math.cos(this.yaw);
      out.x += -fwdZ * bobX;
      out.z += fwdX * bobX;
      out.y += bobY;
    }
    out.y -= this.landDip;
    return out;
  }

  /** Direction player faces (unit, XZ). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    return out;
  }

  lookDir(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    return out.normalize();
  }

  update(dt: number, input: InputState, world: World) {
    // ---- crouch state
    const wantCrouch = input.crouch;
    this.crouched = wantCrouch;
    this.crouchAmount = lerp(this.crouchAmount, wantCrouch ? 1 : 0, 1 - Math.pow(0.0001, dt));

    // ---- desired move direction (camera relative)
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3();
    if (input.forward) wish.add(fwd);
    if (input.back) wish.sub(fwd);
    if (input.right) wish.add(right);
    if (input.left) wish.sub(right);
    const hasInput = wish.lengthSq() > 0;
    if (hasInput) wish.normalize();
    this.moving = hasInput;

    // ---- sprint logic
    const forwardish = input.forward && !input.back;
    const wantSprint = input.sprint && forwardish && hasInput && !this.crouched && !this.exhausted && this.stamina > 1;
    this.sprinting = wantSprint && this.grounded;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - 21 * dt);
      this.staminaRegenDelay = 0.9;
      if (this.stamina <= 0) this.exhausted = true;
    } else {
      if (this.staminaRegenDelay > 0) this.staminaRegenDelay -= dt;
      else this.stamina = Math.min(this.maxStamina, this.stamina + (this.crouched ? 18 : 14) * dt);
      if (this.exhausted && this.stamina > 26) this.exhausted = false;
    }
    this.sprintAmount = lerp(this.sprintAmount, this.sprinting ? 1 : 0, 1 - Math.pow(0.001, dt));

    // ---- speeds
    let maxSpeed = 4.3;
    if (this.crouched) maxSpeed = 2.1;
    else if (this.sprinting) maxSpeed = 6.9;
    maxSpeed *= this.externalSpeedScale;
    const accel = this.grounded ? 11 : 2.2;
    const targetVX = wish.x * maxSpeed;
    const targetVZ = wish.z * maxSpeed;
    const blend = 1 - Math.exp(-accel * dt);
    this.vel.x += (targetVX - this.vel.x) * blend;
    this.vel.z += (targetVZ - this.vel.z) * blend;

    // ---- gravity / jump
    if (this.grounded && input.jump && !this.crouched) {
      this.vel.y = 7.4;
      this.grounded = false;
      this.onJump?.();
    }
    this.vel.y -= 21 * dt;
    if (this.vel.y < -26) this.vel.y = -26;
    this.fallSpeed = -this.vel.y;

    // ---- integrate + collide
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      if (!this.wasGrounded && this.fallSpeed > 3) {
        this.landDip = clamp(this.fallSpeed * 0.016, 0.03, 0.16);
        this.onLand?.(this.fallSpeed > 10);
      }
      this.vel.y = 0;
      this.grounded = true;
    } else if (this.pos.y > 0.02) {
      this.grounded = false;
    }
    this.wasGrounded = this.grounded;
    world.collide(this.pos, this.radius, false, this.eyeHeight + 0.15);

    this.speed2D = Math.hypot(this.vel.x, this.vel.z);

    // ---- head bob + steps
    const speedFactor = clamp(this.speed2D / 4.3, 0, 1.6);
    this.bobAmount = lerp(this.bobAmount, this.grounded && this.speed2D > 0.4 ? speedFactor : 0, 1 - Math.pow(0.001, dt));
    if (this.grounded && this.speed2D > 0.4) {
      this.bobPhase += dt * (4.4 + this.speed2D * 0.95);
      this.stepDistance += this.speed2D * dt;
      const stride = this.sprinting ? 3.1 : this.crouched ? 1.6 : 2.3;
      if (this.stepDistance > stride) {
        this.stepDistance = 0;
        this.onStep?.(this.sprinting, this.crouched);
      }
    }
    this.landDip = lerp(this.landDip, 0, 1 - Math.pow(0.0005, dt));
  }

  /** Noise radius the player currently emits (for enemy hearing). */
  noiseRadius(): number {
    if (this.speed2D < 0.4) return 0;
    if (this.crouched) return 2.5;
    if (this.sprinting) return 13;
    return 5;
  }
}
