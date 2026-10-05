// Browser-only recording adapter. The transport does not depend on this class.
export class CallRecorder {
  constructor({ getScene, onReady, onError, onStop }) {
    Object.assign(this, { getScene, onReady, onError, onStop });
    this.elements = new Map();
    this.chunks = [];
    this.bytes = 0;
  }
  async start() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('Recording is unavailable in this browser. Use desktop Chrome or Edge.');
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error('WebM recording is unavailable. Use desktop Chrome or Edge.');
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280; this.canvas.height = 720;
    this.ctx = this.canvas.getContext('2d');
    this.audio = new AudioContext();
    await this.audio.resume();
    this.destination = this.audio.createMediaStreamDestination();
    this.sources = [];
    const scene = this.getScene();
    for (const stream of [scene.local, scene.remote]) if (stream?.getAudioTracks().length) {
      const source = this.audio.createMediaStreamSource(stream);
      const gain = this.audio.createGain(); gain.gain.value = 0.7;
      source.connect(gain); gain.connect(this.destination);
      this.sources.push(source, gain);
    }
    this.draw();
    this.capture = this.canvas.captureStream(24);
    for (const track of this.destination.stream.getAudioTracks()) this.capture.addTrack(track);
    this.recorder = new MediaRecorder(this.capture, { mimeType, videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000 });
    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;
      this.chunks.push(event.data); this.bytes += event.data.size;
      if (this.bytes > 150 * 1024 * 1024) { this.onError('Recording reached the 150 MB POC limit and was saved.'); this.stop(); }
    };
    this.recorder.onerror = () => { this.onError('Recording failed. Any captured content will be saved if available.'); this.stop(); };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType });
      if (blob.size) this.onReady({ url: URL.createObjectURL(blob), name: `call-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, size: blob.size });
      this.cleanup(); this.onStop();
    };
    this.recorder.start(1000);
    this.timer = setInterval(() => this.draw(), 1000 / 24);
    this.limit = setTimeout(() => { this.onError('The 15-minute POC recording limit was reached. Your recording was saved.'); this.stop(); }, 15 * 60_000);
  }
  video(stream) {
    if (!stream) return null;
    if (!this.elements.has(stream.id)) {
      const video = document.createElement('video');
      video.autoplay = true; video.muted = true; video.playsInline = true; video.srcObject = stream;
      video.play().catch(() => {});
      this.elements.set(stream.id, video);
    }
    return this.elements.get(stream.id);
  }
  tile(stream, name, x, y, w, h, enabled = true) {
    const ctx = this.ctx, video = this.video(stream);
    ctx.fillStyle = '#202c40'; ctx.fillRect(x, y, w, h);
    if (enabled && video?.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(w / video.videoWidth, h / video.videoHeight);
      const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
      ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    }
    ctx.fillStyle = '#0b1120cc'; ctx.fillRect(x, y + h - 36, w, 36);
    ctx.fillStyle = '#ffffff'; ctx.font = '18px sans-serif'; ctx.fillText(name || 'Participant', x + 14, y + h - 12, w - 28);
  }
  draw() {
    const scene = this.getScene();
    this.ctx.fillStyle = '#101622'; this.ctx.fillRect(0, 0, 1280, 720);
    const screen = scene.localSharing ? scene.localScreen : scene.remoteSharing ? scene.remoteScreen : null;
    if (screen) {
      this.tile(screen, 'Shared screen', 16, 16, 1248, 688);
      this.tile(scene.local, `${scene.localName} (you)`, 736, 526, 248, 162, scene.localCamera);
      this.tile(scene.remote, scene.remoteName, 1000, 526, 248, 162, scene.remoteCamera);
    } else {
      this.tile(scene.local, `${scene.localName} (you)`, 16, 90, 616, 540, scene.localCamera);
      this.tile(scene.remote, scene.remoteName, 648, 90, 616, 540, scene.remoteCamera);
    }
  }
  stop() { if (this.recorder?.state !== 'inactive' && this.recorder) this.recorder.stop(); else this.cleanup(); }
  cleanup() {
    clearInterval(this.timer); clearTimeout(this.limit);
    for (const source of this.sources || []) source.disconnect();
    for (const track of this.capture?.getTracks() || []) track.stop();
    this.audio?.close().catch(() => {});
    for (const video of this.elements.values()) { video.pause(); video.srcObject = null; }
    this.elements.clear();
  }
}
