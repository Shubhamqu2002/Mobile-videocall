// REST and Socket.IO always use this backend, independently of frontend hosting.
export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://111.118.189.182:3003"
).replace(/\/+$/, "");

// Links shared with mobile identify the backend that owns the room.
export const INVITE_BASE_URL = API_BASE_URL;
// Allow old backend-address invites after adding an HTTPS API domain.
export const LEGACY_INVITE_ORIGINS = ["http://111.118.189.182:3003"];

export function checkBackendTransport() {
  if (location.protocol === "https:" && API_BASE_URL.startsWith("http:")) {
    throw new Error(
      "This HTTPS website requires an HTTPS API/WebSocket endpoint. Configure TLS on the backend and update API_BASE_URL."
    );
  }
}
export function readInvitation(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Paste the complete room invitation URL.");
  }
  const allowed = new Set([
    new URL(API_BASE_URL).origin,
    location.origin,
    ...LEGACY_INVITE_ORIGINS,
  ]);
  if (!["http:", "https:"].includes(url.protocol) || !allowed.has(url.origin)) {
    throw new Error(
      "This invitation is not from the configured backend or this frontend."
    );
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const roomId = params.get("room"),
    roomKey = params.get("key");
  if (!roomId || !roomKey)
    throw new Error("The invitation must contain #room= and &key=.");
  return { roomId, roomKey };
}
export function makeInvitation(roomId, roomKey) {
  return `${INVITE_BASE_URL}/#${new URLSearchParams({
    room: roomId,
    key: roomKey,
  })}`;
}
