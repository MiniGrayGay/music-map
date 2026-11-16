export const ORBIT_RADIUS = 1.53;
const TILT = .59 / ORBIT_RADIUS;
const ROLL = Math.atan2(.319, .948);
const cosRoll = Math.cos(ROLL);
const sinRoll = Math.sin(ROLL);
const intoScreen = Math.sqrt(1 - TILT * TILT);

const major = [cosRoll, sinRoll, 0];
const minor = [sinRoll * TILT, -cosRoll * TILT, -intoScreen];

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

const north = cross(major, minor);

export function orbitDirection(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return major.map((axis, i) => axis * c + minor[i] * s);
}

export function lockedMoonBasis(outward) {
  // Lunar longitude 0 faces the planet. The rotation axis is normal to the orbital plane.
  const nearSide = outward.map((axis) => -axis);
  const east = cross(north, nearSide);
  return {
    right: [east[0], north[0], nearSide[0]],
    up: [east[1], north[1], nearSide[1]],
    front: [east[2], north[2], nearSide[2]],
  };
}
