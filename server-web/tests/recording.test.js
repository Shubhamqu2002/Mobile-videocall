import { test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { createApp } from "../server/app.js";
import fs from "node:fs/promises";
const once = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: ${event}`)),
      4000
    );
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
// Tests recorder access control and storage lifecycle. This fake browser does
// NOT test actual WebRTC transport, Chrome composition or media encoding.
test("recorder rejects unauthorized/absent consent and stops on revocation; capability downloads are private", async () => {
  let closed = false,
    hooks = {},
    outputPath;
  const fakeLauncher = async () => ({
    newPage: async () => ({
      exposeFunction: async (name, fn) => {
        hooks[name] = fn;
      },
      on: () => {},
      isClosed: () => false,
      goto: async () => {
        await hooks.writeChunk(
          Buffer.from("TEST DATA: NOT A MEDIA FILE").toString("base64")
        );
        await hooks.recorderReady();
      },
      evaluate: async () => {},
    }),
    close: async () => {
      closed = true;
    },
  });
  const service = createApp({ MAX_ROOM_PARTICIPANTS: "2", STUN_URL: "", recorderLauncher: fakeLauncher });
  await new Promise((r) => service.http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${service.http.address().port}`,
    sockets = [];
  async function connect() {
    const s = io(url, { transports: ["websocket"], reconnection: false });
    sockets.push(s);
    await once(s, "connect");
    return s;
  }
  try {
    const a = await connect(),
      b = await connect(),
      outsider = await connect();
    assert.match(
      (await outsider.emitWithAck("recording-start", {})).error,
      /At least two participants/
    );
    assert.match(
      (
        await outsider.emitWithAck("recorder-join", {
          id: "fake",
          token: "fake",
        })
      ).error,
      /Unauthorized/
    );
    const room = await fetch(`${url}/api/rooms`, { method: "POST" }).then((r) =>
      r.json()
    );
    await a.emitWithAck("join", { ...room, name: "Alice", consent: true });
    assert.match(
      (await a.emitWithAck("recording-start", {})).error,
      /At least two participants/
    );
    await b.emitWithAck("join", { ...room, name: "Bob", consent: false });
    assert.match(
      (await a.emitWithAck("recording-start", {})).error,
      /At least two participants/
    );
    const roster = once(a, "peers");
    b.emit("media", { consent: true });
    await roster;
    const started = once(a, "recording-state");
    assert.equal((await a.emitWithAck("recording-start", {})).ok, true);
    assert.equal((await started).status, "starting");
    await new Promise((r) => setTimeout(r, 100));
    outputPath = service.rooms.get(room.roomId).recording.path;
    assert.match(
      (await b.emitWithAck("recording-start", {})).error,
      /already active/
    );
    let leaked = false;
    outsider.on("recording-ready", () => {
      leaked = true;
    });
    const ready = once(a, "recording-ready");
    b.emit("media", { consent: false });
    const result = await ready;
    assert.equal(closed, true);
    assert.equal(leaked, false);
    assert.equal((await fetch(`${url}/recordings/unknown`)).status, 404);
    const file = await fetch(url + result.url);
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-disposition"), /attachment/);
    assert.equal(await file.text(), "TEST DATA: NOT A MEDIA FILE");
    assert.equal(service.rooms.get(room.roomId).recording, null);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await service.close();
    if (outputPath) await fs.rm(outputPath, { force: true });
  }
});
