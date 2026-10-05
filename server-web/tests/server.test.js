import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createApp } from '../server/app.js';
import { createHmac } from 'node:crypto';

const once = (socket, event) => new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error(`Timeout: ${event}`)), 3000); socket.once(event, data => { clearTimeout(timeout); resolve(data); }); });
test('rooms authorize members, cap occupancy, isolate signaling, validate chat and issue TURN credentials', async () => {
  const origin = 'http://localhost:5173';
  const service = createApp({ ALLOWED_ORIGINS: origin, TURN_URLS: 'turn:turn.example.test:3478', TURN_SECRET: 'test-only-secret', STUN_URL: '', ICE_TRANSPORT_POLICY: 'relay' });
  await new Promise(r => service.http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${service.http.address().port}`;
  const sockets = [];
  async function connect() {
    const s = io(url, { transports: ['websocket'], extraHeaders: { Origin: origin }, reconnection: false });
    sockets.push(s); await once(s, 'connect'); return s;
  }
  const join = (s, room, name = 'Tester') => s.timeout(3000).emitWithAck('join', { ...room, name, consent: true });
  const create = async () => { const r = await fetch(`${url}/api/rooms`, { method: 'POST', headers: { Origin: origin } }); assert.equal(r.status, 201); return r.json(); };
  try {
    assert.equal((await fetch(`${url}/api/health`).then(r => r.json())).ok, true);
    assert.equal((await fetch(`${url}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
    const polling = io(url, { transports: ['polling'], reconnection: false });
    sockets.push(polling); await once(polling, 'connect'); polling.disconnect();
    const room = await create(), other = await create();
    const a = await connect(), b = await connect(), c = await connect(), d = await connect();
    assert.match((await join(c, { ...room, roomKey: 'wrong' })).error, /invalid/);
    const joined = await join(a, room, 'Alice');
    assert.equal(joined.ok, true);
    assert.equal(joined.rtcConfig.iceTransportPolicy, 'relay');
    const turn = joined.rtcConfig.iceServers[0];
    assert.equal(turn.credential, createHmac('sha1', 'test-only-secret').update(turn.username).digest('base64'));
    assert.equal((await join(b, room, 'Bob')).ok, true);
    assert.match((await join(c, room)).error, /full/);
    assert.equal((await join(d, other, 'Other room')).ok, true);
    const signal = once(b, 'signal');
    a.emit('signal', { to: b.id, payload: { description: { type: 'offer', sdp: 'test' } } });
    assert.equal((await signal).from, a.id);
    let leaked = false;
    d.on('signal', () => { leaked = true; });
    a.emit('signal', { to: d.id, payload: { candidate: { candidate: 'test' } } });
    await new Promise(r => setTimeout(r, 100));
    assert.equal(leaked, false);
    assert.match((await a.emitWithAck('chat', { text: 'x'.repeat(2001) })).error, /2,000/);
    const message = once(b, 'chat');
    assert.equal((await a.emitWithAck('chat', { text: '<script>alert(1)</script>' })).ok, true);
    assert.equal((await message).name, 'Alice');
    const consent = once(a, 'peers'); b.emit('media', { consent: false, recording: true });
    const roster = await consent;
    assert.equal(roster.find(p => p.id === b.id).recording, false);
    const departure = once(a, 'peers'); b.disconnect(); await departure;
    assert.equal((await join(c, room, 'Replacement')).ok, true);
  } finally { sockets.forEach(s => s.disconnect()); await service.close(); }
});
