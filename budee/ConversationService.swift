import Foundation

// Only the native host reads credentials. The web view receives display text, never keys.
enum BuddySettings {
    static func value(_ name: String) -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let direct = environment[name], !direct.isEmpty { return direct }
        guard let path = environment["BUDDY_GRAPH_ENV_FILE"],
              let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        for line in contents.components(separatedBy: .newlines) {
            let clean = line.trimmingCharacters(in: .whitespaces)
            guard !clean.isEmpty, !clean.hasPrefix("#") else { continue }
            let assignment = clean.hasPrefix("export ") ? String(clean.dropFirst(7)) : clean
            let parts = assignment.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces) == name else { continue }
            var result = parts[1].trimmingCharacters(in: .whitespaces)
            if result.count >= 2, (result.first == "\"" || result.first == "'"), result.first == result.last {
                result.removeFirst()
                result.removeLast()
            }
            return result.isEmpty ? nil : result
        }
        return nil
    }
}

enum BuddyServiceError: LocalizedError {
    case configuration(String)
    case request(String)
    case invalidResponse(String)

    var errorDescription: String? {
        switch self {
        case .configuration(let message), .request(let message), .invalidResponse(let message): return message
        }
    }
}

struct HermesReply {
    let text: String
    let sessionID: String?
}

final class HermesConversation {
    static let appInstructions = "Your name is Buddy. When asked your name, answer Buddy. Keep the voice-interface profile's other instructions and personality."
    // Explicit ID prevents first-message fingerprint collisions with other API clients.
    private var sessionID = "buddy-\(UUID().uuidString)"
    private var history: [[String: String]] = []
    private var cancellationRequested = false
    private let session: URLSession

    init(session: URLSession = .shared) { self.session = session }

    func beginTurn() { cancellationRequested = false }
    func requestCancellation() { cancellationRequested = true }

    // Runs have an explicit stop endpoint; cancelling a non-streaming chat HTTP request alone
    // would leave the agent working remotely after Buddy has stopped waiting for it.
    func run(_ text: String) async throws -> String {
        let base = try apiBase()
        var request = try authenticatedRequest(url: base.appendingPathComponent("runs"), method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "input": text, "session_id": sessionID, "instructions": Self.appInstructions,
        ])
        let (data, response) = try await session.data(for: request)
        try Self.checkHTTP(response, service: "Hermes run submission")
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runID = payload["run_id"] as? String,
              !runID.isEmpty, runID.count < 200,
              runID.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).contains($0) }) else {
            throw BuddyServiceError.invalidResponse("Hermes did not return a run ID.")
        }
        let runURL = base.appendingPathComponent("runs").appendingPathComponent(runID)
        while true {
            if cancellationRequested {
                var stop = try authenticatedRequest(url: runURL.appendingPathComponent("stop"), method: "POST")
                stop.timeoutInterval = 15
                let (_, stopResponse) = try await session.data(for: stop)
                try Self.checkHTTP(stopResponse, service: "Hermes cancellation")
                throw CancellationError()
            }
            let poll = try authenticatedRequest(url: runURL, method: "GET")
            let (result, statusResponse) = try await session.data(for: poll)
            try Self.checkHTTP(statusResponse, service: "Hermes run status")
            guard let status = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
                  let state = status["status"] as? String else {
                throw BuddyServiceError.invalidResponse("Hermes returned an invalid run status.")
            }
            // Cancellation takes precedence even if the agent finished while the poll was in flight.
            if cancellationRequested { continue }
            switch state {
            case "completed":
                guard let output = status["output"] as? String, !output.isEmpty else {
                    throw BuddyServiceError.invalidResponse("Hermes finished without a reply.")
                }
                return output
            case "failed", "cancelled", "interrupted":
                throw BuddyServiceError.request("Hermes ended the request (\(state)).")
            default:
                try await Task.sleep(nanoseconds: 700_000_000)
            }
        }
    }

    private func apiBase() throws -> URL {
        guard let raw = BuddySettings.value("BUDDY_HERMES_API_URL"),
              let url = URL(string: raw),
              ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else {
            throw BuddyServiceError.configuration("Set BUDDY_HERMES_API_URL to the Hermes API server URL.")
        }
        let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return URL(string: trimmed.hasSuffix("/v1") ? trimmed : trimmed + "/v1")!
    }

    private func authenticatedRequest(url: URL, method: String) throws -> URLRequest {
        guard let key = BuddySettings.value("BUDDY_HERMES_API_KEY") else {
            throw BuddyServiceError.configuration("Set BUDDY_HERMES_API_KEY to the Hermes API_SERVER_KEY.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    private static func checkHTTP(_ response: URLResponse, service: String) throws {
        guard let http = response as? HTTPURLResponse else {
            throw BuddyServiceError.invalidResponse("\(service) did not return an HTTP response.")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw BuddyServiceError.request("Hermes rejected the API key. Check this profile's API_SERVER_KEY.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BuddyServiceError.request("\(service) returned HTTP \(http.statusCode).")
        }
    }

    func send(_ text: String) async throws -> String {
        guard let base = BuddySettings.value("BUDDY_HERMES_API_URL"),
              let url = Self.endpoint(for: base),
              ["http", "https"].contains(url.scheme ?? ""), url.host != nil,
              url.user == nil, url.password == nil else {
            throw BuddyServiceError.configuration("Set BUDDY_HERMES_API_URL to the Hermes API server URL.")
        }
        guard let key = BuddySettings.value("BUDDY_HERMES_API_KEY") else {
            throw BuddyServiceError.configuration("Set BUDDY_HERMES_API_KEY to the Hermes API_SERVER_KEY.")
        }
        let user = ["role": "user", "content": text]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 300
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionID, forHTTPHeaderField: "X-Hermes-Session-Id")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": BuddySettings.value("BUDDY_HERMES_MODEL") ?? "hermes-agent",
            "stream": false,
            "messages": history + [user],
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        let reply = try Self.parse(data: data, response: response)
        history.append(user)
        history.append(["role": "assistant", "content": reply.text])
        sessionID = reply.sessionID ?? sessionID
        return reply.text
    }

    static func endpoint(for base: String) -> URL? {
        let trimmed = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), url.query == nil, url.fragment == nil else { return nil }
        let suffix = url.path.hasSuffix("/v1") ? "/chat/completions" : "/v1/chat/completions"
        return URL(string: trimmed + suffix)
    }

    static func parse(data: Data, response: URLResponse) throws -> HermesReply {
        guard let http = response as? HTTPURLResponse else {
            throw BuddyServiceError.invalidResponse("Hermes did not return an HTTP response.")
        }
        if http.statusCode == 401 || http.statusCode == 403 {
            throw BuddyServiceError.request("Hermes rejected the API key. Check API_SERVER_KEY on the Hermes API server.")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw BuddyServiceError.request("Hermes returned HTTP \(http.statusCode). Check the API server URL and logs.")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = object["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let text = message["content"] as? String, !text.isEmpty else {
            throw BuddyServiceError.invalidResponse("Hermes returned no reply. Check that this URL points to its API server, not the dashboard.")
        }
        if let result = object["hermes"] as? [String: Any],
           result["failed"] as? Bool == true || result["partial"] as? Bool == true || result["completed"] as? Bool == false {
            throw BuddyServiceError.request("Hermes could not finish its reply. Check the API server logs and try again.")
        }
        return HermesReply(text: text, sessionID: http.value(forHTTPHeaderField: "X-Hermes-Session-Id"))
    }
}
