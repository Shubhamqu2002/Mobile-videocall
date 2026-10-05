// Open video independently from audio, preserving the explicitly selected device.
export async function openCamera(deviceId = '') {
  const device = deviceId ? { deviceId: { exact: deviceId } } : {};
  const attempts = [
    { ...device, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
    deviceId ? device : true,
  ];
  let lastError;
  for (const video of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const track = stream.getVideoTracks()[0];
      if (track?.readyState === 'live') return track;
      stream.getTracks().forEach(t => t.stop());
      throw new DOMException('The camera returned no live video track.', 'NotReadableError');
    } catch (error) {
      lastError = error;
      // Retrying cannot grant permission or restore a disconnected device.
      if (['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error.name)) break;
    }
  }
  throw lastError;
}

export function cameraMessage(error) {
  const detail = `${error?.name || 'CameraError'}: ${error?.message || 'Camera could not start.'}`;
  if (error?.name === 'NotAllowedError') return `${detail} Allow this site's camera access, then retry.`;
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return `${detail} Refresh the camera list and select an available device.`;
  return `${detail} Select your physical webcam below and click Apply / retry camera. If Windows Camera is open, close it first so it releases the device.`;
}
