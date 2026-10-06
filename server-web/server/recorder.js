/* Private headless page; no microphone or camera device capture is requested here. */
const [session, token] = location.hash.slice(1).split(":");
const socket = io({ transports: ["websocket"] });
const peers = new Map();
let roster = [],
  recorder,
  timer,
  audio,
  capture,
  chunks = Promise.resolve(),
  stopping;
const canvas = document.querySelector("canvas"),
  ctx = canvas.getContext("2d");
const send = (to, payload) =>
  socket.emit("recorder-signal", { session, to, payload });
function video() {
  const v = document.createElement("video");
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  document.body.append(v);
  return v;
}
socket.on("connect", () =>
  socket.emit("recorder-join", { id: session, token }, async (result) => {
    try {
      if (result.error) throw new Error(result.error);
      roster = result.peers;
      for (const member of roster) {
        const pc = new RTCPeerConnection(result.rtcConfig);
        const p = {
          pc,
          media: new MediaStream(),
          screen: new MediaStream(),
          cameraVideo: video(),
          screenVideo: video(),
          queue: Promise.resolve(),
          candidates: [],
        };
        peers.set(member.id, p);
        pc.onicecandidate = ({ candidate }) =>
          candidate && send(member.id, { candidate: candidate.toJSON() });
        pc.ontrack = (e) => {
          const screen = e.transceiver.mid === "2";
          const stream = screen ? p.screen : p.media;
          stream.addTrack(e.track);
          const v = screen ? p.screenVideo : p.cameraVideo;
          v.srcObject = stream;
          v.play().catch(() => {});
        };
        for (const kind of ["audio", "video", "video"])
          pc.addTransceiver(kind, { direction: "recvonly" });
        await pc.setLocalDescription(await pc.createOffer());
        send(member.id, { description: pc.localDescription });
      }
      const deadline = Date.now() + 30000;
      while (
        ![...peers.values()].every(
          (p) =>
            p.pc.connectionState === "connected" &&
            p.media.getAudioTracks().length
        )
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "Recorder could not receive every participant. Check TURN."
          );
        if (stopping) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!stopping) await start();
    } catch (e) {
      window.recorderFailure(e.message);
    }
  })
);
socket.on("recorder-peers", (value) => {
  roster = value;
});
socket.on("recorder-signal", ({ from, payload }) => {
  const p = peers.get(from);
  if (!p) return;
  p.queue = p.queue
    .then(async () => {
      if (payload.description) {
        await p.pc.setRemoteDescription(payload.description);
        for (const c of p.candidates.splice(0)) await p.pc.addIceCandidate(c);
      } else if (payload.candidate) {
        if (p.pc.remoteDescription)
          await p.pc.addIceCandidate(payload.candidate);
        else p.candidates.push(payload.candidate);
      }
    })
    .catch((e) => window.recorderFailure(e.message));
});
function tile(v, label, x, y, w, h, enabled = true) {
  ctx.fillStyle = "#192638";
  ctx.fillRect(x, y, w, h);
  if (enabled && v?.readyState >= 2 && v.videoWidth) {
    const scale = Math.min(w / v.videoWidth, h / v.videoHeight),
      dw = v.videoWidth * scale,
      dh = v.videoHeight * scale;
    ctx.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  ctx.fillStyle = "#09111ddd";
  ctx.fillRect(x, y + h - 36, w, 36);
  ctx.fillStyle = "#fff";
  ctx.font = "18px sans-serif";
  ctx.fillText(label, x + 12, y + h - 12, w - 24);
}
function grid(items, x, y, width, height, screen = false) {
  if (!items.length) return;
  const columns = Math.ceil(Math.sqrt((items.length * width) / height));
  const cols = Math.min(items.length, Math.max(1, columns));
  const rows = Math.ceil(items.length / cols);
  const gap = 10;
  const w = (width - gap * (cols - 1)) / cols;
  const h = (height - gap * (rows - 1)) / rows;
  items.forEach((m, i) =>
    tile(
      screen ? peers.get(m.id)?.screenVideo : peers.get(m.id)?.cameraVideo,
      `${m.name}${screen ? " · Screen" : ""}`,
      x + (i % cols) * (w + gap),
      y + Math.floor(i / cols) * (h + gap),
      w,
      h,
      screen || m.camera
    )
  );
}
function draw() {
  ctx.fillStyle = "#0c1321";
  ctx.fillRect(0, 0, 1280, 720);
  const shares = roster.filter((m) => m.sharing);
  if (shares.length) {
    grid(shares, 16, 16, 1248, 460, true);
    grid(roster, 16, 490, 1248, 214);
  } else grid(roster, 16, 16, 1248, 688);
}

async function start() {
  audio = new AudioContext();
  await audio.resume();
  const destination = audio.createMediaStreamDestination();
  for (const p of peers.values()) {
    const source = audio.createMediaStreamSource(p.media),
      gain = audio.createGain();
    gain.gain.value = 1 / Math.max(1, peers.size);
    source.connect(gain);
    gain.connect(destination);
  }
  draw();
  capture = canvas.captureStream(20);
  destination.stream.getAudioTracks().forEach((t) => capture.addTrack(t));
  const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find((t) =>
    MediaRecorder.isTypeSupported(t)
  );
  recorder = new MediaRecorder(capture, {
    mimeType,
    videoBitsPerSecond: 1600000,
    audioBitsPerSecond: 128000,
  });
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks = chunks.then(
      () =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            window
              .writeChunk(reader.result.split(",")[1])
              .then(resolve, reject);
          reader.onerror = reject;
          reader.readAsDataURL(e.data);
        })
    );
  };
  recorder.onerror = () => window.recorderFailure("MediaRecorder failed.");
  recorder.start(1000);
  timer = setInterval(draw, 50);
  await window.recorderReady();
}
window.stopRecording = () => {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(timer);
    if (recorder && recorder.state !== "inactive")
      await new Promise((r) => {
        recorder.onstop = r;
        recorder.stop();
      });
    await chunks;
    peers.forEach((p) => p.pc.close());
    capture?.getTracks().forEach((t) => t.stop());
    await audio?.close();
  })();
  return stopping;
};
