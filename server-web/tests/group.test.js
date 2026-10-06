import {test} from 'node:test';
import assert from 'node:assert/strict';
import {io} from 'socket.io-client';
import {createApp} from '../server/app.js';
import fs from 'node:fs/promises';

const event = (socket, name) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timeout: ${name}`)), 4000);
  socket.once(name, value => { clearTimeout(timeout); resolve(value); });
});
const waitFor = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Condition timed out');
};
test('five-person room: CORS, version gate, isolated signaling, chat, capacity and rejoin', async () => {
  const origin = 'http://localhost:5173';
  const service = createApp({MAX_ROOM_PARTICIPANTS: '5', ALLOWED_ORIGINS: origin});
  await new Promise(resolve => service.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.http.address().port}`;
  const sockets = [];
  const connect = async index => {
    const socket = io(base, {transports: index % 2 ? ['polling'] : ['websocket'], reconnection: false});
    sockets.push(socket); await event(socket, 'connect'); return socket;
  };
  try {
    const preflight = await fetch(base + '/api/rooms', {method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
    }});
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const room = await fetch(base + '/api/rooms', {method: 'POST'}).then(r => r.json());
    const join = (socket, name, extra = {}) => socket.timeout(3000).emitWithAck('join', {...room, name, consent: true, protocolVersion: 2, ...extra});
    for (let i = 0; i < 7; i++) await connect(i);
    assert.match((await join(sockets[6], 'Legacy', {protocolVersion: 1})).error, /Update/);
    for (let i = 0; i < 5; i++) assert.equal((await join(sockets[i], `Person ${i}`)).ok, true);
    assert.equal(service.rooms.get(room.roomId).members.size, 5);
    assert.match((await join(sockets[5], 'Full')).error, /full/);
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
      const receiving = event(sockets[j], 'signal');
      sockets[i].emit('signal', {to: sockets[j].id, payload: {restart: true}});
      assert.equal((await receiving).from, sockets[i].id);
    }
    const messages = sockets.slice(1, 5).map(socket => event(socket, 'chat'));
    assert.equal((await sockets[0].emitWithAck('chat', {text: 'Group hello'})).ok, true);
    assert.ok((await Promise.all(messages)).every(m => m.text === 'Group hello'));
    let leaked = false;
    sockets[6].on('signal', () => { leaked = true; });
    sockets[0].emit('signal', {to: sockets[6].id, payload: {restart: true}});
    const leavingId = sockets[4].id;
    sockets[4].disconnect();
    await waitFor(() => !service.rooms.get(room.roomId).members.has(leavingId));
    assert.equal((await join(sockets[5], 'Replacement')).ok, true);
    assert.equal(service.rooms.get(room.roomId).members.size, 5);
    assert.equal(leaked, false);
  } finally {
    sockets.forEach(socket => socket.disconnect()); await service.close();
  }
});

test('group recorder requires unanimous consent and stops on membership changes without sharing old download with newcomer', async () => {
  let hooks = {}, closed = 0;
  const files = [];
  const recorderLauncher = async () => ({
    newPage: async () => ({
      exposeFunction: async (name, fn) => { hooks[name] = fn; },
      on: () => {}, isClosed: () => false,
      goto: async () => { await hooks.writeChunk(Buffer.from('FAKE GROUP RECORDING').toString('base64')); await hooks.recorderReady(); },
      evaluate: async () => {},
    }),
    close: async () => { closed++; },
  });
  const service = createApp({MAX_ROOM_PARTICIPANTS: '5', recorderLauncher});
  await new Promise(resolve => service.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.http.address().port}`;
  const sockets = [];
  try {
    const room = await fetch(base + '/api/rooms', {method: 'POST'}).then(r => r.json());
    for (let i = 0; i < 5; i++) {
      const socket = io(base, {transports: ['websocket'], reconnection: false});
      sockets.push(socket); await event(socket, 'connect');
      assert.equal((await socket.emitWithAck('join', {...room, name: `Person ${i}`, protocolVersion: 2, consent: i !== 4})).ok, true);
    }
    assert.match((await sockets[0].emitWithAck('recording-start', {})).error, /everyone/);
    sockets[4].emit('media', {consent: true});
    await waitFor(() => service.rooms.get(room.roomId).members.get(sockets[4].id).consent);
    assert.equal((await sockets[0].emitWithAck('recording-start', {})).ok, true);
    await waitFor(() => service.rooms.get(room.roomId).recording?.bytes > 0);
    files.push(service.rooms.get(room.roomId).recording.path);
    let ready = event(sockets[0], 'recording-ready');
    sockets[4].emit('leave');
    await ready;
    await waitFor(() => !service.rooms.get(room.roomId).recording);
    assert.ok(closed > 0);
    assert.equal((await sockets[0].emitWithAck('recording-start', {})).ok, true);
    await waitFor(() => service.rooms.get(room.roomId).recording?.bytes > 0);
    files.push(service.rooms.get(room.roomId).recording.path);
    let leaked = false;
    sockets[4].on('recording-ready', () => { leaked = true; });
    ready = event(sockets[0], 'recording-ready');
    await sockets[4].emitWithAck('join', {...room, name: 'New arrival', consent: true, protocolVersion: 2});
    await ready;
    await waitFor(() => !service.rooms.get(room.roomId).recording);
    assert.equal(leaked, false);
  } finally {
    sockets.forEach(socket => socket.disconnect()); await service.close();
    for (const file of files) await fs.rm(file, {force: true});
  }
});

test('no configured participant cap allows twelve clients and still rejects legacy clients', async () => {
  const service = createApp({MAX_ROOM_PARTICIPANTS: '0'});
  const sockets = [];
  await new Promise(resolve => service.http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.http.address().port}`;
  try {
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.maxParticipants, 0);
    const room = await (await fetch(base + '/api/rooms', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    for(let i=0;i<12;i++) {
      const socket=io(base,{transports:['websocket'],autoConnect:false});
      sockets.push(socket);
      const connected=event(socket,'connect');socket.connect();await connected;
      const result=await socket.timeout(3000).emitWithAck('join',{...room,name:`Member ${i}`,consent:false,protocolVersion:2});
      assert.equal(result.ok,true);assert.equal(result.maxParticipants,0);
    }
    assert.equal(service.rooms.get(room.roomId).members.size,12);
    const received=event(sockets[11],'signal');
    sockets[0].emit('signal',{to:sockets[11].id,payload:{restart:true}});
    assert.equal((await received).from,sockets[0].id);
    const legacy=io(base,{transports:['websocket'],autoConnect:false});sockets.push(legacy);
    const connected=event(legacy,'connect');legacy.connect();await connected;
    assert.match((await legacy.timeout(3000).emitWithAck('join',{...room,name:'Old app',protocolVersion:1})).error,/Update/);
  } finally {for(const socket of sockets)socket.disconnect();await service.close();}
});
