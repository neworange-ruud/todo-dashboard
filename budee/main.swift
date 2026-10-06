import AppKit
import AVFoundation
import WebKit

private final class BuddyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private enum ConversationPhase: String {
    case idle, starting, recording, transcribing, hermes, speaking, cancelling
}

final class BuddyApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var cursorTimer: Timer?
    private var calendarTimer: Timer?
    private let calendar = CalendarService()
    private let conversation = HermesConversation()
    private let voice = VoiceService()
    private var conversationPhase: ConversationPhase = .idle
    private var conversationTask: Task<Void, Never>?
    private var stopAfterStarting = false
    private var refreshingCalendar = false
    private var lastPointer: CGPoint?
    private var pageReady = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Buddy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        menu.addItem(appItem)
        NSApp.mainMenu = menu

        let screen = companionScreen()
        let window = BuddyWindow(
            contentRect: NSRect(origin: .zero, size: screen.frame.size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
            screen: screen
        )
        // setFrame takes global coordinates; the initializer's rect is screen-relative.
        window.setFrame(screen.frame, display: false)
        window.title = "Buddy"
        window.backgroundColor = NSColor(red: 6 / 255, green: 26 / 255, blue: 48 / 255, alpha: 1)
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.level = .floating

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "buddy")
        let webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        self.webView = webView
        self.window = window

        guard let resources = Bundle.main.resourceURL else {
            NSLog("Buddy: application resources missing")
            NSApp.terminate(nil)
            return
        }
        webView.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // A borderless full-display window stays present on the companion monitor
        // while work on the main monitor changes Spaces or takes focus.
        NSApp.presentationOptions = [.hideDock, .hideMenuBar]

        cursorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            self?.sendPointer()
        }
        cursorTimer?.tolerance = 0.006
        calendarTimer = Timer.scheduledTimer(withTimeInterval: 120, repeats: true) { [weak self] _ in
            self?.refreshCalendar()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        cursorTimer?.invalidate()
        calendarTimer?.invalidate()
        conversationTask?.cancel()
        voice.discardRecording()
        voice.stopPlayback()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "buddy")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageReady = true
        lastPointer = nil
        sendPointer()
        refreshCalendar()
        sendConversation(status: BuddySettings.value("BUDDY_HERMES_API_URL") == nil ?
            "Set the Hermes API URL to start chatting." : "Ready to talk.")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            webView.evaluateJavaScript("[window.buddyReady, document.querySelectorAll('canvas').length]") { value, error in
                NSLog("Buddy: portrait %@, canvases %@", String(describing: value), String(describing: error))
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("Buddy: portrait failed to load: %@", error.localizedDescription)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "buddy", let payload = message.body as? [String: String],
              let action = payload["action"] else { return }
        switch action {
        case "send":
            guard let text = payload["text"]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !text.isEmpty, conversationPhase == .idle else { return }
            conversation.beginTurn()
            conversationPhase = .hermes
            sendConversation(status: "Working with Hermes…", phase: .hermes)
            conversationTask = Task { await sendTurn(text) }
        case "micStart": startMicrophone()
        case "micStop": stopMicrophone()
        case "cancel": cancelConversation()
        default: break
        }
    }

    private func startMicrophone() {
        guard conversationPhase == .idle else { return }
        stopAfterStarting = false
        conversationPhase = .starting
        sendConversation(status: "Starting microphone…", phase: .starting)
        conversationTask = Task {
            do {
                try await voice.start()
                try Task.checkCancellation()
                conversationPhase = .recording
                sendConversation(status: "Listening… Release to send, or hold to keep recording.", phase: .recording)
                if stopAfterStarting { stopMicrophone() }
            } catch is CancellationError {
                voice.discardRecording()
                finishConversation("Cancelled.")
            } catch {
                finishConversation(conversationPhase == .cancelling ? "Cancelled." : error.localizedDescription)
            }
        }
    }

    private func stopMicrophone() {
        if conversationPhase == .starting {
            stopAfterStarting = true
            return
        }
        guard conversationPhase == .recording else { return }
        conversationPhase = .transcribing
        sendConversation(status: "Transcribing with ElevenLabs…", phase: .transcribing)
        conversationTask = Task {
            do {
                let text = try await voice.stopAndTranscribe()
                try Task.checkCancellation()
                guard !text.isEmpty else { finishConversation("I didn’t hear anything. Try again."); return }
                conversation.beginTurn()
                await sendTurn(text)
            } catch is CancellationError {
                finishConversation("Cancelled.")
            } catch {
                finishConversation(conversationPhase == .cancelling ? "Cancelled." : error.localizedDescription)
            }
        }
    }

    private func cancelConversation() {
        switch conversationPhase {
        case .idle, .cancelling: return
        case .recording:
            voice.discardRecording()
            finishConversation("Recording discarded.")
        case .hermes:
            conversationPhase = .cancelling
            conversation.requestCancellation()
            sendConversation(status: "Stopping Hermes…", phase: .cancelling)
        case .starting, .transcribing, .speaking:
            conversationPhase = .cancelling
            conversationTask?.cancel()
            voice.stopPlayback()
            sendConversation(status: "Cancelling…", phase: .cancelling)
        }
    }

    private func sendTurn(_ text: String) async {
        guard !Task.isCancelled, conversationPhase != .cancelling else {
            finishConversation("Cancelled.")
            return
        }
        conversationPhase = .hermes
        voice.stopPlayback()
        sendConversation(status: "Working with Hermes…", speaker: "You", text: text, phase: .hermes)
        do {
            let reply = try await conversation.run(text)
            try Task.checkCancellation()
            guard conversationPhase != .cancelling else { throw CancellationError() }
            sendConversation(speaker: "Buddy", text: reply)
            if voice.hasVoice {
                conversationPhase = .speaking
                sendConversation(status: "Preparing and playing speech…", phase: .speaking)
                try await voice.speak(reply)
            }
            finishConversation("Ready to talk.")
        } catch is CancellationError {
            finishConversation("Cancelled.")
        } catch {
            finishConversation(conversationPhase == .cancelling ? "Could not stop Hermes: \(error.localizedDescription)" : error.localizedDescription)
        }
    }

    private func finishConversation(_ status: String) {
        conversationPhase = .idle
        conversationTask = nil
        stopAfterStarting = false
        sendConversation(status: status, phase: .idle)
    }

    private func sendConversation(status: String? = nil, speaker: String? = nil, text: String? = nil,
                                   phase: ConversationPhase? = nil) {
        var payload: [String: Any] = [:]
        if let status { payload["status"] = status }
        if let speaker { payload["speaker"] = speaker }
        if let text { payload["text"] = text }
        if let phase { payload["phase"] = phase.rawValue }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.buddySetConversation(\(json))") { _, error in
            if let error { NSLog("Buddy: conversation display failed: %@", error.localizedDescription) }
        }
    }

    private func companionScreen() -> NSScreen {
        let screens = NSScreen.screens
        return screens.first(where: { $0.localizedName == "12.3FHD" })
            ?? screens.first(where: { $0.frame.size == CGSize(width: 1600, height: 600) })
            ?? screens.first(where: { $0 != NSScreen.main })
            ?? screens[0]
    }

    private func refreshCalendar() {
        guard pageReady, !refreshingCalendar else { return }
        refreshingCalendar = true
        Task { @MainActor in
            defer { refreshingCalendar = false }
            do {
                let meetings = try await calendar.fetchToday()
                sendCalendar(status: "ok", meetings: meetings)
            } catch CalendarError.notConfigured {
                sendCalendar(status: "unavailable", message: "Outlook is not connected")
            } catch {
                NSLog("Buddy: calendar refresh failed: %@", String(describing: error))
                sendCalendar(status: "unavailable", message: "Could not reach Outlook")
            }
        }
    }

    private func sendCalendar(status: String, meetings: [UpcomingMeeting] = [], message: String? = nil) {
        var payload: [String: Any] = ["status": status, "meetings": meetings.map(\.json)]
        if let message { payload["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.buddySetCalendar(\(json))") { [weak self] _, error in
            if let error { NSLog("Buddy: calendar display failed: %@", error.localizedDescription) }
            self?.snapshotIfRequested()
        }
    }

    private func snapshotIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["BUDDY_SNAPSHOT_PATH"], let webView else { return }
        webView.takeSnapshot(with: nil) { image, error in
            guard let data = image?.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: data),
                  let png = bitmap.representation(using: .png, properties: [:]) else {
                NSLog("Buddy: snapshot failed: %@", String(describing: error))
                return
            }
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }

    private func sendPointer() {
        guard pageReady, let webView else { return }
        let point = NSEvent.mouseLocation
        if point == lastPointer { return }
        lastPointer = point

        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) })
            ?? NSScreen.main ?? companionScreen()
        let buddy = companionScreen()
        let zone = screen.frame == buddy.frame ? "buddy" : "main"
        let x = min(1, max(0, (point.x - screen.frame.minX) / screen.frame.width))
        let y = min(1, max(0, (screen.frame.maxY - point.y) / screen.frame.height))
        webView.evaluateJavaScript("window.buddySetPointer('\(zone)', \(Double(x)), \(Double(y)))") { _, error in
            if let error { NSLog("Buddy: pointer update failed: %@", error.localizedDescription) }
        }
    }
}

let app = NSApplication.shared
let delegate = BuddyApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
withExtendedLifetime(delegate) { app.run() }
