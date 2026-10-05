# Project context for continuation

Owner: Shubham Sinha. Requested 1 October 2026.
Goal: locally runnable React Native CLI POC matching his existing two-person web WebRTC POC, with a responsive app and clear Windows setup instructions. Android first; no LiveKit, Agora, Twilio or Expo.

The original web source was recovered from WebRTC_POC.zip, version 2. This package extends its Node/Express and Socket.IO server, room URL fragment convention (`#room=...&key=...`), roster, chat, media events and fixed audio/camera/screen transceiver ordering. The original stack PDF also confirmed browser Canvas/Web Audio/MediaRecorder recording.

Deliberate mobile change: recording is on a self-hosted headless Chrome observer, controlled by Node, with consent and temporary disk storage. It is not original device-only recording. WebRTC media normally goes peer-to-peer; recording adds a separate send-only connection from each participant to the server recorder.

Android native folders are generated with community CLI 20 and RN 0.81.5. Android uses legacy architecture for this POC. SDK/target 36, minimum 24, NDK 27.1.12297006, Gradle 8.14.3; use JDK 17. Do not blindly upgrade individual Gradle/AGP/Kotlin packages.

Remaining verification: build/install on an Android phone, test actual mic/camera/speaker route, system projection prompt, background screen sharing, two-phone calls, recorder media encoding and TURN across networks. iOS is only a scaffold and is explicitly not at feature parity.
