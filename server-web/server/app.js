import express from "express";
import { installRecording } from "./recording.js";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import { createServer } from "node:http";
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const token = () => randomBytes(24).toString("base64url");
const safeEqual = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp(config = {}) {
  const env = { ...process.env, ...config };
  const origins = (
    env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3001"
  )
    .split(",")
    .map((s) => s.trim());
  // 0 (default) means no configured participant cap. Resource limits still apply.
  const maxParticipants = Number(env.MAX_ROOM_PARTICIPANTS || 0);
  if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 0 || maxParticipants === 1) {
    throw new Error("MAX_ROOM_PARTICIPANTS must be 0 (no configured cap) or an integer >= 2.");
  }
  const app = express();
  if (env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
        },
      },
    })
  );
  // REST CORS is separate from Socket.IO's CORS configuration.
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    res.vary("Origin");
    if (origin && !origins.includes(origin)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    })
  );
  const http = createServer(app);
  const io = new Server(http, {
    cors: { origin: origins },
    maxHttpBufferSize: 70_000,
    // Same-origin polling GETs may omit Origin; room keys still authorize join.
    allowRequest: (req, done) =>
      done(
        null,
        !req.headers.origin ||
          origins.includes(req.headers.origin) ||
          req.headers.origin === `http://127.0.0.1:${http.address()?.port}`
      ),
  });
  const rooms = new Map();
  const lifetime = 2 * 60 * 60_000;
  const roster = (room) => [...room.members].map(([id, m]) => ({ id, ...m }));
  const publish = (room) => io.to(room.id).emit("peers", roster(room));
  const memberRoom = (socket) => rooms.get(socket.data.roomId);

  app.get("/favicon.ico", (_req, res) => res.status(204).end());
  app.get("/api/health", (_req, res) =>
    res.json({
      ok: true,
      service: "webrtc-poc",
      protocolVersion: 2,
      maxParticipants,
    })
  );
  app.post("/api/rooms", (req, res) => {
    if (req.headers.origin && !origins.includes(req.headers.origin))
      return res.status(403).json({ error: "Origin not allowed" });
    if (rooms.size >= 1000)
      return res
        .status(503)
        .json({ error: "Room capacity reached. Try later." });
    const id = randomBytes(6).toString("hex");
    const secret = token();
    const room = {
      id,
      secret,
      members: new Map(),
      created: Date.now(),
      emptySince: Date.now(),
      history: [],
    };
    rooms.set(id, room);
    res
      .status(201)
      .json({
        roomId: id,
        roomKey: secret,
        expiresAt: room.created + lifetime,
        maxParticipants,
        protocolVersion: 2,
      });
  });
  function iceConfig(socket) {
    const iceServers = [];
    if (env.STUN_URL) iceServers.push({ urls: env.STUN_URL });
    if (env.TURN_URLS && env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3 * 3600}:${
        socket.id
      }`;
      const credential = createHmac("sha1", env.TURN_SECRET)
        .update(username)
        .digest("base64");
      iceServers.push({
        urls: env.TURN_URLS.split(",").map((s) => s.trim()),
        username,
        credential,
      });
    }
    return {
      iceServers,
      iceTransportPolicy:
        env.ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all",
    };
  }
  const recording = installRecording({
    app,
    http,
    io,
    rooms,
    iceConfig,
    env,
    launchBrowser: config.recorderLauncher,
  });
  function leave(socket) {
    const room = memberRoom(socket);
    if (!room) return;
    room.members.delete(socket.id);
    recording.changed(room);
    socket.leave(room.id);
    socket.data.roomId = null;
    if (!room.members.size) room.emptySince = Date.now();
    publish(room);
  }
  io.on("connection", (socket) => {
    recording.attach(socket);
    let windowStart = Date.now(),
      events = 0;
    socket.use((_packet, next) => {
      if (Date.now() - windowStart > 60_000) {
        windowStart = Date.now();
        events = 0;
      }
      if (++events > 1200) {
        socket.disconnect(true);
        return;
      }
      next();
    });
    socket.on("join", (data, ack = () => {}) => {
      if (typeof ack !== "function") return;
      const room = rooms.get(data?.roomId);
      if (
        !room ||
        !safeEqual(data?.roomKey, room.secret) ||
        Date.now() > room.created + lifetime
      )
        return ack({ error: "Room link is invalid or expired." });
      if (socket.data.roomId) return ack({ error: "Already joined a room." });
      if ((maxParticipants === 0 || maxParticipants > 2) && data?.protocolVersion !== 2)
        return ack({
          error:
            "Update your web/mobile app to the group-call version before joining.",
        });
      if (maxParticipants > 0 && room.members.size >= maxParticipants)
        return ack({
          error: `Room is full (${maxParticipants} participants maximum).`,
        });
      const name = String(data?.name || "")
        .trim()
        .slice(0, 40);
      if (!name) return ack({ error: "Please enter your name." });
      room.members.set(socket.id, {
        name,
        mic: true,
        camera: true,
        sharing: false,
        recording: false,
        consent: data?.consent === true,
      });
      socket.data.roomId = room.id;
      socket.join(room.id);
      recording.changed(room);
      ack({
        ok: true,
        selfId: socket.id,
        rtcConfig: iceConfig(socket),
        history: room.history,
        expiresAt: room.created + lifetime,
        maxParticipants,
        protocolVersion: 2,
      });
      publish(room);
    });
    socket.on("signal", (data) => {
      const room = memberRoom(socket);
      if (!room || !room.members.has(data?.to) || data.to === socket.id) return;
      const payload = data.payload;
      if (
        !payload ||
        typeof payload !== "object" ||
        JSON.stringify(payload).length > 65_000
      )
        return;
      io.to(data.to).emit("signal", { from: socket.id, payload });
    });
    socket.on("media", (data) => {
      const room = memberRoom(socket),
        m = room?.members.get(socket.id);
      if (!m || !data || typeof data !== "object") return;
      for (const key of ["mic", "camera", "sharing", "consent"])
        if (typeof data[key] === "boolean") m[key] = data[key];
      if (typeof data.recording === "boolean")
        m.recording =
          data.recording &&
          room.members.size >= 2 &&
          [...room.members.values()].every((p) => p.consent);
      if ([...room.members.values()].some((p) => !p.consent))
        for (const peer of room.members.values()) peer.recording = false;
      recording.changed(room);
      publish(room);
    });
    socket.on("chat", (data, ack = () => {}) => {
      if (typeof ack !== "function") return;
      const room = memberRoom(socket),
        member = room?.members.get(socket.id);
      if (!member) return ack({ error: "Join a room first." });
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (!text || text.length > 2000)
        return ack({ error: "Messages must be 1–2,000 characters." });
      const now = Date.now();
      if (now - (socket.data.lastChat || 0) < 300)
        return ack({ error: "Please wait before sending another message." });
      socket.data.lastChat = now;
      const message = {
        id: randomUUID(),
        from: socket.id,
        name: member.name,
        text,
        at: now,
      };
      room.history.push(message);
      room.history = room.history.slice(-100);
      io.to(room.id).emit("chat", message);
      ack({ ok: true });
    });
    socket.on("leave", () => leave(socket));
    socket.on("disconnect", () => leave(socket));
  });
  const cleanup = setInterval(() => {
    for (const room of rooms.values())
      if (
        Date.now() > room.created + lifetime ||
        (!room.members.size && Date.now() - room.emptySince > 10 * 60_000)
      ) {
        io.to(room.id).emit("room-ended", "Room expired. Create a new room.");
        for (const id of room.members.keys()) {
          const socket = io.sockets.sockets.get(id);
          if (socket) leave(socket);
        }
        rooms.delete(room.id);
      }
  }, 15_000);
  cleanup.unref();
  if (env.PUBLIC_WEB_URL) {
    const web = new URL(env.PUBLIC_WEB_URL);
    if (
      !["https:", "http:"].includes(web.protocol) ||
      web.username ||
      web.password ||
      web.hash
    ) {
      throw new Error(
        "PUBLIC_WEB_URL must be a frontend HTTP(S) address without credentials or a fragment."
      );
    }
    app.get("/", (_req, res) => res.redirect(302, web.href));
  }
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  if (fs.existsSync(dist)) app.use(express.static(dist));
  app.use((err, _req, res, _next) =>
    res.status(400).json({ error: "Invalid request." })
  );
  return {
    app,
    http,
    io,
    rooms,
    close: async () => {
      clearInterval(cleanup);
      await recording.close();
      await new Promise((resolve) => io.close(resolve));
    },
  };
}
