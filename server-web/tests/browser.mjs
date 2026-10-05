import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createApp } from '../server/app.js';

// Uses real RTCPeerConnections with fake camera/mic devices and a synthetic
// display-capture source. OS screen-picker permissions still need manual testing.
const origin = 'http://localhost:4178';
const service = createApp({ ALLOWED_ORIGINS: origin, STUN_URL: '', TURN_URLS: '', TURN_SECRET: '', ICE_TRANSPORT_POLICY: 'all', RECORDER_TEST_NO_SANDBOX: 'true', RECORDER_TEST_LOOPBACK: 'true', CHROME_PATH: process.env.TEST_CHROME });
await new Promise(resolve => service.http.listen(4178, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_CHROME || undefined, args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
let p1, p2;
await fs.mkdir('test-results', { recursive: true });
try {
  const a = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] });
  const b = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] });
  for (const context of [a, b]) await context.addInitScript(({ failCamera }) => {
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__failCamera = failCamera;
    window.__firstCameraAttempt = true;
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (constraints.video && (window.__failCamera || window.__firstCameraAttempt)) {
        window.__firstCameraAttempt = false;
        throw new DOMException('Could not start video source', 'NotReadableError');
      }
      return getMedia(constraints);
    };
    const Native = window.RTCPeerConnection;
    window.__testPeers = [];
    window.RTCPeerConnection = class extends Native {
      constructor(config) { super(config); window.__testPeers.push(this); }
    };
  }, { failCamera: process.env.TEST_CAMERA_FAILURE === '1' });
  await a.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#31573c'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(`Test presentation ${Date.now()}`, 80, 300); };
      draw(); const timer = setInterval(draw, 80); const stream = canvas.captureStream(15);
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  });
  p1 = await a.newPage(); p2 = await b.newPage();
  for (const page of [p1, p2]) page.on('pageerror', error => errors.push(error.message));
  await p1.goto(origin);
  await p1.screenshot({ path: 'test-results/lobby.png', fullPage: true });
  for (const width of [360, 768, 1024]) {
    await p1.setViewportSize({ width, height: 900 });
    assert.equal(await p1.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p1.screenshot({ path: `test-results/lobby-${width}.png`, fullPage: true });
  }
  await p1.setViewportSize({ width: 1440, height: 1000 });
  await p1.getByLabel('Your name', { exact: true }).fill('Alice');
  await p1.getByRole('checkbox', { name: /Allow in-app recording/ }).check();
  await p1.getByRole('button', { name: 'Create a room' }).click();
  await p1.getByRole('button', { name: 'Copy invite' }).waitFor();
  const invite = p1.url();
  await p2.goto(invite);
  await p2.getByLabel('Your name', { exact: true }).fill('Bob');
  await p2.getByRole('checkbox', { name: /Allow in-app recording/ }).check();
  await p2.getByRole('button', { name: 'Join room', exact: true }).click();
  await p1.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
  await p2.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
  if (process.env.TEST_CAMERA_FAILURE === '1') {
    for (const page of [p1, p2]) {
      await page.getByText('Camera unavailable — room opened with audio only.', { exact: true }).waitFor();
      await page.evaluate(() => { window.__failCamera = false; });
      await page.getByRole('button', { name: 'Apply / retry camera', exact: true }).click();
      await page.getByText('Camera unavailable — room opened with audio only.', { exact: true }).waitFor({ state: 'detached' });
    }
  }
  await p2.waitForFunction(() => document.querySelectorAll('.video-grid video')[1]?.videoWidth > 0);
  for (const page of [p1, p2]) await page.waitForFunction(async () => {
    const report = await window.__testPeers.at(-1).getStats();
    return [...report.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.packetsReceived > 0);
  });
  await p1.getByLabel('Message', { exact: true }).fill('Hello from Alice');
  await p1.getByRole('button', { name: 'Send message' }).click();
  await p2.getByText('Hello from Alice', { exact: true }).waitFor();
  await p1.getByRole('button', { name: 'Mute mic', exact: true }).click();
  await p1.getByRole('button', { name: 'Unmute mic', exact: true }).waitFor();
  await p1.getByRole('button', { name: 'Unmute mic', exact: true }).click();
  await p1.getByRole('button', { name: 'Camera off', exact: true }).click();
  await p2.getByText('Camera is off', { exact: true }).waitFor();
  await p1.getByRole('button', { name: 'Camera on', exact: true }).click();
  await p1.getByRole('button', { name: 'Share screen', exact: true }).click();
  await p2.getByText("Alice's screen", { exact: true }).waitFor();
  await p2.waitForFunction(() => document.querySelector('.screen-grid video')?.videoWidth > 0);
  await p1.getByRole('button', { name: 'Record call', exact: true }).click();
  await p1.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
  await p2.getByText(/Server recording active/).waitFor({timeout: 40000});
  await p1.waitForTimeout(2200);
  await p1.screenshot({ path: 'test-results/call.png', fullPage: true });
  await p1.setViewportSize({ width: 390, height: 844 });
  assert.equal(await p1.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await p1.screenshot({ path: 'test-results/call-mobile.png', fullPage: true });
  await p1.setViewportSize({ width: 1440, height: 1000 });
  await p2.getByRole('checkbox', { name: 'Allow recording', exact: true }).uncheck();
  const file = p1.getByRole('link', { name: /Download call-/ });
  await file.waitFor();
  const downloadEvent = p1.waitForEvent('download'); await file.click();
  const download = await downloadEvent; await download.saveAs('test-results/recording.webm');
  assert.ok((await fs.stat('test-results/recording.webm')).size > 1000);
  assert.equal(await p1.getByRole('button', { name: 'Record call', exact: true }).isDisabled(), true);
  await p1.getByRole('button', { name: 'Stop sharing', exact: true }).click();
  await p2.getByText("Alice's screen", { exact: true }).waitFor({ state: 'detached' });
  await p1.getByRole('button', { name: 'Reconnect media' }).click();
  await p1.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
  await p2.getByRole('button', { name: 'Leave call', exact: true }).click();
  await p1.getByText('Waiting for another participant', { exact: true }).waitFor();
  await p2.getByRole('button', { name: 'Join room', exact: true }).click();
  await p1.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
  await p1.getByRole('button', { name: 'Leave call', exact: true }).click();
  await p1.setViewportSize({ width: 390, height: 844 });
  await p1.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.equal(await p1.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(`PASS (${process.env.TEST_CAMERA_FAILURE === '1' ? 'camera locked -> audio-only room -> camera recovery' : 'initial camera failure -> relaxed capture retry'}): two-peer media, chat, mic/camera, synthetic screen sharing, recording download, recording revocation, ICE restart, leave/rejoin, mobile layout; no page errors.`);
} catch (error) {
  for (const [index, page] of [p1, p2].entries()) if (page) {
    console.error(`Participant ${index + 1}:`, await page.locator('body').innerText());
    console.error('Peer states:', await page.evaluate(() => (window.__testPeers || []).map(p => ({ signaling: p.signalingState, ice: p.iceConnectionState, gathering: p.iceGatheringState, connection: p.connectionState, local: p.localDescription?.type, remote: p.remoteDescription?.type, transceivers: p.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, current: t.currentDirection })) }))));
    await page.screenshot({ path: `test-results/failure-${index + 1}.png`, fullPage: true });
  }
  console.error('Page errors:', errors);
  throw error;
} finally { await browser.close(); await service.close(); }
