import Foundation

@main
enum CalendarServiceTests {
    static func main() throws {
        let now = ISO8601DateFormatter().date(from: "2026-10-06T12:00:00+02:00")!
        func event(_ id: String, _ start: String, _ end: String,
                   cancelled: Bool = false, allDay: Bool = false,
                   attendees: Int = 0, subject: String? = nil) -> [String: Any] {
            ["id": id, "subject": subject ?? id,
             "start": ["dateTime": start, "timeZone": "Europe/Amsterdam"],
             "end": ["dateTime": end, "timeZone": "Europe/Amsterdam"],
             "attendees": (0..<attendees).map { ["emailAddress": ["address": "person\($0)@example.com"]] },
             "isCancelled": cancelled, "isAllDay": allDay]
        }
        let raw = [
            event("later", "2026-10-06T15:00:00", "2026-10-06T16:00:00"),
            event("past", "2026-10-06T08:00:00", "2026-10-06T09:00:00"),
            event("ongoing", "2026-10-06T11:30:00", "2026-10-06T12:30:00"),
            event("cancelled", "2026-10-06T14:00:00", "2026-10-06T14:30:00", cancelled: true),
            event("all-day", "2026-10-06T00:00:00", "2026-10-07T00:00:00", allDay: true),
            event("focus", "2026-10-06T12:00:00", "2026-10-06T13:00:00", subject: "Vrij houden (werk)"),
            event("offwork", "2026-10-06T13:00:00", "2026-10-06T17:00:00", subject: "Niet beschikbaar"),
            event("invited", "2026-10-06T13:00:00", "2026-10-06T13:30:00", attendees: 1,
                  subject: "Niet beschikbaar — with someone"),
            event("tomorrow", "2026-10-07T09:00:00", "2026-10-07T10:00:00"),
        ]
        let data = try JSONSerialization.data(withJSONObject: raw)
        let events = try JSONDecoder().decode([GraphEvent].self, from: data)
        let actual = MeetingSchedule.upcoming(events, now: now).map(\.id)
        precondition(actual == ["ongoing", "invited", "later"], "Unexpected calendar: \(actual)")

        let autumn = ISO8601DateFormatter().date(from: "2026-10-25T12:00:00+01:00")!
        let range = MeetingSchedule.dayRange(now: autumn)
        precondition(range.duration == 25 * 3600, "Amsterdam DST day should be 25 hours")
        precondition(GraphMailbox.allows(URL(string: "https://graph.microsoft.com\(GraphMailbox.calendarPath)?%24skiptoken=next")!))
        precondition(!GraphMailbox.allows(URL(string: "https://graph.microsoft.com/v1.0/users/someone.else@example.com/calendarView")!))
        precondition(!GraphMailbox.allows(URL(string: "https://other.example.com\(GraphMailbox.calendarPath)")!))
        print("Buddy calendar filtering and Amsterdam DST: passed")
    }
}
