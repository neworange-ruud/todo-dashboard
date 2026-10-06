import Foundation

@main
enum HermesProfileProbe {
    static func main() async {
        do { try await check() }
        catch {
            fputs("Hermes profile check failed: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }

    static func check() async throws {
        guard let base = BuddySettings.value("BUDDY_HERMES_API_URL"),
              let key = BuddySettings.value("BUDDY_HERMES_API_KEY"),
              let endpoint = HermesConversation.endpoint(for: base) else {
            throw BuddyServiceError.configuration("Configure Buddy's Hermes URL and key first.")
        }
        let modelsURL = endpoint.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("models")
        var request = URLRequest(url: modelsURL)
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let models = payload["data"] as? [[String: Any]] else {
            throw BuddyServiceError.request("Could not read the Hermes API model/profile identifier.")
        }
        print("API model identifiers: \(models.compactMap { $0["id"] as? String }.joined(separator: ", "))")

        let question = "Hoe heet je?"
        print("Runs API reply: \(try await HermesConversation().run(question))")
        print("Chat API reply: \(try await HermesConversation().send(question))")
    }
}
