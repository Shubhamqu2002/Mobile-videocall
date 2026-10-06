import 'react-native-url-polyfill/auto';
import {
  RTCPeerConnection,
  MediaStream,
  mediaDevices,
} from 'react-native-webrtc';
import {
  PermissionsAndroid,
  Platform,
  NativeModules,
  DeviceEventEmitter,
} from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { MeshRoom } from './MeshRoom';

export class PeerRoom extends MeshRoom {
  constructor(options) {
    super(options, { RTCPeerConnection, MediaStream });
  }
  async captureCamera() {
    if (Platform.OS === 'android') {
      const permission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
      );
      if (permission !== PermissionsAndroid.RESULTS.GRANTED)
        throw new Error('Allow camera access in Android app settings.');
      if (this.disposed) throw new Error('Call ended.');
      await NativeModules.CallService.start();
    }
    const stream = await mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: 640, height: 480, frameRate: 15 },
    });
    return stream.getVideoTracks()[0];
  }
  async join({ cameraId = '', audioOnly = false, ...credentials }) {
    this.cameraId = cameraId;
    this.update({
      consent: credentials.consent,
      status: 'Requesting camera and microphone',
    });
    try {
      if (Platform.OS === 'android') {
        const permission = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (permission !== PermissionsAndroid.RESULTS.GRANTED)
          throw new Error('Allow microphone access in Android app settings.');
        if (!audioOnly) {
          const camera = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.CAMERA,
          );
          if (camera !== PermissionsAndroid.RESULTS.GRANTED) audioOnly = true;
        }
        if (Number(Platform.Version) >= 31)
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          );
        if (Number(Platform.Version) >= 33)
          await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          );
        if (this.disposed) return;
        await NativeModules.CallService.start();
        if (this.disposed) {
          NativeModules.CallService.stop();
          return;
        }
        this.nativeEnd = DeviceEventEmitter.addListener('NativeCallEnded', () =>
          this.leave(),
        );
      }
      this.local = new MediaStream();
      let cameraError = '';
      if (!audioOnly) {
        try {
          this.local.addTrack(await this.captureCamera());
        } catch (error) {
          cameraError = error.message;
        }
      }
      if (this.disposed) {
        this.local.getTracks().forEach(t => t.stop());
        return;
      }
      const audio = await mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audio.getTracks().forEach(track => this.local.addTrack(track));
      if (this.disposed) {
        this.local.getTracks().forEach(t => t.stop());
        return;
      }
      const track = this.local.getVideoTracks()[0];
      if (track) this.watchCamera(track);
      InCallManager.start({ media: 'video' });
      InCallManager.setForceSpeakerphoneOn(true);
      this.update({
        local: this.local,
        camera: !!track,
        cameraError,
        speaker: true,
        front: true,
      });
      await this.connect(credentials);
    } catch (error) {
      this.leave();
      throw error;
    }
  }
  async captureScreen() {
    if (Platform.OS !== 'android')
      throw new Error(
        'iOS screen broadcasting requires a ReplayKit extension.',
      );
    this.inSystemPrompt = true;
    try {
      return await mediaDevices.getDisplayMedia();
    } finally {
      this.inSystemPrompt = false;
    }
  }
  flipCamera() {
    const track = this.local?.getVideoTracks()[0];
    if (!track || this.disposed) return;
    track._switchCamera();
    this.update({ front: this.state.front === false });
  }
  toggleSpeaker() {
    const speaker = !this.state.speaker;
    InCallManager.setForceSpeakerphoneOn(speaker);
    this.update({ speaker });
  }
  onPlatformLeave() {
    this.nativeEnd?.remove();
    NativeModules.CallService?.stop();
    InCallManager.stop();
  }
}
