import * as THREE from 'three';
import { FURNITURE_PARTS, furnitureTransform, type FurnitureKind } from './furniture';
import { PropCollisionIndex } from './propCollision';

let checked = false;
const UNIT = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`[PROPS] ${message}`);
}

function close(a: number, b: number, message: string) {
  assert(Math.abs(a - b) < 0.00002, `${message}: ${a} != ${b}`);
}

/** Runs once in development; no renderer or audio context is required. */
export function runPropRegressionChecks() {
  if (checked) return;
  const tableLegs = FURNITURE_PARTS.table.filter((p) => p.name.startsWith('table leg '));
  const chairLegs = FURNITURE_PARTS.chair.filter((p) => /^chair (front|rear) leg /.test(p.name));
  assert(tableLegs.length === 4, 'Tables must have four legs');
  assert(chairLegs.length === 4, 'Chairs must keep all four legs, including when tipped');

  for (const yaw of [0, 0.37, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    for (const kind of ['table', 'chair', 'shelf'] as FurnitureKind[]) {
      for (const tipped of kind === 'chair' ? [false, true] : [false]) {
        const root = furnitureTransform(kind, 14, 25, yaw, tipped);
        const bounds = new THREE.Box3();
        for (const part of FURNITURE_PARTS[kind]) bounds.union(UNIT.clone().applyMatrix4(root.clone().multiply(part.matrix)));
        close(bounds.min.y, 0, `${kind} must sit on the floor at rotation ${yaw}`);
      }
    }
    const root = furnitureTransform('table', 14, 25, yaw);
    const inverse = root.clone().invert();
    const tabletop = FURNITURE_PARTS.table.find((p) => p.name === 'tabletop')!;
    const topBounds = UNIT.clone().applyMatrix4(tabletop.matrix);
    for (const leg of tableLegs) {
      const world = root.clone().multiply(leg.matrix);
      const localCenter = new THREE.Vector3().setFromMatrixPosition(world).applyMatrix4(inverse);
      close(Math.abs(localCenter.x), 0.84, 'Leg X offset must follow the tabletop rotation');
      close(Math.abs(localCenter.z), 0.365, 'Leg Z offset must follow the tabletop rotation');
      const upperEnd = new THREE.Vector3(0, 0.5, 0).applyMatrix4(world).applyMatrix4(inverse);
      assert(upperEnd.y >= topBounds.min.y && upperEnd.y <= topBounds.max.y, 'Every table leg must meet the underside');
      assert(topBounds.containsPoint(upperEnd), 'No table leg may detach from its top');
    }

    // Compare custom collisions directly with Three's triangle raycaster.
    const rootGroup = new THREE.Group();
    rootGroup.position.set(14, 0, 25);
    rootGroup.rotation.y = yaw;
    const geometry = new THREE.BoxGeometry(1.7, 1.15, 0.95);
    const material = new THREE.MeshBasicMaterial();
    const cabinet = new THREE.Mesh(geometry, material);
    cabinet.position.y = 0.575;
    rootGroup.add(cabinet);
    const index = new PropCollisionIndex();
    const collider = index.addMesh(cabinet, rootGroup.uuid);
    close(collider.bounds.min.y, 0, 'Machine body must be grounded, not raised by its parent');

    const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const source = new THREE.Vector3(14, 0.9, 25).addScaledVector(normal, 3);
    const direction = normal.clone().negate();
    const meshHit = new THREE.Raycaster(source, direction, 0, 6).intersectObject(cabinet)[0];
    const propHit = index.raycast(source, direction, 6);
    assert(!!meshHit && !!propHit, 'Panel must have a visible and physical ray hit');
    close(propHit!.dist, meshHit.distance, 'Panel ray hit must match the rendered surface');
    const miss = source.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw), 1.3);
    assert(index.raycast(miss, direction, 6) === null, 'No invisible panel collider beyond the model');

    const player = new THREE.Vector3(14, 0, 25).addScaledVector(normal, 0.475 + 0.36 - 0.03);
    index.collide(player, 0.36);
    const localPlayer = rootGroup.worldToLocal(player.clone());
    close(localPlayer.z, 0.475 + 0.36, 'Movement must stop one player radius from the visible panel');
    assert(!index.overlapsCircle(player.x, player.z, 0.36), 'Resolution must leave no residual overlap');
    assert(index.raycast(source, direction, 6, rootGroup.uuid) === null, 'A control must not occlude its own interaction prompt');

    // Ignoring the selected control must never ignore another solid object.
    const blocker = new THREE.Matrix4().compose(
      new THREE.Vector3(14, 1, 25).addScaledVector(normal, 1.5),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
      new THREE.Vector3(0.8, 2, 0.1),
    );
    index.add(blocker, UNIT, 'other-object', 'occluding panel');
    assert(index.raycast(source, direction, 6, rootGroup.uuid) !== null, 'Controls must still respect other geometry');
    geometry.dispose();
    material.dispose();
  }

  const shelfIndex = new PropCollisionIndex();
  const shelfRoot = furnitureTransform('shelf', 16, 20, Math.PI / 2);
  for (const part of FURNITURE_PARTS.shelf) {
    if (part.solid) shelfIndex.add(shelfRoot.clone().multiply(part.matrix), UNIT, 'shelf', part.name);
  }
  assert(shelfIndex.overlapsCircle(16, 20.7, 0.3), 'Quarter-turned shelves must block their visible long axis');
  assert(!shelfIndex.overlapsCircle(16.9, 20, 0.3), 'Quarter-turned shelves must not retain an unrotated hitbox');

  const tableIndex = new PropCollisionIndex();
  const tableRoot = furnitureTransform('table', 20, 24, 0);
  for (const part of FURNITURE_PARTS.table) {
    if (part.solid) tableIndex.add(tableRoot.clone().multiply(part.matrix), UNIT, 'table', part.name);
  }
  assert(!tableIndex.segmentClear(new THREE.Vector3(17, 0, 24), new THREE.Vector3(23, 0, 24)), 'Navigation cannot cut through a table');
  assert(tableIndex.segmentClear(new THREE.Vector3(17, 0, 25.3), new THREE.Vector3(23, 0, 25.3)), 'Navigation can pass beside a table');
  assert(tableIndex.raycast(new THREE.Vector3(20, 2, 24), new THREE.Vector3(0, -1, 0), 3) !== null, 'Vertical rays must hit the tabletop');
  checked = true;
}