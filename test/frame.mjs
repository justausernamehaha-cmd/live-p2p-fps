// The player's frame, in node — no browser, no server, like solid.mjs and
// portal.mjs. Run it first: it takes no time and it is the thing every other
// piece of movement is built on.
//
// The one claim that matters: at the ordinary up this must be *exactly* the
// basis the game has always used. Everything else in the codebase — the camera,
// the tests that check W goes where the camera looks — is written against that
// closed form, so it is asserted against it here rather than against itself.

import {
  UPS, UP_Y, upIndex, upFromIndex, snapAxis, snapUp, axisKey, axisSign, crossKeys,
  basisFor, lookFrom, anglesIn, dot3
} from '../src/frame.js';

// The first six are the world axes; the rest sit at 45 degrees between two of
// them. Some claims are only about the six.
const AXES = UPS.slice(0, 6);

let fail = [];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const want = (name, ok) => { if (!ok) fail.push(name); };

// ------------------------------------------------- the ordinary up is unchanged
for (let i = 0; i < 16; i++) {
  const yaw = -Math.PI + (i / 16) * 2 * Math.PI;
  const { f, r } = basisFor(UP_Y, yaw);
  want(`forward at yaw ${yaw.toFixed(2)}`,
    near(f.x, -Math.sin(yaw)) && near(f.y, 0) && near(f.z, -Math.cos(yaw)));
  want(`right at yaw ${yaw.toFixed(2)}`,
    near(r.x, Math.cos(yaw)) && near(r.y, 0) && near(r.z, -Math.sin(yaw)));
  for (const pitch of [-1.2, -0.3, 0, 0.5, 1.4]) {
    const d = lookFrom(UP_Y, yaw, pitch);
    want('look matches the camera',
      near(d.x, -Math.sin(yaw) * Math.cos(pitch)) &&
      near(d.y, Math.sin(pitch)) &&
      near(d.z, -Math.cos(yaw) * Math.cos(pitch)));
  }
}

// ------------------------------------------------------ every frame is a frame
for (const up of UPS) {
  for (let i = 0; i < 8; i++) {
    const yaw = (i / 8) * 2 * Math.PI - Math.PI;
    const { f, r } = basisFor(up, yaw);
    want('forward is a unit vector', near(Math.hypot(f.x, f.y, f.z), 1, 1e-12));
    want('right is a unit vector', near(Math.hypot(r.x, r.y, r.z), 1, 1e-12));
    want('forward is flat', near(dot3(f, up), 0, 1e-12));
    want('right is flat', near(dot3(r, up), 0, 1e-12));
    want('forward and right are square', near(dot3(f, r), 0, 1e-12));
    // right-handed the same way the ordinary frame is: f x r = -up
    const fx = { x: f.y * r.z - f.z * r.y, y: f.z * r.x - f.x * r.z, z: f.x * r.y - f.y * r.x };
    want('the frame is not mirrored',
      near(fx.x, -up.x, 1e-12) && near(fx.y, -up.y, 1e-12) && near(fx.z, -up.z, 1e-12));
  }
}

// ------------------------------------------------------------ angles round-trip
for (const up of UPS) {
  for (const yaw of [-3, -1.1, 0, 0.7, 2.9]) {
    for (const pitch of [-1.4, -0.2, 0, 0.9]) {
      const a = anglesIn(up, lookFrom(up, yaw, pitch));
      const dy = Math.abs(((a.yaw - yaw + Math.PI) % (2 * Math.PI)) - Math.PI);
      want(`yaw round-trips at up ${upIndex(up)}`, dy < 1e-9);
      want(`pitch round-trips at up ${upIndex(up)}`, near(a.pitch, pitch, 1e-9));
    }
  }
}

// ------------------------------------------------------------------- the rest
want('index round-trips', UPS.every((u, i) => upFromIndex(upIndex(u)) === UPS[i]));
want('a bad index is the ordinary up', upFromIndex(99) === UP_Y && upFromIndex(-1) === UP_Y);
want('snap takes the nearest axis',
  snapAxis({ x: 0.1, y: 0.9, z: -0.2 }) === UPS[2] &&
  snapAxis({ x: -0.8, y: 0.1, z: 0.3 }) === UPS[1] &&
  snapAxis({ x: 0, y: -0.4, z: -0.5 }) === UPS[5]);
want('an exact axis snaps to itself', AXES.every(u => snapAxis(u) === u));
want('...and snapUp leaves every one of the eighteen alone', UPS.every(u => snapUp(u) === u));
want('snapUp takes a 45-degree image at 45 degrees',
  snapUp({ x: 0.7, y: 0.72, z: 0.02 }) === UPS.find(u => u.x > 0.7 && u.y > 0.7) &&
  snapUp({ x: 0.02, y: -0.71, z: 0.7 }) === UPS.find(u => u.y < -0.7 && u.z > 0.7));
want('snapUp still prefers an axis when the direction is one',
  snapUp({ x: 0.05, y: 0.99, z: -0.02 }) === UPS[2]);
want('keys and signs', axisKey(UPS[0]) === 'x' && axisSign(UPS[1]) === -1 &&
  crossKeys(UPS[2]).join('') === 'xz' && crossKeys(UPS[4]).join('') === 'xy');
want('a tilted up has no world axis',
  UPS.slice(6).every(u => axisKey(u) === null && crossKeys(u) === null && axisSign(u) === 0));
want('north is square to every up',
  UPS.every(u => Math.abs(dot3(u, basisFor(u, 0).f)) < 1e-12));

console.log(fail.length ? 'FAIL: ' + fail.join('; ')
                        : `${UPS.length * 8 + 16} frames ok\nframe.js OK`);
process.exit(fail.length ? 1 : 0);
