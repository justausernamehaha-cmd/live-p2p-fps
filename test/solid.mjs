// The convex-solid layer, checked without a browser — the only suite here that
// needs no server and no Chromium, and therefore the first one to run.
//
//   node test/solid.mjs
import {
  makeSolid, rayConvex, capsulePush, eulerMatrix, eulerFromMatrix,
  matMul, axisMatrix, SHAPE_SLOPE
} from '../src/solid.js';
const ok = [], bad = [];
const t = (name, cond, extra='') => (cond ? ok : bad).push(name + (extra ? ' ' + extra : ''));

// an unrotated unit box behaves exactly like the AABB it is
const box = makeSolid({ x0:-1,y0:0,z0:-1, x1:1,y1:2,z1:1, shape:0 });
t('box aabb', JSON.stringify(box.min)==='{"x":-1,"y":0,"z":-1}' && JSON.stringify(box.max)==='{"x":1,"y":2,"z":1}', JSON.stringify([box.min,box.max]));
t('box has 6 planes', box.planes.length===6);
t('all normals point out', box.planes.every(p => {
  const c = box.centre; return p.nx*c.x + p.ny*c.y + p.nz*c.z < p.d - 1e-9; }));
const r1 = rayConvex({x:0,y:1,z:-5},{x:0,y:0,z:1}, box);
t('ray hits box front', r1 && Math.abs(r1.t-4)<1e-6, r1 && r1.t);
t('ray misses beside box', rayConvex({x:5,y:1,z:-5},{x:0,y:0,z:1}, box)===null);

// a capsule standing on top of the box is pushed straight up out of it
const push = capsulePush(0, 1.9+0.17, 0, 0, 1.9+1.8-0.17, 0, 0.17, box);
t('capsule sunk in the top is pushed up', push && push.n.ny>0.9 && Math.abs(push.depth-0.10)<0.02, push && JSON.stringify([push.depth, push.n.ny]));
t('capsule clear above is not pushed', capsulePush(0,2.5,0, 0,4,0, 0.17, box)===null);

// a slope: half a box, and standing halfway along it is half height
const slope = makeSolid({ x0:-2,y0:0,z0:-2, x1:2,y1:2,z1:2, shape:SHAPE_SLOPE });
t('slope has 5 faces', slope.planes.length===5, slope.planes.length);
const ramp = slope.planes.find(p => p.ny>0.1 && Math.abs(p.nx)>0.1);
t('the ramp face leans', !!ramp, ramp && JSON.stringify(ramp));
// straight down onto the middle of the ramp: local x=0 is half height, y=1
const down = rayConvex({x:0,y:9,z:0},{x:0,y:-1,z:0}, slope);
t('ramp is half height at its middle', down && Math.abs((9-down.t)-1)<1e-6, down && (9-down.t));
const lowEnd = rayConvex({x:-1.9,y:9,z:0},{x:0,y:-1,z:0}, slope);
t('ramp is low at the low end', lowEnd && (9-lowEnd.t) < 0.15, lowEnd && (9-lowEnd.t));
const highEnd = rayConvex({x:1.9,y:9,z:0},{x:0,y:-1,z:0}, slope);
t('ramp is tall at the tall end', highEnd && (9-highEnd.t) > 1.85, highEnd && (9-highEnd.t));

// euler round trip, including a composed rotation
for (const e of [[0,0,0],[0,Math.PI/2,0],[0.3,-1.1,2.0],[1.2,0.4,-0.7]]) {
  const back = eulerFromMatrix(eulerMatrix(...e));
  const m1 = eulerMatrix(...e), m2 = eulerMatrix(...back);
  let same = true;
  for (let r=0;r<3;r++) for (let c=0;c<3;c++) if (Math.abs(m1[r][c]-m2[r][c])>1e-9) same=false;
  t('euler round trip '+e.join(','), same, JSON.stringify(back.map(v=>+v.toFixed(3))));
}
// rotating a box 90 degrees about Y swaps its x and z extents
const rot = makeSolid({ x0:-3,y0:0,z0:-1, x1:3,y1:2,z1:1, shape:0, ry:Math.PI/2 });
t('a 90 degree turn swaps the footprint',
  Math.abs(rot.max.x-1)<1e-9 && Math.abs(rot.max.z-3)<1e-9, JSON.stringify([rot.min,rot.max]));
// composing rotations through the matrix and back is stable
const composed = eulerFromMatrix(matMul(axisMatrix(1, Math.PI/2), eulerMatrix(0,Math.PI/2,0)));
t('two 90s about Y make 180', Math.abs(Math.abs(composed[1]) - 0) < 1e-9 || Math.abs(Math.abs(composed[2]) - Math.PI) < 1e-6 || Math.abs(Math.abs(composed[1])-Math.PI)<1e-6, JSON.stringify(composed.map(v=>+v.toFixed(3))));

console.log(ok.length + ' ok');
if (bad.length) { console.log('FAILED:'); bad.forEach(b=>console.log('  '+b)); process.exit(1); }
console.log('solid.js OK');
