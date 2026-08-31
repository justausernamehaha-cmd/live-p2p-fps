// Regression: a key release must never be discarded.
//
// keyLook is applied every frame for as long as an arrow key sits in `held`,
// unlike a mouse delta which is consumed and zeroed. So a lost keyup does not
// merely feel odd, it spins the view forever. The keyup handler used to ignore
// releases whose target was a text field, which is one click into the chat box
// away from happening.
//
//   ./serve.sh 8080 &   then   node test/stuckkeys.mjs
import { chromium } from 'playwright';

const URL = process.env.GAME_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
});
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__paStarted);
await page.fill('#roominput', 'k-' + Date.now());
await page.fill('#nameinput', 'k');
await page.evaluate(() => document.getElementById('playbtn').click());
await page.waitForFunction(() => window.game.running, { timeout: 30000 });
await page.waitForTimeout(1200);

const R = await page.evaluate(async () => {
  const g = window.game, sleep = ms => new Promise(f => setTimeout(f, ms));
  const out = {};
  const chat = document.getElementById('chatinput');

  const trial = async (code, releaseOn) => {
    g.input.releaseAll();
    g.player.yaw = 0;
    dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    await sleep(200);
    // release while something else has focus, the way clicking the chat box does
    releaseOn.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    await sleep(60);
    const stuck = [...g.input.held].some(h => h.includes(code));
    const yawA = g.player.yaw;
    await sleep(500);
    const drift = Math.abs(g.player.yaw - yawA);
    return { stillHeld: stuck, driftAfterRelease: +drift.toFixed(3) };
  };

  out.arrowReleasedOverChatBox = await trial('ArrowRight', chat);
  out.arrowReleasedOverCanvas = await trial('ArrowLeft', document.getElementById('game'));
  out.wReleasedOverChatBox = await trial('KeyW', chat);

  // and losing the window must drop everything
  g.input.releaseAll();
  dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true }));
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
  await sleep(120);
  const beforeBlur = [...g.input.held].length;
  dispatchEvent(new Event('blur'));
  await sleep(120);
  out.blurClears = { heldBefore: beforeBlur, heldAfter: [...g.input.held].length };

  g.input.releaseAll();
  return out;
});

const fail = [];
if (R.arrowReleasedOverChatBox.stillHeld || R.arrowReleasedOverChatBox.driftAfterRelease > 0.01)
  fail.push('arrow released over the chat box stayed held / kept turning');
if (R.arrowReleasedOverCanvas.stillHeld) fail.push('arrow released over the canvas stayed held');
if (R.wReleasedOverChatBox.stillHeld) fail.push('W released over the chat box stayed held');
if (R.blurClears.heldAfter !== 0) fail.push('blur left keys held');

console.log(JSON.stringify(R, null, 2));
console.log('page errors:', errs.length ? errs : 'none');
console.log(fail.length ? 'FAIL: ' + fail.join('; ') : 'PASS: no key can stick');
await browser.close();
process.exit(fail.length ? 1 : 0);
