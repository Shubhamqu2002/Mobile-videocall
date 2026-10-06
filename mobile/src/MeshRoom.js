import { io } from "socket.io-client";
import { RecordingUplink } from "./RecordingUplink";

// Kept identical in web and mobile. Platform capture lives in PeerRoom.js.
export class MeshRoom {
  constructor({ onChange, onError }, { RTCPeerConnection, MediaStream }) {
    Object.assign(this, { onChange, onError, RTCPeerConnection, MediaStream });
    this.links = new Map();
    this.earlySignals = new Map();
    this.disposed = false;
    this.state = {
      status: "Ready",
      peers: [],
      participants: [],
      messages: [],
      recordings: [],
      mic: true,
      camera: true,
      sharing: false,
      recording: false,
      consent: false,
      connection: "new",
      allConnected: false,
      stats: {},
      maxParticipants: 0,
    };
  }
  update(patch = {}) {
    Object.assign(this.state, patch);
    this.onChange({ ...this.state });
  }
  isCurrent(peer) {
    return !this.disposed && this.links.get(peer.id) === peer;
  }
  report(error) {
    if (!this.disposed) this.onError(error?.message || String(error));
  }
  async connect({ serverUrl, roomId, roomKey, name, consent }) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.credentials = { roomId, roomKey, name, consent, protocolVersion: 2 };
    const socket = (this.socket = io(this.serverUrl, {
      path: "/socket.io/",
      transports: ["polling", "websocket"],
      upgrade: true,
      autoConnect: false,
      reconnectionAttempts: 5,
      timeout: 10000,
    }));
    this.uplink = new RecordingUplink({
      socket,
      RTCPeerConnection: this.RTCPeerConnection,
      getMedia: () => ({ local: this.local, screen: this.screen }),
      onError: (error) => this.report(error),
    });
    const joined = new Promise((resolve, reject) => {
      this.finishJoin = (error) => {
        if (!this.finishJoin) return;
        clearTimeout(this.joinTimer);
        this.finishJoin = null;
        if (error) reject(error);
        else resolve();
      };
      this.joinTimer = setTimeout(() => {
        this.finishJoin?.(
          new Error("Joining timed out. Check the backend /socket.io/ route.")
        );
        this.leave();
      }, 25000);
    });
    socket.on("connect", () => {
      if (this.disposed) return;
      this.update({ status: "Joining room" });
      socket.timeout(10000).emit("join", this.credentials, (error, result) => {
        if (this.disposed) return;
        if (error || result?.error || !result?.rtcConfig) {
          const failure = new Error(
            result?.error || "The server did not acknowledge joining."
          );
          if (this.finishJoin) this.finishJoin(failure);
          else this.report(failure);
          this.leave();
          return;
        }
        this.rtcConfig = result.rtcConfig;
        this.uplink.rtcConfig = result.rtcConfig;
        this.update({
          selfId: socket.id,
          maxParticipants: result.maxParticipants ?? 2,
          messages: result.history || [],
          expiresAt: result.expiresAt,
          status: "Waiting for participants",
          hasTurn: (result.rtcConfig.iceServers || []).some((s) =>
            [].concat(s.urls).some((url) => String(url).startsWith("turn"))
          ),
        });
        this.setMedia({
          mic: this.state.mic,
          camera: this.state.camera,
          sharing: this.state.sharing,
          consent: this.state.consent,
        });
        this.finishJoin?.();
      });
    });
    socket.on("peers", (roster) => this.syncPeers(roster));
    socket.on("signal", ({ from, payload }) => {
      if (this.disposed) return;
      const peer = this.links.get(from);
      if (peer) this.enqueue(peer, () => this.receiveSignal(peer, payload));
      else if (this.earlySignals.size < 12) {
        const pending = this.earlySignals.get(from) || [];
        if (pending.length < 64) pending.push(payload);
        this.earlySignals.set(from, pending);
      }
    });
    socket.on("chat", (message) => {
      if (!this.disposed)
        this.update({
          messages: [...this.state.messages, message].slice(-100),
        });
    });
    socket.on("recording-state", (value) => {
      if (!this.disposed)
        this.update({
          serverRecording: value,
          recording: ["starting", "recording"].includes(value.status),
        });
    });
    socket.on("recording-ready", (value) => {
      if (this.disposed) return;
      try {
        const url = new URL(value.url, this.serverUrl).href;
        this.update({
          recordings: [...this.state.recordings, { ...value, url }],
        });
      } catch (error) {
        this.report(error);
      }
    });
    socket.on("recording-error", (error) => this.report(error));
    socket.on("room-ended", (reason) => {
      this.report(reason);
      this.leave();
    });
    socket.on("connect_error", (error) => {
      const failure = new Error(
        `Cannot connect to ${this.serverUrl}. Socket.IO: ${error.message}`
      );
      if (this.finishJoin) {
        this.finishJoin(failure);
        this.leave();
      } else this.report(failure);
    });
    socket.on("disconnect", (reason) => {
      if (this.disposed) return;
      this.closeLinks();
      this.update({
        peers: [],
        participants: [],
        connection: "new",
        allConnected: false,
        serverRecording: { status: "idle" },
        recording: false,
        status:
          reason === "io server disconnect"
            ? "Disconnected. Leave and rejoin."
            : "Reconnecting to server",
      });
    });
    socket.io.on("reconnect_failed", () => {
      if (!this.disposed)
        this.update({ status: "Reconnect failed. Leave and rejoin." });
    });
    socket.connect();
    this.statsTimer = setInterval(
      () => this.readStats().catch((error) => this.report(error)),
      4000
    );
    return joined;
  }
  enqueue(peer, fn) {
    const task = peer.queue.then(async () => {
      if (this.isCurrent(peer)) await fn();
    });
    peer.queue = task.catch((error) => {
      if (this.isCurrent(peer)) this.report(error);
    });
    return peer.queue;
  }
  syncPeers(roster) {
    if (this.disposed || !this.rtcConfig) return;
    const others = roster.filter((member) => member.id !== this.socket.id);
    const ids = new Set(others.map((member) => member.id));
    for (const [id, peer] of this.links) if (!ids.has(id)) this.closeLink(peer);
    this.state.peers = roster;
    for (const member of others) {
      let peer = this.links.get(member.id);
      if (!peer) peer = this.createPeer(member);
      peer.member = member;
      for (const payload of this.earlySignals.get(member.id) || []) {
        this.enqueue(peer, () => this.receiveSignal(peer, payload));
      }
      this.earlySignals.delete(member.id);
    }
    for (const id of this.earlySignals.keys())
      if (!ids.has(id)) this.earlySignals.delete(id);
    this.publishParticipants();
  }
  publishParticipants() {
    if (this.disposed || !this.socket?.connected) return;
    const participants = [...this.links.values()].map((peer) => ({
      ...peer.member,
      stream: peer.remote,
      screenStream: peer.screen,
      connection: peer.pc.connectionState,
      stats: peer.stats || {},
    }));
    const connected = participants.filter(
      (p) => p.connection === "connected"
    ).length;
    const failed = participants.some((p) => p.connection === "failed");
    const allConnected =
      participants.length > 0 && connected === participants.length;
    this.update({
      participants,
      allConnected,
      connection: connected
        ? "connected"
        : failed
        ? "failed"
        : participants.length
        ? "connecting"
        : "new",
      status: !participants.length
        ? "Waiting for participants"
        : allConnected
        ? `Connected · ${participants.length + 1} people`
        : `${connected}/${participants.length} peer connections${
            failed ? " · Retry failed connections" : " · Connecting"
          }`,
      stats: {
        path: connected
          ? `${connected} peer connection${connected === 1 ? "" : "s"}`
          : "Connecting media",
      },
    });
  }
  createPeer(member) {
    const pc = new this.RTCPeerConnection(this.rtcConfig);
    const peer = {
      id: member.id,
      member,
      pc,
      polite: this.socket.id > member.id,
      remote: new this.MediaStream(),
      screen: new this.MediaStream(),
      candidates: [],
      queue: Promise.resolve(),
      stats: {},
    };
    this.links.set(member.id, peer);
    peer.send = (payload) => {
      if (this.isCurrent(peer) && this.socket.connected)
        this.socket.emit("signal", { to: peer.id, payload });
    };
    // Only the lexicographically smaller socket offers. Every pair has its own
    // queue and fixed audio/camera/screen transceivers, including audio-only users.
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) peer.send({ candidate: candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      if (!this.isCurrent(peer)) return;
      const stream = event.transceiver.mid === "2" ? peer.screen : peer.remote;
      if (!stream.getTracks().some((t) => t.id === event.track.id))
        stream.addTrack(event.track);
      this.publishParticipants();
    };
    pc.onconnectionstatechange = () => {
      if (this.isCurrent(peer)) this.publishParticipants();
    };
    pc.onnegotiationneeded = () => {
      if (!peer.polite)
        this.enqueue(peer, async () => {
          if (pc.signalingState !== "stable") return;
          await pc.setLocalDescription(await pc.createOffer());
          peer.send({ description: pc.localDescription });
        });
    };
    if (!peer.polite) {
      pc.addTransceiver(this.local.getAudioTracks()[0], {
        direction: "sendrecv",
        streams: [this.local],
      });
      peer.cameraSender = pc.addTransceiver(
        this.local.getVideoTracks()[0] || "video",
        { direction: "sendrecv", streams: [this.local] }
      ).sender;
      peer.screenSender = pc.addTransceiver("video", {
        direction: "sendrecv",
      }).sender;
      const track = this.screen?.getVideoTracks()[0];
      if (track)
        this.enqueue(peer, () => peer.screenSender.replaceTrack(track));
    }
    return peer;
  }
  async receiveSignal(peer, { description, candidate, restart } = {}) {
    const pc = peer.pc;
    if (!this.isCurrent(peer) || pc.signalingState === "closed") return;
    if (restart) {
      if (!peer.polite) await this.offerRestart(peer);
      return;
    }
    if (description) {
      // Pair roles are stable for the lifetime of both socket IDs.
      if (description.type === "offer" && !peer.polite) return;
      if (
        description.type === "answer" &&
        pc.signalingState !== "have-local-offer"
      )
        return;
      await pc.setRemoteDescription(description);
      if (!this.isCurrent(peer)) return;
      for (const pending of peer.candidates.splice(0))
        await pc.addIceCandidate(pending);
      if (description.type === "offer") {
        const slots = pc.getTransceivers();
        if (slots.length < 3)
          throw new Error(
            "Incompatible client: update every web/mobile client to the group-call version."
          );
        if (!peer.cameraSender) {
          await slots[0].sender.replaceTrack(this.local.getAudioTracks()[0]);
          peer.cameraSender = slots[1].sender;
          peer.screenSender = slots[2].sender;
          await peer.cameraSender.replaceTrack(
            this.local.getVideoTracks()[0] || null
          );
          await peer.screenSender.replaceTrack(
            this.screen?.getVideoTracks()[0] || null
          );
          for (const slot of slots) slot.direction = "sendrecv";
        }
        await pc.setLocalDescription(await pc.createAnswer());
        peer.send({ description: pc.localDescription });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else if (peer.candidates.length < 128) peer.candidates.push(candidate);
    }
  }
  async replaceAll(slot, track) {
    await Promise.all(
      [...this.links.values()].map((peer) =>
        this.enqueue(peer, async () => {
          if (peer[slot]) await peer[slot].replaceTrack(track);
        })
      )
    );
    await this.uplink?.syncTracks();
  }
  setMedia(patch) {
    if (this.disposed) return;
    this.update(patch);
    this.uplink?.syncTracks().catch((error) => this.report(error));
    if (this.credentials && "consent" in patch)
      this.credentials.consent = patch.consent;
    if (this.socket?.connected) {
      const flags = {};
      for (const key of ["mic", "camera", "sharing", "consent"])
        if (typeof patch[key] === "boolean") flags[key] = patch[key];
      this.socket.emit("media", flags);
    }
  }
  toggleMic() {
    const mic = !this.state.mic;
    this.local?.getAudioTracks().forEach((track) => {
      track.enabled = mic;
    });
    this.setMedia({ mic });
  }
  watchCamera(track) {
    track.onended = () => {
      if (this.disposed) return;
      this.local?.removeTrack(track);
      this.replaceAll("cameraSender", null).catch((error) =>
        this.report(error)
      );
      this.setMedia({ camera: false });
      this.update({
        cameraError: "Camera stopped. Turn the camera on to retry.",
      });
    };
  }
  async toggleCamera() {
    if (this.cameraBusy || this.disposed) return;
    if (!this.state.camera) return this.switchCamera(this.cameraId);
    this.local?.getVideoTracks().forEach((track) => {
      track.onended = null;
      track.stop();
      this.local.removeTrack(track);
    });
    this.setMedia({ camera: false });
    await this.replaceAll("cameraSender", null);
  }
  async switchCamera(deviceId = "") {
    if (this.cameraBusy || this.disposed) return;
    this.cameraBusy = true;
    this.cameraId = deviceId;
    this.update({ cameraBusy: true, cameraError: "" });
    let track;
    try {
      this.local?.getVideoTracks().forEach((old) => {
        old.onended = null;
        old.stop();
        this.local.removeTrack(old);
      });
      this.setMedia({ camera: false });
      await this.replaceAll("cameraSender", null);
      track = await this.captureCamera(deviceId);
      if (this.disposed) {
        track.stop();
        return;
      }
      this.local.addTrack(track);
      this.watchCamera(track);
      await this.replaceAll("cameraSender", track);
      this.setMedia({ camera: true, front: true });
    } catch (error) {
      if (track) {
        this.local?.removeTrack(track);
        track.stop();
      }
      if (!this.disposed) this.update({ cameraError: error.message });
    } finally {
      this.cameraBusy = false;
      if (!this.disposed) this.update({ cameraBusy: false });
    }
  }
  async startScreen() {
    if (this.state.sharing || this.screenBusy) return;
    if (
      ![...this.links.values()].some(
        (p) => p.pc.connectionState === "connected"
      )
    ) {
      throw new Error("Wait for a participant to connect before sharing.");
    }
    this.screenBusy = true;
    let stream;
    try {
      stream = await this.captureScreen();
      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No screen video was returned.");
      this.screen = stream;
      track.onended = () =>
        this.stopScreen().catch((error) => this.report(error));
      await this.replaceAll("screenSender", track);
      this.setMedia({ sharing: true, localScreen: stream });
    } catch (error) {
      stream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      this.screen = null;
      throw error;
    } finally {
      this.screenBusy = false;
    }
  }
  async stopScreen() {
    const stream = this.screen;
    this.screen = null;
    stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    await this.replaceAll("screenSender", null);
    this.setMedia({ sharing: false, localScreen: null });
  }
  command(event, data, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected || this.disposed)
        return reject(new Error("Signaling is disconnected."));
      this.socket.timeout(timeout).emit(event, data, (error, result) => {
        if (error || result?.error)
          reject(new Error(result?.error || `${event} timed out.`));
        else resolve(result);
      });
    });
  }
  sendChat(text) {
    return this.command("chat", { text }, 5000);
  }
  recordCommand(event) {
    return this.command(event, {}, 15000);
  }
  startRecording() {
    return this.recordCommand("recording-start");
  }
  stopRecording() {
    return this.recordCommand("recording-stop");
  }
  async offerRestart(peer) {
    if (!this.isCurrent(peer) || peer.pc.signalingState !== "stable") return;
    await peer.pc.setLocalDescription(
      await peer.pc.createOffer({ iceRestart: true })
    );
    peer.send({ description: peer.pc.localDescription });
  }
  async restartIce() {
    await Promise.all(
      [...this.links.values()].map((peer) =>
        this.enqueue(peer, async () => {
          if (peer.polite) peer.send({ restart: true });
          else await this.offerRestart(peer);
        })
      )
    );
    if (!this.disposed) this.update({ status: "Retrying peer connections" });
  }
  async readStats() {
    await Promise.all(
      [...this.links.values()].map(async (peer) => {
        if (peer.pc.connectionState !== "connected") return;
        const report = await peer.pc.getStats();
        if (!this.isCurrent(peer)) return;
        let pair;
        report.forEach((stat) => {
          if (stat.type === "transport" && stat.selectedCandidatePairId)
            pair = report.get(stat.selectedCandidatePairId);
        });
        if (!pair)
          report.forEach((stat) => {
            if (
              stat.type === "candidate-pair" &&
              stat.state === "succeeded" &&
              stat.nominated
            )
              pair = stat;
          });
        if (pair)
          peer.stats = {
            path: [
              report.get(pair.localCandidateId),
              report.get(pair.remoteCandidateId),
            ].some((c) => c?.candidateType === "relay")
              ? "TURN relay"
              : "Direct",
            rtt: Math.round((pair.currentRoundTripTime || 0) * 1000),
          };
      })
    );
    this.publishParticipants();
  }
  closeLink(peer) {
    this.links.delete(peer.id);
    for (const event of [
      "ontrack",
      "onicecandidate",
      "onnegotiationneeded",
      "onconnectionstatechange",
    ])
      peer.pc[event] = null;
    peer.pc.close();
    peer.remote.getTracks().forEach((t) => t.stop());
    peer.screen.getTracks().forEach((t) => t.stop());
  }
  closeLinks() {
    for (const peer of [...this.links.values()]) this.closeLink(peer);
    this.earlySignals.clear();
    this.uplink?.close();
  }
  leave() {
    if (this.disposed) return;
    this.disposed = true;
    this.finishJoin?.(new Error("Joining was cancelled."));
    clearTimeout(this.joinTimer);
    clearInterval(this.statsTimer);
    this.closeLinks();
    for (const stream of [this.local, this.screen])
      stream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
    this.socket?.emit("leave");
    this.socket?.disconnect();
    this.onPlatformLeave?.();
    this.update({
      status: "Call ended",
      local: null,
      localScreen: null,
      peers: [],
      participants: [],
      connection: "new",
      allConnected: false,
      recording: false,
      serverRecording: { status: "idle" },
      sharing: false,
    });
  }
}
