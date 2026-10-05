import { io } from 'socket.io-client';
import { RecordingUplink } from './RecordingUplink';
import { openCamera, cameraMessage } from './camera';

// Framework-independent controller: reuse this class with React, Vue or vanilla JS.
export class PeerRoom {
  constructor({ onChange, onError }) {
    this.onChange = onChange; this.onError = onError;
    this.state = { status: 'idle', peers: [], messages: [], mic: true, camera: true, sharing: false, recording: false, consent: false, recordings: [], connection: 'new', stats: {} };
    this.peer = null; this.disposed = false;
  }
  update(patch = {}) { Object.assign(this.state, patch); this.onChange({ ...this.state }); }
  async join({ roomId, roomKey, name, consent, cameraId = '', audioOnly = false }) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Use http://localhost on this computer, or HTTPS for another device.');
    this.credentials = { roomId, roomKey, name, consent };
    this.cameraId = cameraId;
    this.update({ status: 'Requesting camera and microphone', consent });
    this.local = new MediaStream();
    let cameraError = '';
    if (!audioOnly) {
      try { this.local.addTrack(await openCamera(cameraId)); }
      catch (error) { cameraError = cameraMessage(error); }
    }
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      audio.getTracks().forEach(track => this.local.addTrack(track));
    } catch (error) {
      this.local.getTracks().forEach(track => track.stop());
      throw new Error(`Microphone ${error.name}: ${error.message}. Microphone access is required; camera access is optional.`);
    }
    if (this.disposed) { this.local.getTracks().forEach(t => t.stop()); return; }
    const camera = this.local.getVideoTracks().length > 0;
    if (camera) this.watchCamera(this.local.getVideoTracks()[0]);
    this.update({ local: this.local, camera, cameraError, status: 'Connecting' });
    const socket = this.socket = io({ autoConnect: false, reconnectionAttempts: 5, timeout: 10_000 });
    socket.on('connect', () => {
      socket.timeout(10_000).emit('join', this.credentials, (error, result) => {
        if (error || result?.error) { this.onError(result?.error || 'Joining timed out.'); this.leave(); return; }
        this.rtcConfig = result.rtcConfig;
        this.uplink.rtcConfig = result.rtcConfig;
        this.update({ selfId: result.selfId, status: 'Waiting for another participant', messages: result.history, expiresAt: result.expiresAt, hasTurn: result.rtcConfig.iceServers.some(s => [].concat(s.urls).some(u => u.startsWith('turn'))) });
        this.setMedia({ mic: this.state.mic, camera: this.state.camera, sharing: this.state.sharing, consent: this.state.consent });
      });
    });
    this.uplink = new RecordingUplink({socket, RTCPeerConnection, getMedia: () => ({local: this.local, screen: this.screen}), onError: this.onError});
    socket.on('recording-state', value => this.update({serverRecording: value, recording: ['starting', 'recording'].includes(value.status)}));
    socket.on('recording-ready', value => this.update({recordings: [...this.state.recordings, value]}));
    socket.on('recording-error', value => this.onError(value));
    socket.on('peers', roster => this.syncPeers(roster));
    socket.on('signal', ({ from, payload }) => {
      const peer = this.peer;
      if (!peer || peer.id !== from) return;
      peer.signalQueue = peer.signalQueue.then(() => this.receiveSignal(peer, payload)).catch(error => this.onError(`Connection negotiation: ${error.message}`));
    });
    socket.on('chat', message => this.update({ messages: [...this.state.messages, message].slice(-100) }));
    socket.on('room-ended', reason => { this.onError(reason); this.leave(); });
    socket.on('disconnect', reason => {
      if (this.disposed) return;
      this.closePeer();
      this.update({ status: reason === 'io server disconnect' ? 'Disconnected. Leave and rejoin the room.' : 'Signaling disconnected; trying to reconnect', peers: [] });
    });
    socket.on('connect_error', () => this.onError('Cannot reach signaling server. Check npm run dev / npm start and the allowed origin.'));
    socket.io.on('reconnect_failed', () => this.update({ status: 'Reconnect failed. Leave and rejoin the room.' }));
    socket.connect();
    this.statsTimer = setInterval(() => this.readStats().catch(() => {}), 2000);
  }
  syncPeers(roster) {
    if (this.disposed) return;
    const other = roster.find(p => p.id !== this.socket.id);
    this.update({ peers: roster, remoteMember: other || null });
    if (this.recorder && (roster.length !== 2 || !roster.every(p => p.consent))) this.stopRecording();
    if (!other) { this.closePeer(); this.update({ status: 'Waiting for another participant' }); return; }
    if (this.peer?.id !== other.id) { this.closePeer(); this.createPeer(other); }
  }
  createPeer(member) {
    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer = this.peer = { id: member.id, pc, polite: this.socket.id > member.id, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], signalQueue: Promise.resolve(), remote: new MediaStream(), screen: new MediaStream() };
    // Fixed media slots on both endpoints: 0 microphone, 1 camera, 2 screen.
    // Only the initial offerer creates slots. The answerer attaches to the
    // offered slots after setRemoteDescription, avoiding duplicate m-lines.
    if (!peer.polite) {
      pc.addTransceiver(this.local.getAudioTracks()[0], { direction: 'sendrecv', streams: [this.local] });
      peer.cameraSender = pc.addTransceiver(this.local.getVideoTracks()[0] || 'video', { direction: 'sendrecv', streams: [this.local] }).sender;
      peer.screenSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      if (this.screen?.getVideoTracks()[0]) peer.screenSender.replaceTrack(this.screen.getVideoTracks()[0]).catch(error => this.onError(error.message));
    }
    const send = payload => { if (this.peer === peer) this.socket.emit('signal', { to: peer.id, payload }); };
    peer.send = send;
    pc.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate: candidate.toJSON() }); };
    pc.ontrack = event => {
      const stream = event.transceiver.mid === '2' ? peer.screen : peer.remote;
      if (!stream.getTracks().some(t => t.id === event.track.id)) stream.addTrack(event.track);
      this.update({ remote: peer.remote, remoteScreen: peer.screen });
    };
    pc.onnegotiationneeded = async () => {
      try { peer.makingOffer = true; if (peer.polite || pc.signalingState !== 'stable') return; await pc.setLocalDescription(await pc.createOffer()); send({ description: pc.localDescription }); }
      catch (error) { if (this.peer === peer) this.onError(error.message); }
      finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      const state = pc.connectionState;
      this.update({ connection: state, status: state === 'connected' ? 'Connected' : state === 'failed' ? 'Connection failed. Try reconnecting; check TURN.' : `Media ${state}` });
      if (state === 'failed') this.stopRecording();
    };
    pc.oniceconnectionstatechange = () => {
      if (this.peer === peer && ['connected', 'completed'].includes(pc.iceConnectionState)) this.update({ status: 'Connected' });
    };
    this.update({ remote: peer.remote, remoteScreen: peer.screen, status: 'Connecting media' });
  }
  async receiveSignal(peer, { description, candidate, restart }) {
    if (restart && !peer.polite) return this.restartIce();
    const pc = peer.pc;
    if (this.peer !== peer || pc.signalingState === 'closed') return;
    if (description) {
      const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
      const collision = description.type === 'offer' && !ready;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = description.type === 'answer';
      try { await pc.setRemoteDescription(description); } finally { peer.settingAnswer = false; }
      for (const pending of peer.candidates.splice(0)) await pc.addIceCandidate(pending);
      if (description.type === 'offer') {
        const slots = pc.getTransceivers();
        if (!peer.screenSender) {
          await slots[0].sender.replaceTrack(this.local.getAudioTracks()[0]);
          peer.cameraSender = slots[1].sender;
          await peer.cameraSender.replaceTrack(this.local.getVideoTracks()[0] || null);
          peer.screenSender = slots[2].sender;
          if (this.screen?.getVideoTracks()[0]) await peer.screenSender.replaceTrack(this.screen.getVideoTracks()[0]);
          for (const slot of slots) slot.direction = 'sendrecv';
        }
        await pc.setLocalDescription(await pc.createAnswer()); peer.send({ description: pc.localDescription });
      }
      // A successful ICE restart can keep connectionState continuously connected.
      if (pc.signalingState === 'stable' && pc.connectionState === 'connected') this.update({ status: 'Connected' });
    } else if (candidate && !peer.ignoreOffer) {
      if (!pc.remoteDescription) peer.candidates.push(candidate);
      else await pc.addIceCandidate(candidate);
    }
  }
  setMedia(patch) { this.update(patch); this.uplink?.syncTracks().catch(e => this.onError(e.message)); if (this.credentials && 'consent' in patch) this.credentials.consent = patch.consent; this.socket?.emit('media', patch); }
  toggleMic() { const mic = !this.state.mic; this.local?.getAudioTracks().forEach(t => { t.enabled = mic; }); this.setMedia({ mic }); }
  watchCamera(track) {
    track.onended = () => {
      if (this.disposed) return;
      this.local?.removeTrack(track);
      this.setMedia({ camera: false });
      this.update({ cameraError: 'The camera disconnected or stopped. Select a camera and click Apply / retry camera.' });
    };
  }
  async toggleCamera() {
    if (this.cameraBusy) return;
    if (!this.state.camera) return this.switchCamera(this.cameraId);
    this.local?.getVideoTracks().forEach(track => { track.onended = null; track.stop(); this.local.removeTrack(track); });
    this.setMedia({ camera: false });
    if (this.peer?.cameraSender) await this.peer.cameraSender.replaceTrack(null);
  }
  async switchCamera(deviceId = '') {
    if (this.cameraBusy || this.disposed) return;
    this.cameraBusy = true; this.cameraId = deviceId;
    this.update({ cameraBusy: true, cameraError: '' });
    // Release the previous camera before reopening: Windows devices can be exclusive.
    this.local?.getVideoTracks().forEach(track => { track.onended = null; track.stop(); this.local.removeTrack(track); });
    this.setMedia({ camera: false });
    let track;
    try {
      if (this.peer?.cameraSender) await this.peer.cameraSender.replaceTrack(null);
      track = await openCamera(deviceId);
      if (this.disposed) { track.stop(); return; }
      if (this.peer?.cameraSender) await this.peer.cameraSender.replaceTrack(track);
      this.local.addTrack(track); this.watchCamera(track);
      this.setMedia({ camera: true });
    } catch (error) {
      track?.stop();
      this.update({ cameraError: cameraMessage(error) });
    } finally {
      this.cameraBusy = false;
      this.update({ cameraBusy: false });
    }
  }
  async startScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing requires a supported desktop browser.');
    if (!this.peer?.screenSender || this.state.connection !== 'connected') throw new Error('Wait for the call to connect before sharing.');
    const peer = this.peer;
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } }, audio: false });
    try {
      if (this.disposed || peer !== this.peer) throw new Error('The other participant left while you chose a screen.');
      await peer.screenSender.replaceTrack(screen.getVideoTracks()[0]);
      this.screen = screen;
      screen.getVideoTracks()[0].onended = () => this.stopScreen();
      this.setMedia({ sharing: true, localScreen: screen });
    } catch (error) { screen.getTracks().forEach(t => t.stop()); throw error; }
  }
  async stopScreen() {
    const screen = this.screen; this.screen = null;
    screen?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    try { await this.peer?.screenSender.replaceTrack(null); } catch { /* Peer may already be closed. */ }
    this.setMedia({ sharing: false, localScreen: null });
  }
  sendChat(text) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('Signaling is disconnected.'));
      this.socket.timeout(5000).emit('chat', { text }, (error, result) => error || result?.error ? reject(new Error(result?.error || 'Message timed out.')) : resolve());
    });
  }
  async startRecording() {
    if (this.state.connection !== 'connected') throw new Error('Wait for the call to connect.');
    await this.recordCommand('recording-start');
  }
  stopRecording() { if (this.state.recording) this.recordCommand('recording-stop').catch(e => this.onError(e.message)); }
  recordCommand(event) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) return reject(new Error('Signaling is disconnected.'));
      this.socket.timeout(15000).emit(event, {}, (err, result) => err || result?.error ? reject(new Error(result?.error || 'Recording request timed out.')) : resolve(result));
    });
  }
  async restartIce() {
    if (!this.peer) return;
    if (this.peer.polite) this.peer.send({restart: true});
    else { await this.peer.pc.setLocalDescription(await this.peer.pc.createOffer({iceRestart: true})); this.peer.send({description: this.peer.pc.localDescription}); }
    this.update({ status: 'Retrying media connection' });
  }
  async readStats() {
    const peer = this.peer;
    if (!peer || peer.pc.connectionState !== 'connected') return;
    const report = await peer.pc.getStats();
    let pair;
    report.forEach(stat => { if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = report.get(stat.selectedCandidatePairId); });
    if (!pair) report.forEach(stat => { if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) pair = stat; });
    if (pair) {
      const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
      this.update({ stats: { path: local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN relay' : 'Direct peer connection', rtt: Math.round((pair.currentRoundTripTime || 0) * 1000) } });
    }
  }
  closePeer() {
    this.uplink?.close();
    if (this.peer) { this.peer.pc.onconnectionstatechange = null; this.peer.pc.close(); this.peer = null; }
    this.update({ remote: null, remoteScreen: null, connection: 'new', stats: {} });
  }
  leave() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.statsTimer);
    this.closePeer();
    this.screen?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    this.local?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    this.socket?.emit('leave'); this.socket?.disconnect();
    this.update({ status: 'Call ended', local: null, localScreen: null, sharing: false, peers: [] });
  }
}
