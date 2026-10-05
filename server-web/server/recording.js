import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
const base = path.dirname(fileURLToPath(import.meta.url));
const secret = () => randomBytes(24).toString("base64url");

export function installRecording({
  app,
  http,
  io,
  rooms,
  iceConfig,
  env,
  launchBrowser,
}) {
  const sessions = new Map();
  const downloads = new Map();
  const folder = path.join(base, "../recordings");
  const retention =
    Math.max(1, Number(env.RECORDING_RETENTION_HOURS) || 24) * 3600000;
  const authorized = (room) =>
    room?.members.size === 2 &&
    [...room.members.values()].every((m) => m.consent);
  const status = (s, value) =>
    io.to(s.room.id).emit("recording-state", { status: value });
  const reportError = (s, error) =>
    io
      .to(s.room.id)
      .emit("recording-error", `Server recorder: ${error.message}`);
  app.get("/recorder.html", (_req, res) =>
    res.sendFile(path.join(base, "recorder.html"))
  );
  app.get("/recorder.js", (_req, res) =>
    res.sendFile(path.join(base, "recorder.js"))
  );
  app.get("/recordings/:token", async (req, res) => {
    const item = downloads.get(req.params.token);
    if (!item || item.expires < Date.now())
      return res.status(404).send("Recording expired or unavailable.");
    res.setHeader("Cache-Control", "no-store");
    res.download(item.path, item.name);
  });
  async function stop(s, reason = "") {
    if (s.stopping) return s.stopping;
    s.cancelled = true;
    s.stopping = (async () => {
      clearTimeout(s.limit);
      clearTimeout(s.startTimeout);
      status(s, "stopping");
      io.to(s.room.id).emit("recorder-close");
      try {
        if (s.page && !s.page.isClosed())
          await Promise.race([
            s.page.evaluate(() => window.stopRecording?.()),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
        await s.writes;
      } catch (error) {
        reportError(s, error);
      }
      await s.browser?.close().catch(() => {});
      s.observer?.disconnect(true);
      sessions.delete(s.id);
      if (s.room.recording === s) s.room.recording = null;
      const size = await fs
        .stat(s.path)
        .then((x) => x.size)
        .catch(() => 0);
      if (size) {
        const key = secret(),
          name = `call-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
        const expires = Date.now() + retention;
        downloads.set(key, { path: s.path, name, expires });
        io.to(s.room.id).emit("recording-ready", {
          url: `/recordings/${key}`,
          name,
          size,
          expiresAt: expires,
        });
      } else await fs.rm(s.path, { force: true }).catch(() => {});
      status(s, "idle");
      if (reason) io.to(s.room.id).emit("recording-error", reason);
    })();
    return s.stopping;
  }
  async function launch(s) {
    try {
      await fs.mkdir(folder, { recursive: true });
      const args = [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ];
      // Test-only switch, never needed for a normal Windows desktop account.
      if (env.RECORDER_TEST_NO_SANDBOX === "true") args.push("--no-sandbox");
      if (env.RECORDER_TEST_LOOPBACK === "true")
        args.push(
          "--allow-loopback-in-peer-connection",
          "--disable-features=WebRtcHideLocalIpsWithMdns"
        );
      s.browser = await (launchBrowser || puppeteer.launch.bind(puppeteer))({
        headless: true,
        executablePath: env.CHROME_PATH || undefined,
        args,
      });
      if (s.cancelled) {
        await s.browser.close();
        return;
      }
      s.page = await s.browser.newPage();
      await s.page.exposeFunction("writeChunk", (value) => {
        const bytes = Buffer.from(value, "base64");
        if (s.bytes + bytes.length > 150 * 1024 * 1024) {
          setImmediate(() => stop(s, "Recording reached its 150 MB limit."));
          return;
        }
        s.bytes += bytes.length;
        s.writes = s.writes.then(() => fs.appendFile(s.path, bytes));
        return s.writes;
      });
      await s.page.exposeFunction("recorderReady", () => {
        if (s.cancelled || !authorized(s.room)) return;
        clearTimeout(s.startTimeout);
        status(s, "recording");
        s.limit = setTimeout(
          () => stop(s, "The 15-minute recording limit was reached."),
          15 * 60000
        );
      });
      await s.page.exposeFunction("recorderFailure", (error) => {
        setImmediate(() => stop(s, error));
      });
      s.page.on("pageerror", (error) => {
        reportError(s, error);
        void stop(s);
      });
      s.startTimeout = setTimeout(
        () =>
          stop(
            s,
            "Recorder media did not connect. Check TURN and server network access."
          ),
        35000
      );
      await s.page.goto(
        `http://127.0.0.1:${http.address().port}/recorder.html#${s.id}:${
          s.token
        }`,
        { waitUntil: "load" }
      );
    } catch (error) {
      reportError(s, error);
      await stop(s);
    }
  }
  function attach(socket) {
    socket.on("recording-start", (_data, ack = () => {}) => {
      if (typeof ack !== "function") return;
      const room = rooms.get(socket.data.roomId);
      if (!authorized(room))
        return ack({
          error:
            "Both participants must join and allow server recording first.",
        });
      if (room.recording)
        return ack({ error: "A recording is already active or being saved." });
      if (sessions.size >= 2)
        return ack({
          error: "Two server recorders are already running. Try later.",
        });
      const id = secret();
      const s = {
        id,
        token: secret(),
        room,
        path: path.join(folder, `${id}.webm`),
        bytes: 0,
        writes: Promise.resolve(),
      };
      room.recording = s;
      sessions.set(id, s);
      status(s, "starting");
      ack({ ok: true });
      void launch(s);
    });
    socket.on("recording-stop", (_data, ack = () => {}) => {
      if (typeof ack !== "function") return;
      const s = rooms.get(socket.data.roomId)?.recording;
      if (s) void stop(s);
      ack({ ok: true });
    });
    socket.on("recorder-join", (data, ack = () => {}) => {
      if (typeof ack !== "function") return;
      const s = sessions.get(data?.id);
      if (
        !s ||
        s.token !== data?.token ||
        s.observer ||
        s.cancelled ||
        !authorized(s.room)
      )
        return ack({ error: "Unauthorized recorder" });
      s.observer = socket;
      socket.data.recorderSession = s.id;
      ack({
        ok: true,
        peers: [...s.room.members].map(([id, m]) => ({ id, ...m })),
        rtcConfig: iceConfig(socket),
      });
    });
    socket.on("recorder-signal", (data) => {
      const s = sessions.get(data?.session);
      if (
        !s ||
        s.cancelled ||
        !authorized(s.room) ||
        !data.payload ||
        JSON.stringify(data.payload).length > 65000
      )
        return;
      if (socket === s.observer && s.room.members.has(data.to)) {
        io.to(data.to).emit("recorder-signal", {
          session: s.id,
          payload: data.payload,
        });
      } else if (s.room.members.has(socket.id)) {
        s.observer?.emit("recorder-signal", {
          from: socket.id,
          payload: data.payload,
        });
      }
    });
    socket.on("disconnect", () => {
      const s = sessions.get(socket.data.recorderSession);
      if (s && !s.cancelled) void stop(s, "Recorder disconnected.");
    });
  }
  function changed(room) {
    const s = room.recording;
    if (!s) return;
    if (!authorized(room))
      void stop(
        s,
        "Recording stopped because a participant left or withdrew consent."
      );
    else
      s.observer?.emit(
        "recorder-peers",
        [...room.members].map(([id, m]) => ({ id, ...m }))
      );
  }
  async function cleanup() {
    const now = Date.now();
    for (const [key, item] of downloads)
      if (item.expires < now) {
        downloads.delete(key);
        await fs.rm(item.path, { force: true }).catch(() => {});
      }
    // Also purge orphaned files from prior process runs after the retention period.
    for (const name of await fs.readdir(folder).catch(() => [])) {
      if (!/^[\w-]+\.webm$/.test(name)) continue;
      const file = path.join(folder, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > retention)
        await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  const timer = setInterval(() => void cleanup(), 60000);
  timer.unref();
  void cleanup();
  return {
    attach,
    changed,
    close: async () => {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map((s) => stop(s)));
    },
  };
}
