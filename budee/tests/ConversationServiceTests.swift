import Foundation

@main
enum ConversationServiceTests {
    static func main() throws {
        precondition(HermesConversation.endpoint(for: "https://example.com:8642/v1")?.path == "/v1/chat/completions")
        precondition(HermesConversation.endpoint(for: "https://example.com:8642/")?.path == "/v1/chat/completions")
        precondition(HermesConversation.endpoint(for: "https://example.com/p/buddy/v1/")?.path == "/p/buddy/v1/chat/completions")
        let url = URL(string: "http://100.116.89.124:9999/v1/chat/completions")!
        func response(_ status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
            HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "choices": [["message": ["role": "assistant", "content": "Hello, Ruud."]]],
        ])
        let reply = try HermesConversation.parse(data: data, response: response(200, headers: ["X-Hermes-Session-Id": "session-1"]))
        precondition(reply.text == "Hello, Ruud." && reply.sessionID == "session-1")

        do {
            _ = try HermesConversation.parse(data: Data("<html>Sign in</html>".utf8), response: response(200))
            preconditionFailure("Dashboard HTML must not be treated as a reply")
        } catch BuddyServiceError.invalidResponse { }

        do {
            _ = try HermesConversation.parse(data: Data(), response: response(401))
            preconditionFailure("Unauthorized API calls must fail")
        } catch BuddyServiceError.request { }
        let partial = try JSONSerialization.data(withJSONObject: [
            "choices": [["message": ["content": "half a reply"]]],
            "hermes": ["partial": true],
        ])
        do {
            _ = try HermesConversation.parse(data: partial, response: response(200))
            preconditionFailure("Partial agent replies must not be recorded as complete turns")
        } catch BuddyServiceError.request { }
        print("Buddy Hermes API response parsing: passed")
    }
}
