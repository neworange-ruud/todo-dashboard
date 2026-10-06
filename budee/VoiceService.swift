import AVFoundation
import Foundation
import NaturalLanguage

enum BuddyReplyLanguage: String {
    case dutch = "NL"
    case english = "EN"

    static func detect(_ text: String) -> Self {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let scores = recognizer.languageHypotheses(withMaximum: 2)
        let english = scores[.english] ?? 0
        let dutch = scores[.dutch] ?? 0
        // Default to Dutch when the reply is too short or ambiguous to classify reliably.
        return english >= 0.7 && english > dutch + 0.2 ? .english : .dutch
    }

    func voiceID(dutch: String?, english: String?, legacy: String?) -> String? {
        switch self {
        case .dutch: return dutch ?? english ?? legacy
        case .english: return english ?? dutch ?? legacy
        }
    }
}

@MainActor
final class VoiceService {
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var player: AVAudioPlayer?

    var isRecording: Bool { recorder?.isRecording == true }
    var hasVoice: Bool {
        BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID_NL") != nil ||
        BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID_EN") != nil ||
        BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID") != nil
    }

    func start() async throws {
        guard BuddySettings.value("BUDDY_ELEVENLABS_API_KEY") != nil else {
            throw BuddyServiceError.configuration("Set BUDDY_ELEVENLABS_API_KEY to use the microphone.")
        }
        guard await AVCaptureDevice.requestAccess(for: .audio) else {
            throw BuddyServiceError.request("Microphone access is off. Enable it for Buddy in System Settings → Privacy & Security.")
        }
        try Task.checkCancellation()
        player?.stop()
        player = nil
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("buddy-\(UUID().uuidString).wav")
        let recorder = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
        ])
        guard recorder.record() else {
            try? FileManager.default.removeItem(at: url)
            throw BuddyServiceError.request("Could not start recording. Check the microphone input.")
        }
        self.recorder = recorder
        recordingURL = url
    }

    func stopAndTranscribe() async throws -> String {
        guard let recorder, let url = recordingURL else {
            throw BuddyServiceError.request("There is no recording to transcribe.")
        }
        recorder.stop()
        self.recorder = nil
        recordingURL = nil
        defer { try? FileManager.default.removeItem(at: url) }
        try Task.checkCancellation()

        let boundary = "Buddy-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"model_id\"\r\n\r\nscribe_v2\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8))
        body.append(try Data(contentsOf: url))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue(BuddySettings.value("BUDDY_ELEVENLABS_API_KEY"), forHTTPHeaderField: "xi-api-key")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        try Self.check(response, service: "ElevenLabs transcription")
        guard let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = result["text"] as? String else {
            throw BuddyServiceError.invalidResponse("ElevenLabs did not return a transcript.")
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func discardRecording() {
        recorder?.stop()
        recorder = nil
        if let recordingURL { try? FileManager.default.removeItem(at: recordingURL) }
        recordingURL = nil
    }

    func speak(_ text: String) async throws {
        let language = BuddyReplyLanguage.detect(text)
        guard let key = BuddySettings.value("BUDDY_ELEVENLABS_API_KEY"),
              let voiceID = language.voiceID(
                  dutch: BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID_NL"),
                  english: BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID_EN"),
                  legacy: BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID")),
              !voiceID.isEmpty, voiceID.unicodeScalars.allSatisfy({
                  CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).contains($0)
              }) else {
            throw BuddyServiceError.configuration("Set an ElevenLabs key and a NL or EN voice ID to hear Buddy reply.")
        }
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceID)") else {
            throw BuddyServiceError.configuration("Invalid ElevenLabs voice ID.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 90
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "text": text, "model_id": "eleven_multilingual_v2", "output_format": "mp3_44100_128",
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        try Self.check(response, data: data, service: "ElevenLabs speech")
        player?.stop()
        let player = try AVAudioPlayer(data: data)
        guard player.play() else { throw BuddyServiceError.request("Could not play Buddy’s reply.") }
        self.player = player
        defer { stopPlayback() }
        while player.isPlaying {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try Task.checkCancellation()
    }

    func stopPlayback() {
        player?.stop()
        player = nil
    }

    private static func check(_ response: URLResponse, data: Data? = nil, service: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw BuddyServiceError.invalidResponse("\(service) did not return an HTTP response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let data,
               let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
               let detail = payload["detail"] as? [String: Any],
               detail["status"] as? String == "voice_not_found" {
                throw BuddyServiceError.request("ElevenLabs cannot find that voice in your account. Add it to your voice library or update the voice ID.")
            }
            throw BuddyServiceError.request("\(service) returned HTTP \(http.statusCode). Check your ElevenLabs key and account.")
        }
    }
}
