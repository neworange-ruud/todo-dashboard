import Foundation

// The credential is tenant-wide; every Graph calendar URL is pinned to this mailbox.
enum GraphMailbox {
    static let address = "ruud.vanfalier@neworange.agency"
    static let calendarPath = "/v1.0/users/\(address)/calendarView"

    static func allows(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "graph.microsoft.com" && url.path == calendarPath
    }
}

private let amsterdam = TimeZone(identifier: "Europe/Amsterdam")!

struct UpcomingMeeting: Equatable {
    let id: String
    let subject: String
    let start: Date
    let end: Date
    let location: String?

    var json: [String: Any] {
        ["id": id, "subject": subject, "startMs": start.timeIntervalSince1970 * 1000,
         "endMs": end.timeIntervalSince1970 * 1000, "location": location as Any? ?? NSNull()]
    }
}

struct GraphDateTime: Decodable {
    let dateTime: String?
    let timeZone: String?
}

struct GraphLocation: Decodable {
    let displayName: String?
}

struct GraphEvent: Decodable {
    let id: String?
    let subject: String?
    let start: GraphDateTime?
    let end: GraphDateTime?
    let location: GraphLocation?
    let attendees: [GraphAttendee]?
    let isAllDay: Bool?
    let isCancelled: Bool?
}

struct GraphAttendee: Decodable {
    let emailAddress: GraphEmail?
}

struct GraphEmail: Decodable {
    let address: String?
}

private struct GraphPage: Decodable {
    let value: [GraphEvent]
    let nextLink: String?

    enum CodingKeys: String, CodingKey {
        case value
        case nextLink = "@odata.nextLink"
    }
}

private struct TokenResponse: Decodable {
    let accessToken: String
    let expiresIn: TimeInterval

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case expiresIn = "expires_in"
    }
}

private struct Credentials {
    let tenant: String
    let client: String
    let secret: String

    init?() {
        var values = ProcessInfo.processInfo.environment
        if let path = values["BUDDY_GRAPH_ENV_FILE"],
           let text = try? String(contentsOfFile: path, encoding: .utf8) {
            for line in text.components(separatedBy: .newlines) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty, !trimmed.hasPrefix("#") else { continue }
                let parts = trimmed.replacingOccurrences(of: "export ", with: "")
                    .split(separator: "=", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                let key = parts[0].trimmingCharacters(in: .whitespaces)
                var value = parts[1].trimmingCharacters(in: .whitespaces)
                if value.count >= 2, value.first == value.last,
                   value.first == "\"" || value.first == "'" {
                    value.removeFirst()
                    value.removeLast()
                }
                if values[key] == nil { values[key] = value }
            }
        }
        guard let tenant = values["GRAPH_TENANT_ID"], !tenant.isEmpty,
              let client = values["GRAPH_CLIENT_ID"], !client.isEmpty,
              let secret = values["GRAPH_SECRET"], !secret.isEmpty else { return nil }
        self.tenant = tenant
        self.client = client
        self.secret = secret
    }
}

enum CalendarError: Error {
    case notConfigured
    case requestFailed
    case invalidResponse
}

enum MeetingSchedule {
    static func dayRange(now: Date) -> DateInterval {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = amsterdam
        let start = calendar.startOfDay(for: now)
        return DateInterval(start: start, end: calendar.date(byAdding: .day, value: 1, to: start)!)
    }

    static func upcoming(_ events: [GraphEvent], now: Date) -> [UpcomingMeeting] {
        let day = dayRange(now: now)
        return events.compactMap { event in
            guard event.isCancelled != true, event.isAllDay != true,
                  let id = event.id, !id.isEmpty,
                  let start = instant(event.start), let end = instant(event.end),
                  end > now, start < day.end, end > day.start else { return nil }

            // Task Desk treats these solo Outlook entries as framing blocks, not meetings.
            let subject = event.subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let normalized = subject.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            if (event.attendees?.isEmpty ?? true) &&
                (normalized.hasPrefix("vrij houden") || normalized.hasPrefix("niet beschikbaar")) {
                return nil
            }
            let location = event.location?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            return UpcomingMeeting(id: id, subject: subject.isEmpty ? "(no subject)" : subject,
                                   start: start, end: end,
                                   location: location?.isEmpty == false ? location : nil)
        }.sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
    }

    private static func instant(_ value: GraphDateTime?) -> Date? {
        guard let raw = value?.dateTime, !raw.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: raw) { return date }
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: raw) { return date }

        // Graph's Prefer header returns Amsterdam wall-clock values without an offset.
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = ["UTC", "GMT", "GMT STANDARD TIME"].contains(value?.timeZone?.uppercased() ?? "")
            ? TimeZone(secondsFromGMT: 0) : amsterdam
        parser.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return parser.date(from: String(raw.prefix(19)))
    }
}

@MainActor
final class CalendarService {
    private var token: String?
    private var tokenExpires = Date.distantPast

    func fetchToday() async throws -> [UpcomingMeeting] {
        guard let credentials = Credentials() else { throw CalendarError.notConfigured }
        let now = Date()
        let day = MeetingSchedule.dayRange(now: now)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        var components = URLComponents(string: "https://graph.microsoft.com\(GraphMailbox.calendarPath)")!
        components.queryItems = [
            URLQueryItem(name: "startDateTime", value: iso.string(from: day.start)),
            URLQueryItem(name: "endDateTime", value: iso.string(from: day.end)),
            URLQueryItem(name: "$select", value: "id,subject,start,end,location,attendees,isAllDay,isCancelled"),
            URLQueryItem(name: "$orderby", value: "start/dateTime"),
            URLQueryItem(name: "$top", value: "100"),
        ]

        let bearer = try await accessToken(credentials)
        var url = components.url!
        var events: [GraphEvent] = []
        repeat {
            // Even a Graph pagination link must stay on this one mailbox's calendar.
            guard GraphMailbox.allows(url) else {
                throw CalendarError.invalidResponse
            }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("outlook.timezone=\"Europe/Amsterdam\"", forHTTPHeaderField: "Prefer")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                token = nil
                throw CalendarError.requestFailed
            }
            let page = try JSONDecoder().decode(GraphPage.self, from: data)
            events += page.value
            guard let next = page.nextLink else { break }
            guard let nextURL = URL(string: next) else { throw CalendarError.invalidResponse }
            url = nextURL
        } while true
        return MeetingSchedule.upcoming(events, now: Date())
    }

    private func accessToken(_ credentials: Credentials) async throws -> String {
        if let token, tokenExpires > Date().addingTimeInterval(60) { return token }
        let url = URL(string: "https://login.microsoftonline.com/\(credentials.tenant)/oauth2/v2.0/token")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var body = URLComponents()
        body.queryItems = [
            URLQueryItem(name: "client_id", value: credentials.client),
            URLQueryItem(name: "client_secret", value: credentials.secret),
            URLQueryItem(name: "scope", value: "https://graph.microsoft.com/.default"),
            URLQueryItem(name: "grant_type", value: "client_credentials"),
        ]
        request.httpBody = body.percentEncodedQuery?.data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CalendarError.requestFailed
        }
        let result = try JSONDecoder().decode(TokenResponse.self, from: data)
        token = result.accessToken
        tokenExpires = Date().addingTimeInterval(result.expiresIn)
        return result.accessToken
    }
}
