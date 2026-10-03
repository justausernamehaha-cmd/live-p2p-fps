import * as THREE from 'three';

// The one gun model: the gun you see in your own hands. The first-person view
// (effects.js ViewModel) and the gun a body carries (remote.js, for peers and for
// yourself through a portal) are both built here, so everyone sees that gun.

const DEFAULT_GUN = { barrel: [0.05, 0.05, 0.42, -0.42], accent: 0xd9743b };

/** Rebuild `group` as weapon `w`'s gun: -z is forward, the stock at +z. Returns
 *  where the muzzle is. */
export function buildGun(group, w) {
  for (const c of group.children.slice()) {
    group.remove(c);
    c.geometry?.dispose();
    c.material?.dispose();
  }
  const g = (w && w.gun) || DEFAULT_GUN;
  const mk = (bw, bh, bd, color, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd),
                             new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, y, z);
    group.add(m);
    return m;
  };
  const [bw, bh, bl, bz] = g.barrel;
  mk(0.09, 0.11, 0.5, 0x2f3644, 0, 0, -0.1);             // body
  mk(bw, bh, bl, 0x1d2230, 0, 0.02, bz);                 // barrel
  mk(0.07, 0.16, 0.09, 0x232936, 0, -0.12, 0.05);        // grip
  mk(0.07, 0.09, 0.2, 0x232936, 0, -0.03, 0.2);          // stock
  // Two halves of one brick: one colour on normal guns, the owner's portal pair
  // on the portal gun, which is the only thing telling the two apart in the hand.
  const accents = [mk(0.03, 0.03, 0.14, g.accent, -0.015, 0.07, -0.12),
                   mk(0.03, 0.03, 0.14, g.accent, 0.015, 0.07, -0.12)];
  group.userData.accents = accents;
  group.userData.portal = !!g.portal;
  return { muzzle: new THREE.Vector3(0, 0.02, bz - bl / 2) };
}

/** The portal gun's accent wears its owner's pair; any other gun is left alone. */
export function paintGun(group, a, b) {
  const acc = group.userData.accents;
  if (!group.userData.portal || !acc) return;
  acc[0].material.color.setHex(a);
  acc[1].material.color.setHex(b);
}
