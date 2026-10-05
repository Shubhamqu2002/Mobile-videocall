// Independent, send-only connection to the consent-controlled server recorder.
// The normal participant-to-participant connection is kept separate.
export class RecordingUplink {
  constructor({ socket, RTCPeerConnection, getMedia, onError }) {
    Object.assign(this, { socket, RTCPeerConnection, getMedia, onError });
    this.queue = Promise.resolve();
    socket.on("recorder-signal", (message) => {
      this.queue = this.queue
        .then(() => this.receive(message))
        .catch((e) => onError(`Recorder connection: ${e.message}`));
    });
    socket.on("recorder-close", () => this.close());
    socket.on("disconnect", () => this.close());
  }
  async receive({ session, payload }) {
    if (payload.description?.type === "offer") {
      this.close();
      this.session = session;
      const pc = (this.pc = new this.RTCPeerConnection(this.rtcConfig));
      pc.onicecandidate = ({ candidate }) =>
        candidate && this.send({ candidate: candidate.toJSON() });
      await pc.setRemoteDescription(payload.description);
      if (pc !== this.pc) return;
      await this.syncTracks();
      for (const t of pc.getTransceivers()) t.direction = "sendonly";
      await pc.setLocalDescription(await pc.createAnswer());
      this.send({ description: pc.localDescription });
    } else if (session === this.session && this.pc && payload.candidate) {
      await this.pc.addIceCandidate(payload.candidate);
    }
  }
  send(payload) {
    this.socket.emit("recorder-signal", { session: this.session, payload });
  }
  async syncTracks() {
    const pc = this.pc;
    if (!pc || pc.signalingState === "closed") return;
    const { local, screen } = this.getMedia();
    const tracks = [
      local?.getAudioTracks()[0],
      local?.getVideoTracks()[0],
      screen?.getVideoTracks()[0],
    ];
    await Promise.all(
      pc
        .getTransceivers()
        .map((t, i) => t.sender.replaceTrack(tracks[i] || null))
    );
  }
  close() {
    this.pc?.close();
    this.pc = null;
    this.session = null;
  }
}
