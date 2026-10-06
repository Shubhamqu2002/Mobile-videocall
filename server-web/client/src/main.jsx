import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PeerRoom } from "./rtc/PeerRoom";
import "./styles.css";
import {
  API_BASE_URL,
  checkBackendTransport,
  readInvitation,
  makeInvitation,
} from "./config";

function Icon({ name, ...props }) {
  const paths = {
    video: (
      <>
        <rect x="3" y="6" width="12" height="12" rx="3" />
        <path d="m15 10 6-3v10l-6-3" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    link: (
      <>
        <path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" />
      </>
    ),
    screen: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4m-3-11 3-3 3 3m-3-3v7" />
      </>
    ),
    chat: <path d="M21 11a8 8 0 0 1-8 8H4l1-4a8 8 0 1 1 16-4Z" />,
    record: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="2" width="6" height="13" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
      </>
    ),
    phone: <path d="M3 15v-4c5-5 13-5 18 0v4l-5-1v-3a12 12 0 0 0-8 0v3z" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />
      </>
    ),
  };
  return (
    <svg
      className="icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name] || paths.video}
    </svg>
  );
}

function Video({
  stream,
  muted = false,
  name,
  enabled = true,
  screen = false,
}) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const video = ref.current;
    let current = true;
    video.srcObject = stream || null;
    setBlocked(false);
    if (stream)
      video
        .play()
        .then(() => current && setBlocked(false))
        .catch(() => current && setBlocked(true));
    return () => {
      current = false;
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <div className={`video-tile ${screen ? "screen-tile" : ""}`}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={enabled && stream ? "" : "hidden-video"}
      />
      {(!stream || !enabled) && (
        <div className="video-placeholder">
          <span>{name?.slice(0, 1).toUpperCase() || "?"}</span>
          <p>{stream ? "Camera is off" : "Waiting for participant"}</p>
        </div>
      )}
      <div className="video-label">
        <span className="live-dot" />
        {name}
      </div>
      {muted && !screen && <span className="you-badge">YOU</span>}
      {blocked && (
        <button
          className="play-button"
          onClick={() =>
            ref.current
              .play()
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true))
          }
        >
          Play audio / video
        </button>
      )}
    </div>
  );
}

function CameraPicker({ id, cameras, value, onChange, refresh, disabled }) {
  return (
    <div className="camera-picker">
      <label htmlFor={id}>Camera device</label>
      <div className="camera-input">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">Default camera</option>
          {cameras.map((camera, i) => (
            <option key={camera.deviceId || i} value={camera.deviceId}>
              {camera.label || `Camera ${i + 1}`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button-quiet"
          onClick={refresh}
          disabled={disabled}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}

function Preferences({ value, onChange, disabled }) {
  return (
    <div className="preferences">
      <label className="check">
        <input
          type="checkbox"
          checked={value.audioOnly}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, audioOnly: e.target.checked })}
        />
        <span>Start with audio only</span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={value.consent}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, consent: e.target.checked })}
        />
        <span>Allow server recording</span>
      </label>
      <p className="form-help">
        Recording needs every participant’s consent. Files are stored on your
        server for 24 hours by default.
      </p>
    </div>
  );
}

const emptyState = {
  peers: [],
  participants: [],
  messages: [],
  recordings: [],
  status: "Ready",
  stats: {},
};

function App() {
  const [host, setHost] = useState({
    name: "",
    audioOnly: false,
    consent: false,
  });
  const [guest, setGuest] = useState({
    name: "",
    audioOnly: false,
    consent: false,
  });
  const [name, setName] = useState("");
  const [invite, setInvite] = useState(location.hash ? location.href : "");
  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState("");
  const [pending, setPending] = useState(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chat, setChat] = useState("");
  const [downloads, setDownloads] = useState([]);
  const [state, setState] = useState(emptyState);
  const controller = useRef(null);
  const joining = useRef(false);
  const acting = useRef(false);
  const chatLog = useRef(null);
  const alive = useRef(true);
  const busy = pending !== null;

  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      if (alive.current)
        setCameras(
          (devices || []).filter((d) => d.kind === "videoinput" && d.deviceId)
        );
    } catch (err) {
      if (alive.current) setError(`Could not list cameras: ${err.message}`);
    }
  }
  useEffect(() => {
    alive.current = true;
    document.title = "AI Interview Room";
    refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    const warn = (event) => {
      if (controller.current && !controller.current.disposed) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      alive.current = false;
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        refreshDevices
      );
      window.removeEventListener("beforeunload", warn);
      controller.current?.leave();
    };
  }, []);
  useEffect(() => {
    const log = chatLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.messages.length]);

  async function enter(mode) {
    if (joining.current) return;
    const profile = mode === "create" ? host : guest;
    setError("");
    setNotice("");
    if (!profile.name.trim())
      return setError(
        `Enter your name in the ${
          mode === "create" ? "Create Room" : "Join Room"
        } panel.`
      );
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      return setError(
        "Open http://localhost:3001 (or localhost:5173 in development) on the server PC, or use HTTPS for browser calls."
      );
    joining.current = true;
    setPending(mode);
    let call;
    try {
      checkBackendTransport();
      let roomId, roomKey;
      if (mode === "create") {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 12000);
        try {
          const response = await fetch(`${API_BASE_URL}/api/rooms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: abort.signal,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok)
            throw new Error(
              result.error ||
                `Server returned HTTP ${response.status}. Check that the Node server is running.`
            );
          ({ roomId, roomKey } = result);
        } finally {
          clearTimeout(timeout);
        }
      } else {
        ({ roomId, roomKey } = readInvitation(invite));
      }
      if (!roomId || !roomKey)
        throw new Error(
          "The room invitation is incomplete. Copy a new link from the host."
        );
      const url = new URL(location.origin + "/");
      url.hash = new URLSearchParams({ room: roomId, key: roomKey }).toString();
      history.replaceState(null, "", url);
      setInvite(makeInvitation(roomId, roomKey));
      setName(profile.name.trim());
      controller.current?.leave();
      call = new PeerRoom({
        onChange: (snapshot) => {
          if (!alive.current || controller.current !== call) return;
          setState(snapshot);
          if (call.disposed) setActive(false);
          if (snapshot.recordings?.length)
            setDownloads((old) => [
              ...old,
              ...snapshot.recordings.filter(
                (r) => !old.some((o) => o.url === r.url)
              ),
            ]);
        },
        onError: (message) => {
          if (alive.current && controller.current === call) setError(message);
        },
      });
      controller.current = call;
      await call.join({
        roomId,
        roomKey,
        name: profile.name.trim(),
        consent: profile.consent,
        cameraId,
        audioOnly: profile.audioOnly,
      });
      if (alive.current && !call.disposed) {
        setActive(true);
        await refreshDevices();
      }
    } catch (err) {
      call?.leave();
      if (alive.current)
        setError(
          err.name === "AbortError"
            ? "The server took too long to respond. Check the server terminal and retry."
            : err instanceof TypeError
            ? `Cannot reach ${API_BASE_URL}. Check backend availability, CORS and HTTPS settings.`
            : err.message
        );
    } finally {
      joining.current = false;
      if (alive.current) setPending(null);
    }
  }
  async function action(fn) {
    if (acting.current) return;
    acting.current = true;
    setControlBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(
        err.name === "NotAllowedError"
          ? "Permission was denied or screen selection was cancelled."
          : err.message
      );
    } finally {
      acting.current = false;
      if (alive.current) setControlBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite);
      setNotice("Invitation copied. Share it with your participants.");
    } catch {
      setNotice("Copy the invitation from the invitation field below.");
    }
  }
  function leave() {
    if (
      ["starting", "recording", "stopping"].includes(
        state.serverRecording?.status
      ) &&
      !window.confirm(
        "Leave while recording? Stop recording and wait for the download first if you want to save it here."
      )
    )
      return;
    controller.current?.leave();
    setActive(false);
    setChat("");
    setNotice(
      "You have left the room. Any available recordings are listed below."
    );
  }
  const participants = state.participants || [];
  const recordingStatus = state.serverRecording?.status;
  const recording =
    ["starting", "recording", "stopping"].includes(recordingStatus) ||
    state.recording;
  const canRecord =
    state.connection === "connected" &&
    state.peers.length >= 2 &&
    state.peers.every((p) => p.consent);

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-symbol">
            <Icon name="video" />
          </span>
          <span>
            AI Interview <b>Room</b>
            <small>A SPACE FOR BETTER CONVERSATIONS</small>
          </span>
        </div>
        <span className="header-tag">
          <span className="live-dot" />
          Group video workspace
        </span>
      </header>
      <main>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            <span>{notice}</span>
            <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {!active ? (
          <>
            <section className="hero">
              <div className="eyebrow">
                <span />
                YOUR NEXT CONVERSATION STARTS HERE
              </div>
              <h1>
                Make room for
                <br />
                <em>a great interview.</em>
              </h1>
              <p>
                A focused space to meet, share your thinking, and connect.
                <br className="desktop-break" /> Create a room or join someone
                who’s already there.
              </p>
              <div className="hero-features">
                <span>
                  <Icon name="video" />
                  Video & audio
                </span>
                <span>
                  <Icon name="screen" />
                  Screen sharing
                </span>
                <span>
                  <Icon name="chat" />
                  Live chat
                </span>
                <span>
                  <Icon name="record" />
                  Call recording
                </span>
              </div>
            </section>
            <section
              className="entry-grid"
              aria-label="Create or join an interview room"
            >
              <form
                className="entry-card create-card"
                aria-labelledby="create-title"
                onSubmit={(e) => {
                  e.preventDefault();
                  enter("create");
                }}
              >
                <div className="card-top">
                  <span className="card-icon">
                    <Icon name="plus" />
                  </span>
                  <span className="card-tag">START A CONVERSATION</span>
                  <span className="card-number">01</span>
                </div>
                <h2 id="create-title">Create Room</h2>
                <p className="card-description">
                  Your room. Your next great conversation.
                  <br />
                  Start a session and invite your participants.
                </p>
                <label className="field-label" htmlFor="host-name">
                  Your name
                </label>
                <div className="input-wrap">
                  <Icon name="user" />
                  <input
                    id="host-name"
                    autoComplete="name"
                    placeholder="e.g. Shubham Sinha"
                    maxLength={40}
                    required
                    disabled={busy}
                    value={host.name}
                    onChange={(e) => setHost({ ...host, name: e.target.value })}
                  />
                </div>
                <div className="invite-preview" aria-hidden="true">
                  <div className="avatar-stack">
                    <span>You</span>
                    <span>
                      <Icon name="plus" />
                    </span>
                  </div>
                  <div>
                    <strong>A room for your group</strong>
                    <small>Your invitation link is created instantly.</small>
                  </div>
                </div>
                <Preferences value={host} onChange={setHost} disabled={busy} />
                <button
                  type="submit"
                  className="button button-orange entry-submit"
                  disabled={busy}
                >
                  {pending === "create"
                    ? "Creating your room…"
                    : "Create a room"}
                  <Icon name="arrow" />
                </button>
                <span className="card-caption">
                  <Icon name="link" />
                  Create. Copy the link. Connect.
                </span>
              </form>
              <form
                className="entry-card join-card"
                aria-labelledby="join-title"
                onSubmit={(e) => {
                  e.preventDefault();
                  enter("join");
                }}
              >
                <div className="card-top">
                  <span className="card-icon">
                    <Icon name="link" />
                  </span>
                  <span className="card-tag">HAVE AN INVITATION?</span>
                  <span className="card-number">02</span>
                </div>
                <h2 id="join-title">Join Room</h2>
                <p className="card-description">
                  A familiar face is one click away.
                  <br />
                  Enter your name and the full invitation link.
                </p>
                <label className="field-label" htmlFor="guest-name">
                  Your name
                </label>
                <div className="input-wrap">
                  <Icon name="user" />
                  <input
                    id="guest-name"
                    autoComplete="name"
                    placeholder="e.g. Ananya Das"
                    maxLength={40}
                    required
                    disabled={busy}
                    value={guest.name}
                    onChange={(e) =>
                      setGuest({ ...guest, name: e.target.value })
                    }
                  />
                </div>
                <label className="field-label invite-label" htmlFor="invite">
                  Invitation link
                </label>
                <div className="input-wrap">
                  <Icon name="link" />
                  <input
                    id="invite"
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the complete room invitation"
                    required
                    disabled={busy}
                    value={invite}
                    onChange={(e) => setInvite(e.target.value)}
                  />
                </div>
                <Preferences
                  value={guest}
                  onChange={setGuest}
                  disabled={busy}
                />
                <button
                  type="submit"
                  className="button button-navy entry-submit"
                  disabled={busy}
                >
                  {pending === "join" ? "Joining your room…" : "Join room"}
                  <Icon name="arrow" />
                </button>
                <span className="card-caption">
                  <Icon name="check" />
                  Use the link shared by your host.
                </span>
              </form>
            </section>
            <details className="device-settings">
              <summary>
                <Icon name="settings" />
                <span>
                  Camera & device settings
                  <small>Optional · applies to either room option</small>
                </span>
                <span className="summary-plus">+</span>
              </summary>
              <div className="device-body">
                <CameraPicker
                  id="lobby-camera"
                  cameras={cameras}
                  value={cameraId}
                  onChange={setCameraId}
                  refresh={refreshDevices}
                  disabled={busy}
                />
                <p className="muted">
                  Your browser will ask for camera and microphone access when
                  you enter. Camera names may appear after you allow access.
                </p>
              </div>
            </details>
            <div className="how-it-works">
              <span>
                <b>01</b> Choose your room
              </span>
              <span>
                <b>02</b> Allow camera & mic
              </span>
              <span>
                <b>03</b> Start the conversation
              </span>
            </div>
          </>
        ) : (
          <>
            <section className="room-heading">
              <div>
                <div className="eyebrow">YOUR INTERVIEW WORKSPACE</div>
                <h1>
                  Good to see you, <em>{name}.</em>
                </h1>
                <p className="muted">
                  {participants.length
                    ? `${state.peers.length} people in this room. Each participant has a separate media connection.`
                    : "Your room is ready. Share the invitation to bring someone in."}
                </p>
              </div>
              <div className="room-actions">
                <span
                  className={`connection ${
                    state.connection === "connected" ? "connected" : ""
                  }`}
                >
                  <span className="live-dot" />
                  {state.status}
                </span>
                <button className="button button-navy" onClick={copy}>
                  <Icon name="link" />
                  Copy invite
                </button>
              </div>
            </section>
            <label className="group-invite">
              Room invitation
              <input
                readOnly
                value={invite}
                onFocus={(event) => event.target.select()}
              />
            </label>
            {state.cameraError && (
              <div className="banner warning" role="status">
                <span>
                  <strong>
                    Camera unavailable — room opened with audio only.
                  </strong>
                  <br />
                  {state.cameraError}
                </span>
              </div>
            )}
            {recording && (
              <div className="record-banner" role="status">
                <Icon name="record" />
                {recordingStatus === "starting"
                  ? "Connecting server recorder…"
                  : recordingStatus === "stopping"
                  ? "Saving your recording…"
                  : "Server recording active"}
                <span>Stored temporarily on your server</span>
              </div>
            )}
            <div className="room-layout">
              <section className="call-area" aria-label="Video call">
                <div className="video-grid">
                  <Video
                    stream={state.local}
                    muted
                    name={`${name} · You`}
                    enabled={state.camera}
                  />
                  {participants.map((participant) => (
                    <Video
                      key={participant.id}
                      stream={participant.stream}
                      name={`${participant.name} · ${participant.connection}`}
                      enabled={participant.camera !== false}
                    />
                  ))}
                </div>
                {(state.sharing || participants.some((p) => p.sharing)) && (
                  <div className="screen-grid">
                    {state.sharing && (
                      <Video
                        stream={state.localScreen}
                        muted
                        name="Your shared screen"
                        screen
                      />
                    )}
                    {participants
                      .filter((p) => p.sharing)
                      .map((participant) => (
                        <Video
                          key={participant.id}
                          stream={participant.screenStream}
                          muted
                          name={`${participant.name}'s screen`}
                          screen
                        />
                      ))}
                  </div>
                )}
                <div className="toolbar" aria-label="Call controls">
                  <button
                    disabled={controlBusy}
                    className={!state.mic ? "off" : ""}
                    onClick={() => action(() => controller.current.toggleMic())}
                  >
                    <Icon name="mic" />
                    {state.mic ? "Mute mic" : "Unmute mic"}
                  </button>
                  <button
                    disabled={controlBusy || state.cameraBusy}
                    className={!state.camera ? "off" : ""}
                    onClick={() =>
                      action(() => controller.current.toggleCamera())
                    }
                  >
                    <Icon name="video" />
                    {state.camera ? "Camera off" : "Camera on"}
                  </button>
                  <button
                    disabled={controlBusy || state.connection !== "connected"}
                    className={state.sharing ? "selected" : ""}
                    onClick={() =>
                      action(() =>
                        state.sharing
                          ? controller.current.stopScreen()
                          : controller.current.startScreen()
                      )
                    }
                  >
                    <Icon name="screen" />
                    {state.sharing ? "Stop sharing" : "Share screen"}
                  </button>
                  <button
                    disabled={
                      controlBusy ||
                      recordingStatus === "stopping" ||
                      (!recording && !canRecord)
                    }
                    className={recording ? "off" : ""}
                    onClick={() =>
                      action(() =>
                        controller.current.recordCommand(
                          recording ? "recording-stop" : "recording-start"
                        )
                      )
                    }
                  >
                    <Icon name="record" />
                    {recordingStatus === "stopping"
                      ? "Saving…"
                      : recording
                      ? "Stop recording"
                      : "Record call"}
                  </button>
                  <button className="leave" onClick={leave}>
                    <Icon name="phone" />
                    Leave call
                  </button>
                </div>
                <div className="call-footer">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!!state.consent}
                      onChange={(e) =>
                        controller.current.setMedia({
                          consent: e.target.checked,
                        })
                      }
                    />
                    <span>Allow recording</span>
                  </label>
                  <span>
                    {state.stats.path || "Connecting media"}
                    {state.stats.rtt !== undefined
                      ? ` · ${state.stats.rtt} ms`
                      : ""}
                  </span>
                  <button
                    className="text-button"
                    disabled={controlBusy || !participants.length}
                    onClick={() =>
                      action(() => controller.current.restartIce())
                    }
                  >
                    Reconnect media
                  </button>
                </div>
                <details className="device-settings">
                  <summary>
                    <Icon name="settings" />
                    <span>Camera & connection settings</span>
                    <span className="summary-plus">+</span>
                  </summary>
                  <div className="device-body">
                    <CameraPicker
                      id="call-camera"
                      cameras={cameras}
                      value={cameraId}
                      onChange={setCameraId}
                      refresh={refreshDevices}
                      disabled={state.cameraBusy || controlBusy}
                    />
                    <button
                      className="button button-quiet"
                      disabled={state.cameraBusy || controlBusy}
                      onClick={() =>
                        action(async () => {
                          await controller.current.switchCamera(cameraId);
                          await refreshDevices();
                        })
                      }
                    >
                      Apply / retry camera
                    </button>
                    {!state.hasTurn && (
                      <p className="muted">
                        No TURN relay configured. Calls across different
                        networks may need a TURN server.
                      </p>
                    )}
                  </div>
                </details>
                <p className="room-note">
                  Everyone must allow recording. Recording stops when someone
                  joins or leaves. Recordings include voices, cameras and shared
                  screens; device/system audio is not captured.
                </p>
              </section>
              <aside className="chat-panel">
                <div className="chat-header">
                  <h2>
                    <Icon name="chat" />
                    Room chat
                  </h2>
                  <span>
                    {state.peers.length}{state.maxParticipants > 0 ? `/${state.maxParticipants}` : ""} people
                  </span>
                </div>
                <div
                  className="messages"
                  ref={chatLog}
                  role="log"
                  aria-label="Room messages"
                  aria-live="polite"
                >
                  {!state.messages.length && (
                    <div className="empty-chat">
                      <span>
                        <Icon name="chat" />
                      </span>
                      <h3>Start with a hello.</h3>
                      <p>
                        Share a thought or a link.
                        <br />
                        Messages stay in this room temporarily.
                      </p>
                    </div>
                  )}
                  {state.messages.map((m) => (
                    <div
                      className={`message ${
                        m.from === state.selfId ? "mine" : ""
                      }`}
                      key={m.id}
                    >
                      <div className="message-meta">
                        <b>{m.name}</b>
                        <time>
                          {new Date(m.at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <p>{m.text}</p>
                    </div>
                  ))}
                </div>
                <form
                  className="chat-compose"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = chat.trim();
                    if (text)
                      action(async () => {
                        await controller.current.sendChat(text);
                        setChat((current) =>
                          current.trim() === text ? "" : current
                        );
                      });
                  }}
                >
                  <label className="sr-only" htmlFor="chat">
                    Message
                  </label>
                  <input
                    id="chat"
                    placeholder="Write a message…"
                    maxLength={2000}
                    value={chat}
                    onChange={(e) => setChat(e.target.value)}
                  />
                  <button
                    className="button button-navy"
                    aria-label="Send message"
                    disabled={!chat.trim() || controlBusy}
                  >
                    <Icon name="arrow" />
                  </button>
                </form>
              </aside>
            </div>
          </>
        )}
        {!!downloads.length && (
          <section className="downloads">
            <h2>Your recordings</h2>
            <p className="muted">
              Download before closing this page. Server files expire after 24
              hours by default.
            </p>
            {downloads.map((file) => (
              <a key={file.url} href={file.url} download={file.name}>
                <Icon name="download" />
                <span>{file.name}</span>
                <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
              </a>
            ))}
          </section>
        )}
      </main>
      <footer className="site-footer">
        <span>AI Interview Room</span>
        <span>Built for focused, face-to-face conversations.</span>
        <span>VIDEO · SCREEN · CHAT</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
