# Buddy — companion screen prototype

Run from the repository root:

```bash
zsh budee/run.zsh
```

The script builds and launches a native `Buddy.app` on the connected 1600×600 `12.3FHD` display. Its borderless, full-display window hides the menu bar and stays visible while working on the main display. Click Buddy and press **⌘Q** to quit. Moving the pointer across either display selects one of the six head poses; a new pose fades over the previous one while the eyes track within each pose. No Accessibility or Screen Recording permission is required to read the mouse location.

The images and initial six-pose renderer came from `~/Documents/Codex/2026-10-06/cr/outputs/eye-tracking-prototype/`. The source files there are unchanged. The local copy in `assets/` is adapted to the companion screen and the native cursor bridge.

The app icon is `assets/Buddy.icns`, built from `assets/Buddy-icon-source.png`. To regenerate its full multi-resolution icon set after editing the source image, run `python3 budee/make-icon.py` (Pillow and OpenCV required). `budee/run.zsh` bundles the generated icon before signing and launching the app.

## Outlook calendar

The left panel shows today's ongoing and upcoming Outlook meetings, sorted by start time. It omits finished and cancelled meetings, all-day events, and the solo focus/off-work blocks excluded by Task Desk. It refreshes every two minutes; finished meetings disappear without waiting for the next fetch. Times and day boundaries use Europe/Amsterdam.

Buddy reads the same `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, and `GRAPH_SECRET` used by Task Desk. Provide them in the environment, put them in the repository's ignored `.env`, or point `BUDDY_GRAPH_ENV_FILE` at the existing env file before running `budee/run.zsh`. Credentials are read at launch and never bundled into the app. Without them, the panel says “Outlook is not connected” rather than showing sample meetings.

The calendar parser can be checked without network access:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -parse-as-library \
  budee/CalendarService.swift budee/tests/CalendarServiceTests.swift \
  -o budee/.build/calendar-tests && budee/.build/calendar-tests
```

## Talk to Buddy

The right panel supports typed messages and hold-to-talk. Press and hold **🎙 Hold** to record; release to transcribe and send. Hold for 650 ms to lock the recording, then release and press **Stop** when you're done. Keyboard activation also locks the recording until Stop is pressed. **Cancel** discards a recording or cancels transcription, the Hermes run, or speech playback. While a prompt is running, a progress indicator shows the current stage and the input controls are disabled. Replies appear as text and are read aloud when a voice ID is configured. Each recording is deleted after transcription or cancellation. macOS asks for microphone access the first time.

Buddy connects to Hermes through its **API server** (`POST /v1/runs`, `GET /v1/runs/{id}` and `POST /v1/runs/{id}/stop` for cancellation). The service at `http://100.116.89.124:9119/` is the sign-in-protected dashboard, not the API server. On the remote Hermes machine, enable the API server in `~/.hermes/.env` and start or restart `hermes gateway`:

```dotenv
API_SERVER_ENABLED=true
API_SERVER_HOST=100.116.89.124
API_SERVER_PORT=8642
API_SERVER_KEY=<a strong, private key>
```

The host value must match that machine's tailnet address. Give Buddy the API server's base URL and its matching key. The `voice-interface` profile is routed through `/p/voice-interface/v1` and needs that profile's own `API_SERVER_KEY`. Buddy keeps a separate session ID for its conversation until it restarts and adds its name to the per-run instructions.

Add these values to the repository's ignored `.env` (or export them before running `budee/run.zsh`):

```dotenv
BUDDY_HERMES_API_URL=https://ruuds-macbook-pro-2023.tail981ec3.ts.net:8642/p/voice-interface/v1
BUDDY_HERMES_API_KEY=<the voice-interface API_SERVER_KEY>
BUDDY_ELEVENLABS_API_KEY=<your ElevenLabs API key>
BUDDY_ELEVENLABS_VOICE_ID_NL=<your Dutch voice ID>
BUDDY_ELEVENLABS_VOICE_ID_EN=<your English voice ID>
```

The Hermes URL can be the API server root or its `/v1` base URL (including an HTTPS tailnet hostname). Buddy uses the Dutch ElevenLabs voice by default, choosing the English voice when it confidently identifies an English reply. A single legacy `BUDDY_ELEVENLABS_VOICE_ID` still works as a fallback. The ElevenLabs key enables Scribe v2 speech-to-text; the voice IDs enable text-to-speech with `eleven_multilingual_v2`. No ElevenLabs SDK or subscription is needed to build Buddy, but live audio requires a working account/key with access to those models. Use `BUDDY_GRAPH_ENV_FILE` to point to another env file if you don't use the repository `.env`; process environment values take precedence. Secrets are read by the native process, not copied into the web page or app bundle. The current app transport-security exception permits HTTP to `100.116.89.124` for the tailnet API server; use HTTPS for any other remote hostname.

Run `zsh budee/run.zsh`, then send a typed message first to verify the API server before trying the microphone. A dashboard URL, invalid key, unavailable transcription or denied microphone access is shown in the conversation panel. To check the API reply parser without any service credentials:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -parse-as-library \
  budee/ConversationService.swift budee/tests/ConversationServiceTests.swift \
  -o budee/.build/conversation-tests && budee/.build/conversation-tests
```

To check the offline NL/EN voice selection:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -parse-as-library \
  -framework AVFoundation -framework NaturalLanguage \
  budee/ConversationService.swift budee/VoiceService.swift budee/tests/VoiceServiceTests.swift \
  -o budee/.build/voice-tests && budee/.build/voice-tests
```

To check hold-to-talk, progress and cancellation controls, and Hermes run/stop requests without network access:

```bash
node budee/tests/ConversationUITests.cjs
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -parse-as-library \
  budee/ConversationService.swift budee/tests/ConversationRunTests.swift \
  -o budee/.build/run-tests && budee/.build/run-tests
```

To check the configured Hermes conversation and verify that both ElevenLabs voice IDs are available in the account (without recording audio), run:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools swiftc -parse-as-library \
  -framework AVFoundation -framework NaturalLanguage \
  budee/ConversationService.swift budee/VoiceService.swift budee/tests/LiveServicesSmoke.swift \
  -o budee/.build/live-services-smoke && \
  BUDDY_GRAPH_ENV_FILE="$PWD/.env" budee/.build/live-services-smoke
```
