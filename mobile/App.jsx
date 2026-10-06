import 'react-native-url-polyfill/auto';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RTCView } from 'react-native-webrtc';
import { PeerRoom } from './src/PeerRoom';
import {
  SERVER_URL,
  REQUEST_TIMEOUT_MS,
  normalizeServerUrl,
} from './src/config';

const initial = {
  peers: [],
  participants: [],
  messages: [],
  recordings: [],
  stats: {},
  status: 'Ready',
  mic: true,
  camera: true,
  front: true,
  connection: 'new',
};
const profile = { name: '', audioOnly: false, consent: false };

function Button({ title, onPress, disabled, secondary, danger, compact }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        danger && s.danger,
        compact && s.compact,
        (pressed || disabled) && s.dim,
      ]}
    >
      <Text style={s.buttonText}>{title}</Text>
    </Pressable>
  );
}
function Field({ label, multiline, ...props }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor="#748497"
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={[s.input, multiline && s.multiline]}
        {...props}
      />
    </View>
  );
}
function Toggle({ label, value, onValueChange, disabled }) {
  return (
    <View style={s.toggle}>
      <Text style={s.toggleText}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={!!value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: '#3a4858', true: '#307f73' }}
        thumbColor="#ffffff"
      />
    </View>
  );
}
function ProfileFields({ value, onChange, busy }) {
  return (
    <>
      <Field
        label="Your name"
        value={value.name}
        editable={!busy}
        maxLength={40}
        autoCapitalize="words"
        placeholder="Enter your display name"
        onChangeText={name => onChange({ ...value, name })}
      />
      <Toggle
        label="Start with audio only"
        value={value.audioOnly}
        disabled={busy}
        onValueChange={audioOnly => onChange({ ...value, audioOnly })}
      />
      <Toggle
        label="Allow server recording"
        value={value.consent}
        disabled={busy}
        onValueChange={consent => onChange({ ...value, consent })}
      />
    </>
  );
}
function Tile({ stream, label, enabled, mirror, screen, wide, local }) {
  const track = stream?.getVideoTracks()[0];
  return (
    <View style={[s.tile, wide && s.wideTile, screen && s.screenTile]}>
      {stream && track && enabled ? (
        <RTCView
          key={track.id}
          style={StyleSheet.absoluteFill}
          streamURL={stream.toURL()}
          mirror={!!mirror}
          objectFit={screen ? 'contain' : 'cover'}
          zOrder={0}
        />
      ) : (
        <View style={s.placeholder}>
          <View style={s.avatarCircle}>
            <Text style={s.avatar}>{label.slice(0, 1).toUpperCase()}</Text>
          </View>
          <Text style={s.muted}>
            {local || stream ? 'Camera is off' : 'Waiting for participant'}
          </Text>
        </View>
      )}
      <View style={s.videoLabel}>
        <Text numberOfLines={2} style={s.label}>
          {label}
        </Text>
      </View>
    </View>
  );
}

function AppContent() {
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  const [server, setServer] = useState(SERVER_URL);
  const [host, setHost] = useState({ ...profile });
  const [guest, setGuest] = useState({ ...profile });
  const [invite, setInvite] = useState('');
  const [name, setName] = useState('');
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const [showChat, setShowChat] = useState(false);
  const [downloads, setDownloads] = useState([]);
  const controller = useRef(null);
  const mounted = useRef(false);
  const actionLock = useRef(false);
  const chatScroll = useRef(null);
  const pendingRequest = useRef(null);
  const recordingStatus = state.serverRecording?.status;
  const recordingBusy = ['starting', 'recording', 'stopping'].includes(
    recordingStatus,
  );
  const participants = state.participants || [];
  const canRecord =
    state.connection === 'connected' &&
    state.peers.length >= 2 &&
    state.peers.every(p => p.consent);
  const locked = busy || !ready;

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    // Saved local addresses from the previous app are deliberately not reused.
    // Dev overrides survive reloads only while SERVER_URL stays unchanged.
    AsyncStorage.multiGet([
      'ai-room-config',
      'ai-room-server',
      'ai-room-host',
      'ai-room-guest',
    ])
      .then(entries => {
        if (cancelled) return;
        const saved = Object.fromEntries(entries);
        if (
          __DEV__ &&
          saved['ai-room-config'] === SERVER_URL &&
          saved['ai-room-server']
        ) {
          setServer(saved['ai-room-server']);
        }
        if (saved['ai-room-host'])
          setHost(p => ({ ...p, name: saved['ai-room-host'] }));
        if (saved['ai-room-guest'])
          setGuest(p => ({ ...p, name: saved['ai-room-guest'] }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
      pendingRequest.current?.abort();
      const call = controller.current;
      controller.current = null;
      call?.leave();
    };
  }, []);

  function leave() {
    const call = controller.current;
    controller.current = null;
    call?.leave();
    setActive(false);
    setShowChat(false);
    setMessage('');
    setState(initial);
  }
  function confirmLeave() {
    Alert.alert(
      'Leave this room?',
      recordingBusy
        ? 'Recording is still running or saving. Stop recording and wait for its download link before leaving.'
        : 'Your camera and microphone will stop.',
      [
        { text: 'Stay', style: 'cancel' },
        { text: 'Leave', style: 'destructive', onPress: leave },
      ],
    );
  }
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (showChat) {
        setShowChat(false);
        return true;
      }
      if (active) {
        confirmLeave();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  });
  useEffect(() => {
    const sub = AppState.addEventListener('change', value => {
      const call = controller.current;
      // Preserve the controller's existing background and screen-sharing policy.
      if (
        value === 'background' &&
        call &&
        !call.disposed &&
        call.state.connection === 'connected' &&
        !call.state.sharing &&
        !call.inSystemPrompt &&
        !call.cameraBusy
      ) {
        controller.current = null;
        call.leave();
        setActive(false);
        setShowChat(false);
        setState(initial);
        setError(
          'Call ended in the background. Keep the app open during calls and rejoin with the invitation.',
        );
      }
    });
    return () => sub.remove();
  }, []);

  async function run(action) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(e.message || String(e));
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function request(origin, path, options = {}) {
    const abort = new AbortController();
    pendingRequest.current = abort;
    const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(origin + path, {
        ...options,
        signal: abort.signal,
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(
          `Server returned a non-JSON response (HTTP ${response.status}). Check the backend route.`,
        );
      }
      if (!response.ok)
        throw new Error(
          data.error || `Server returned HTTP ${response.status}.`,
        );
      return data;
    } catch (e) {
      if (abort.signal.aborted)
        throw new Error(
          'Server request timed out. Check the server URL and backend availability.',
        );
      if (e instanceof TypeError)
        throw new Error(
          `Cannot reach ${origin}. Check your connection, HTTPS certificate and backend.`,
        );
      throw e;
    } finally {
      clearTimeout(timeout);
      if (pendingRequest.current === abort) pendingRequest.current = null;
    }
  }
  async function enter(create) {
    await run(async () => {
      const person = create ? host : guest;
      const displayName = person.name.trim();
      if (!displayName)
        throw new Error('Enter your name in the form you are using.');
      const origin = normalizeServerUrl(server);
      let roomId, roomKey;
      if (create) {
        const data = await request(origin, '/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        ({ roomId, roomKey } = data);
        if (!roomId || !roomKey)
          throw new Error('The backend returned an invalid room response.');
      } else {
        let url;
        try {
          url = new URL(invite.trim());
        } catch {
          throw new Error('Paste a complete invitation URL.');
        }
        if (!['https:', 'http:'].includes(url.protocol))
          throw new Error('Invalid invitation protocol.');
        if (!__DEV__ && url.origin !== origin) {
          throw new Error(
            'This invitation belongs to another server. Ask for an invitation from this app’s backend.',
          );
        }
        const params = new URLSearchParams(url.hash.slice(1));
        roomId = params.get('room');
        roomKey = params.get('key');
        if (!roomId || !roomKey)
          throw new Error('The invitation must include #room= and &key=.');
      }
      if (!mounted.current) return;
      const link = `${origin}/#room=${encodeURIComponent(
        roomId,
      )}&key=${encodeURIComponent(roomKey)}`;
      setInvite(link);
      setName(displayName);
      setMessage('');
      try {
        await AsyncStorage.multiSet([
          ['ai-room-config', SERVER_URL],
          ['ai-room-server', origin],
          [create ? 'ai-room-host' : 'ai-room-guest', displayName],
        ]);
      } catch {
        /* Saving preferences must not prevent a call. */
      }
      if (!mounted.current) return;
      const previous = controller.current;
      controller.current = null;
      previous?.leave();
      const call = new PeerRoom({
        onChange: next => {
          if (!mounted.current || controller.current !== call) return;
          setState(next);
          if (next.status === 'Call ended') {
            setActive(false);
            setShowChat(false);
          }
          if (next.recordings?.length)
            setDownloads(old => [
              ...old,
              ...next.recordings.filter(r => !old.some(d => d.url === r.url)),
            ]);
        },
        onError: value => {
          if (mounted.current && controller.current === call)
            setError(String(value));
        },
      });
      controller.current = call;
      try {
        await call.join({
          serverUrl: origin,
          roomId,
          roomKey,
          name: displayName,
          consent: person.consent,
          audioOnly: person.audioOnly,
        });
        if (!mounted.current || controller.current !== call) {
          call.leave();
          return;
        }
        if (!call.disposed) setActive(true);
      } catch (e) {
        if (controller.current === call) controller.current = null;
        call.leave();
        throw e;
      }
    });
  }
  function callAction(method) {
    return run(async () => {
      const call = controller.current;
      if (!call || call.disposed)
        throw new Error('Rejoin the room to continue.');
      await method(call);
    });
  }

  const chatPanel = (
    <View style={s.card}>
      <Text style={s.cardTitle}>Room chat</Text>
      <Text style={s.hint}>
        Messages are available during this room session.
      </Text>
      <ScrollView
        ref={chatScroll}
        style={s.messages}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() =>
          chatScroll.current?.scrollToEnd({ animated: true })
        }
      >
        {!state.messages.length && (
          <Text style={s.muted}>Start the conversation.</Text>
        )}
        {state.messages.map(item => (
          <View
            key={item.id}
            style={[s.message, item.from === state.selfId && s.myMessage]}
          >
            <Text style={s.sender}>{item.name}</Text>
            <Text selectable style={s.body}>
              {item.text}
            </Text>
          </View>
        ))}
      </ScrollView>
      <Field
        label="Message"
        value={message}
        onChangeText={setMessage}
        multiline
        maxLength={2000}
        placeholder="Write a message…"
      />
      <Button
        title="Send message"
        disabled={busy || !message.trim()}
        onPress={() => {
          const draft = message;
          callAction(async call => {
            await call.sendChat(draft);
            if (mounted.current)
              setMessage(current => (current === draft ? '' : current));
          });
        }}
      />
    </View>
  );

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0b1420" />
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[s.page, wide && s.pageWide]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.top}>
            <View style={s.brandMark}>
              <Text style={s.brandLetters}>AI</Text>
            </View>
            <View style={s.flex}>
              <Text style={s.brand}>AI Interview Room</Text>
              <Text style={s.hint}>Video conversations, wherever you are.</Text>
            </View>
          </View>
          {!!error && (
            <View accessibilityRole="alert" style={s.error}>
              <Text selectable style={s.errorText}>
                {error}
              </Text>
              <Button
                compact
                secondary
                title="Dismiss"
                onPress={() => setError('')}
              />
            </View>
          )}
          {!!notice && (
            <Text accessibilityLiveRegion="polite" style={s.notice}>
              {notice}
            </Text>
          )}
          {!active ? (
            <>
              <View style={s.hero}>
                <Text style={s.eyebrow}>YOUR SPACE TO CONNECT</Text>
                <Text style={s.title}>
                  A great conversation{'\n'}starts here.
                </Text>
                <Text style={s.muted}>
                  Create a private room or join an invitation. Connect with one
                  person on mobile or web.
                </Text>
                <View style={s.pills}>
                  {['Group video', 'Screen sharing', 'Room chat'].map(text => (
                    <View key={text} style={s.pill}>
                      <Text style={s.pillText}>{text}</Text>
                    </View>
                  ))}
                </View>
              </View>
              <View style={[s.lobby, wide && s.row]}>
                <View style={[s.card, s.hostCard, wide && s.flex]}>
                  <Text style={s.eyebrow}>01 / HOST</Text>
                  <Text style={s.cardTitle}>Create a room</Text>
                  <Text style={s.muted}>
                    Start your session and share an invitation.
                  </Text>
                  <ProfileFields
                    value={host}
                    onChange={setHost}
                    busy={locked}
                  />
                  <Button
                    title={busy ? 'Please wait…' : 'Create room'}
                    disabled={locked || !host.name.trim()}
                    onPress={() => enter(true)}
                  />
                </View>
                <View style={[s.card, wide && s.flex]}>
                  <Text style={s.eyebrow}>02 / GUEST</Text>
                  <Text style={s.cardTitle}>Join a room</Text>
                  <Text style={s.muted}>
                    Have an invitation? Your seat is ready.
                  </Text>
                  <ProfileFields
                    value={guest}
                    onChange={setGuest}
                    busy={locked}
                  />
                  <Field
                    label="Full invitation link"
                    value={invite}
                    onChangeText={setInvite}
                    editable={!locked}
                    multiline
                    keyboardType="url"
                    placeholder="https://your-server/#room=…&key=…"
                  />
                  <Button
                    secondary
                    title={busy ? 'Please wait…' : 'Join room'}
                    disabled={locked || !guest.name.trim() || !invite.trim()}
                    onPress={() => enter(false)}
                  />
                </View>
              </View>
              <Text style={s.hint}>
                Recording requires every participant’s consent. Keep invitation
                links private.
              </Text>
              <View style={s.card}>
                <View style={s.callHeader}>
                  <View style={s.flex}>
                    <Text style={s.label}>Connection settings</Text>
                    <Text numberOfLines={2} style={s.hint}>
                      {server}
                    </Text>
                  </View>
                  <Button
                    compact
                    secondary
                    title={settings ? 'Hide' : 'Manage'}
                    disabled={locked}
                    onPress={() => setSettings(!settings)}
                  />
                </View>
                {settings && (
                  <>
                    <Field
                      label="Backend URL"
                      value={server}
                      onChangeText={setServer}
                      keyboardType="url"
                      editable={__DEV__ && !locked}
                      placeholder={SERVER_URL}
                    />
                    <Text style={s.hint}>
                      {__DEV__
                        ? 'Development build: use your PC’s LAN URL or USB reverse address for local testing. All devices must use the same backend. Release builds use the configured HTTPS server.'
                        : 'This build connects to the configured interview server.'}
                    </Text>
                    {__DEV__ && (
                      <Button
                        secondary
                        title="Use configured server"
                        disabled={locked}
                        onPress={() => setServer(SERVER_URL)}
                      />
                    )}
                    <Button
                      title="Check server"
                      disabled={locked}
                      onPress={() =>
                        run(async () => {
                          const origin = normalizeServerUrl(server);
                          const result = await request(origin, '/api/health');
                          if (result.ok !== true)
                            throw new Error(
                              'Unexpected health response. Check the backend URL.',
                            );
                          if (mounted.current)
                            setNotice(
                              'Backend is reachable. This checks the API; call connectivity is checked when you join.',
                            );
                        })
                      }
                    />
                  </>
                )}
              </View>
            </>
          ) : (
            <>
              <View style={s.callHeader}>
                <View style={s.flex}>
                  <Text style={s.eyebrow}>INTERVIEW ROOM</Text>
                  <Text style={s.cardTitle}>{state.status}</Text>
                  <Text style={s.hint}>
                    {`${state.peers.length}${
                      state.maxParticipants > 0 ? `/${state.maxParticipants}` : ''
                    } people in this room`}
                    {state.stats.path ? ` · ${state.stats.path}` : ''}
                  </Text>
                </View>
                <Button
                  compact
                  secondary
                  title="Share invite"
                  disabled={busy}
                  onPress={() =>
                    Share.share({ message: invite }).catch(e =>
                      setError(e.message),
                    )
                  }
                />
              </View>
              {recordingBusy && (
                <View style={s.recordingBanner}>
                  <Text style={s.errorText}>
                    {recordingStatus === 'starting'
                      ? 'Connecting server recorder…'
                      : recordingStatus === 'stopping'
                      ? 'Saving recording. Please stay in the room…'
                      : '● Recording on the server'}
                  </Text>
                </View>
              )}
              <View style={[s.callBody, width >= 1100 && s.row]}>
                <View style={s.mediaColumn}>
                  {state.sharing && (
                    <Tile
                      stream={state.localScreen}
                      enabled
                      screen
                      label="Your shared screen"
                    />
                  )}
                  {participants
                    .filter(p => p.sharing)
                    .map(participant => (
                      <Tile
                        key={`screen-${participant.id}`}
                        stream={participant.screenStream}
                        enabled
                        screen
                        label={`${participant.name} · Screen`}
                      />
                    ))}
                  <View style={[s.videoGrid, wide && s.groupGrid]}>
                    <Tile
                      stream={state.local}
                      enabled={state.camera}
                      label={`${name} · You`}
                      local
                      mirror={state.front !== false}
                      wide={wide}
                    />
                    {participants.map(participant => (
                      <Tile
                        key={participant.id}
                        stream={participant.stream}
                        enabled={participant.camera}
                        label={`${participant.name} · ${participant.connection}`}
                        wide={wide}
                      />
                    ))}
                  </View>
                  {!!state.cameraError && (
                    <Text style={s.errorText}>{state.cameraError}</Text>
                  )}
                  <View style={s.controls}>
                    <Button
                      compact
                      secondary
                      title={state.mic ? 'Mute mic' : 'Unmute mic'}
                      disabled={busy}
                      onPress={() => callAction(call => call.toggleMic())}
                    />
                    <Button
                      compact
                      secondary
                      title={state.camera ? 'Camera off' : 'Camera on'}
                      disabled={busy}
                      onPress={() => callAction(call => call.toggleCamera())}
                    />
                    <Button
                      compact
                      secondary
                      title="Flip camera"
                      disabled={busy || !state.camera}
                      onPress={() => callAction(call => call.flipCamera())}
                    />
                    <Button
                      compact
                      secondary
                      title={state.speaker ? 'Earpiece' : 'Speaker'}
                      disabled={busy}
                      onPress={() => callAction(call => call.toggleSpeaker())}
                    />
                    <Button
                      compact
                      secondary
                      title={state.sharing ? 'Stop sharing' : 'Share screen'}
                      disabled={busy || state.connection !== 'connected'}
                      onPress={() =>
                        callAction(call =>
                          state.sharing
                            ? call.stopScreen()
                            : call.startScreen(),
                        )
                      }
                    />
                    <Button
                      compact
                      secondary
                      title={recordingBusy ? 'Stop recording' : 'Record call'}
                      disabled={
                        busy ||
                        recordingStatus === 'stopping' ||
                        (!recordingBusy && !canRecord)
                      }
                      onPress={() =>
                        callAction(call =>
                          call.recordCommand(
                            recordingBusy
                              ? 'recording-stop'
                              : 'recording-start',
                          ),
                        )
                      }
                    />
                    <Button
                      compact
                      secondary
                      title="Reconnect"
                      disabled={busy || !participants.length}
                      onPress={() => callAction(call => call.restartIce())}
                    />
                    <Button
                      compact
                      secondary
                      title={
                        showChat
                          ? 'Hide chat'
                          : `Chat (${state.messages.length})`
                      }
                      onPress={() => setShowChat(value => !value)}
                    />
                    <Button
                      compact
                      danger
                      title="Leave call"
                      disabled={busy}
                      onPress={confirmLeave}
                    />
                  </View>
                  <View style={s.card}>
                    <Toggle
                      label="Allow server recording"
                      value={state.consent}
                      disabled={busy}
                      onValueChange={consent =>
                        callAction(call => call.setMedia({ consent }))
                      }
                    />
                    <Text style={s.hint}>
                      Everyone must agree. Recording stops when participants
                      join or leave. Turning this off stops recording for
                      everyone. Screen sharing does not include device audio.
                    </Text>
                    {!state.hasTurn && (
                      <Text style={s.hint}>
                        No TURN relay is configured. Calls across different
                        networks may fail.
                      </Text>
                    )}
                  </View>
                </View>
                {showChat && (
                  <View style={width >= 1100 ? s.chatColumn : s.chatStack}>
                    {chatPanel}
                  </View>
                )}
              </View>
            </>
          )}
          {!!downloads.length && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Your recordings</Text>
              <Text style={s.hint}>
                Download before links expire. Opening a browser may end an
                active call under the app’s background policy.
              </Text>
              {downloads.map(item => (
                <Button
                  key={item.url}
                  secondary
                  title={`Download ${item.name} · ${(
                    item.size / 1048576
                  ).toFixed(1)} MB`}
                  onPress={() =>
                    Linking.openURL(item.url).catch(e => setError(e.message))
                  }
                />
              ))}
            </View>
          )}
          <Text style={s.footer}>
            AI Interview Room · Built for real conversations
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#0b1420' },
  page: { padding: 18, gap: 20, paddingBottom: 36 },
  pageWide: { padding: 30, maxWidth: 1440, width: '100%', alignSelf: 'center' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandMark: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: '#d9f0e7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLetters: { fontSize: 19, fontWeight: '900', color: '#163d36' },
  brand: { fontSize: 19, fontWeight: '800', color: '#f4f5f2' },
  hero: { paddingVertical: 18, gap: 14 },
  eyebrow: {
    color: '#9adac6',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  title: {
    color: '#f4f5f2',
    fontSize: 36,
    lineHeight: 43,
    fontWeight: '800',
    letterSpacing: -1,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    borderWidth: 1,
    borderColor: '#2b3c4a',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pillText: { color: '#b8c8d4', fontSize: 12 },
  lobby: { gap: 16 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  card: {
    backgroundColor: '#142130',
    borderWidth: 1,
    borderColor: '#2a3b4d',
    padding: 20,
    borderRadius: 24,
    gap: 14,
  },
  hostCard: { backgroundColor: '#17302f', borderColor: '#356055' },
  cardTitle: { color: '#f2f5f3', fontSize: 23, fontWeight: '800' },
  muted: { color: '#b0becb', fontSize: 14, lineHeight: 22 },
  hint: { color: '#a4b5c4', fontSize: 12, lineHeight: 19 },
  label: { color: '#e4ebe9', fontSize: 13, fontWeight: '600' },
  body: { color: '#ecf1f4', fontSize: 15, lineHeight: 22 },
  field: { gap: 8 },
  input: {
    backgroundColor: '#0c1925',
    color: '#f5f7f9',
    borderWidth: 1,
    borderColor: '#3b5060',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 50,
    fontSize: 15,
  },
  multiline: { minHeight: 86, textAlignVertical: 'top' },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    justifyContent: 'space-between',
  },
  toggleText: { flex: 1, color: '#d5e0e6', fontSize: 14, lineHeight: 21 },
  button: {
    backgroundColor: '#b85135',
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 15,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 1,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  secondary: { backgroundColor: '#2b4054' },
  danger: { backgroundColor: '#9b3549' },
  compact: { paddingHorizontal: 13, paddingVertical: 12 },
  dim: { opacity: 0.5 },
  error: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#391f2a',
    borderWidth: 1,
    borderColor: '#9a4d5d',
    gap: 12,
  },
  errorText: { color: '#ffd8df', fontSize: 14, lineHeight: 22 },
  notice: { color: '#a9e8ce', fontSize: 14, lineHeight: 22 },
  callHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  callBody: { gap: 16 },
  mediaColumn: { flex: 1, gap: 16, minWidth: 0 },
  chatColumn: { width: 330 },
  chatStack: { width: '100%' },
  videoGrid: { gap: 12 },
  groupGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  tile: {
    height: 270,
    backgroundColor: '#172a3a',
    borderRadius: 22,
    overflow: 'hidden',
  },
  wideTile: { width: '48%', height: 280 },
  screenTile: { height: 300 },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  avatarCircle: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: '#244e4b',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: { fontSize: 34, fontWeight: '800', color: '#b9eadc' },
  videoLabel: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    padding: 10,
    backgroundColor: '#08131cdd',
    borderRadius: 10,
  },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  messages: { maxHeight: 330, minHeight: 110 },
  message: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#213447',
    marginBottom: 10,
  },
  myMessage: { backgroundColor: '#214a43' },
  sender: {
    color: '#a3ddcb',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 5,
  },
  recordingBanner: {
    backgroundColor: '#3d2330',
    padding: 14,
    borderRadius: 14,
  },
  footer: { color: '#8c9fab', fontSize: 11, textAlign: 'center', marginTop: 8 },
});
