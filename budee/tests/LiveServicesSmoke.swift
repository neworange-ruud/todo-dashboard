import Foundation

@main
enum LiveServicesSmoke {
    static func main() async {
        do { try await check() }
        catch {
            fputs("Live service check failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    static func check() async throws {
        guard let key = BuddySettings.value("BUDDY_ELEVENLABS_API_KEY") else {
            throw BuddyServiceError.configuration("ElevenLabs key is not configured.")
        }
        var failures: [String] = []
        for language in ["NL", "EN"] {
            guard let voiceID = BuddySettings.value("BUDDY_ELEVENLABS_VOICE_ID_\(language)"),
                  voiceID.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
                throw BuddyServiceError.configuration("\(language) voice ID is not configured.")
            }
            var request = URLRequest(url: URL(string: "https://api.elevenlabs.io/v1/voices/\(voiceID)")!)
            request.setValue(key, forHTTPHeaderField: "xi-api-key")
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let detail = payload?["detail"] as? [String: Any]
                let reason = detail?["status"] as? String ?? "unknown"
                failures.append("ElevenLabs \(language) voice lookup: HTTP \(status) (\(reason))")
                continue
            }
            print("ElevenLabs \(language) voice: available")
        }
        do {
            let greeting = try await HermesConversation().run("Reply with one short Dutch greeting. No tools needed.")
            print("Hermes runs API: replied (detected \(BuddyReplyLanguage.detect(greeting).rawValue))")
        } catch {
            failures.append("Hermes runs API: \(error.localizedDescription)")
            do {
                _ = try await HermesConversation().send("Reply with one short Dutch greeting. No tools needed.")
                print("Hermes chat API: replied")
            } catch {
                failures.append("Hermes chat API: \(error.localizedDescription)")
            }
        }
        if !failures.isEmpty { throw BuddyServiceError.request(failures.joined(separator: "; ")) }
    }
}
