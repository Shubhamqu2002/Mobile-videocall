import { MeshRoom } from "./MeshRoom";
import { openCamera, cameraMessage } from "./camera";
import { API_BASE_URL, checkBackendTransport } from "../config";

export class PeerRoom extends MeshRoom {
  constructor(options) {
    super(options, { RTCPeerConnection, MediaStream });
  }
  async join({ cameraId = "", audioOnly = false, ...credentials }) {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Open this frontend on localhost for development, or HTTPS for public browser calls."
      );
    }
    checkBackendTransport();
    this.cameraId = cameraId;
    this.update({
      consent: credentials.consent,
      status: "Requesting camera and microphone",
    });
    this.local = new MediaStream();
    let cameraError = "";
    try {
      if (!audioOnly) {
        try {
          this.local.addTrack(await openCamera(cameraId));
        } catch (error) {
          cameraError = cameraMessage(error);
        }
      }
      if (this.disposed) {
        this.local.getTracks().forEach((t) => t.stop());
        return;
      }
      const audio = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      audio.getTracks().forEach((track) => this.local.addTrack(track));
      if (this.disposed) {
        this.local.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = this.local.getVideoTracks()[0];
      if (track) this.watchCamera(track);
      this.update({ local: this.local, camera: !!track, cameraError });
      await this.connect({ ...credentials, serverUrl: API_BASE_URL });
    } catch (error) {
      this.leave();
      throw error;
    }
  }
  captureCamera(deviceId) {
    return openCamera(deviceId);
  }
  captureScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia)
      throw new Error("Screen sharing needs a supported desktop browser.");
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 10, max: 15 },
      },
      audio: false,
    });
  }
}
