import Foundation

final class HermesStubProtocol: URLProtocol {
    static let lock = NSLock()
    static var calls: [String] = []
    static var running = false

    static func setRunning(_ value: Bool) {
        lock.lock()
        defer { lock.unlock() }
        running = value
    }

    static func recordedCalls() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return calls
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url!.path
        let method = request.httpMethod ?? "GET"
        Self.lock.lock()
        Self.calls.append("\(method) \(path)")
        let running = Self.running
        Self.lock.unlock()
        precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-key")
        let body: [String: Any]
        if method == "POST" && path == "/p/buddy/v1/runs" {
            if let data = request.httpBody,
               let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                precondition((payload["instructions"] as? String)?.contains("Your name is Buddy") == true)
            }
            body = ["run_id": "run_test"]
        } else if method == "GET" && path == "/p/buddy/v1/runs/run_test" {
            body = running ? ["status": "running"] : ["status": "completed", "output": "Goedemorgen!"]
        } else if method == "POST" && path == "/p/buddy/v1/runs/run_test/stop" {
            body = ["status": "stopping"]
        } else {
            preconditionFailure("Unexpected Hermes URL: \(method) \(path)")
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@main
enum ConversationRunTests {
    static func main() async throws {
        setenv("BUDDY_HERMES_API_URL", "https://example.test/p/buddy/v1", 1)
        setenv("BUDDY_HERMES_API_KEY", "test-key", 1)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HermesStubProtocol.self]
        let session = URLSession(configuration: config)
        let conversation = HermesConversation(session: session)
        let greeting = try await conversation.run("Hallo")
        precondition(greeting == "Goedemorgen!")

        HermesStubProtocol.setRunning(true)
        conversation.beginTurn()
        let task = Task { try await conversation.run("Please keep working") }
        try await Task.sleep(nanoseconds: 100_000_000)
        conversation.requestCancellation()
        do {
            _ = try await task.value
            preconditionFailure("Cancelled run returned a reply")
        } catch is CancellationError { }

        let calls = HermesStubProtocol.recordedCalls()
        precondition(calls.contains("POST /p/buddy/v1/runs"))
        precondition(calls.contains("GET /p/buddy/v1/runs/run_test"))
        precondition(calls.contains("POST /p/buddy/v1/runs/run_test/stop"))
        print("Buddy Hermes run submission, polling and remote stop: passed")
    }
}
