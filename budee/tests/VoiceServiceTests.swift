import Foundation

@main
enum VoiceServiceTests {
    static func main() {
        precondition(BuddyReplyLanguage.detect("Goedemorgen! Hoe gaat het met je vandaag? Ik kan je helpen met je afspraken en taken.") == .dutch)
        precondition(BuddyReplyLanguage.detect("Good morning! I can help you review your meetings and tasks today.") == .english)
        precondition(BuddyReplyLanguage.detect("OK") == .dutch)
        precondition(BuddyReplyLanguage.dutch.voiceID(dutch: "nl-voice", english: "en-voice", legacy: nil) == "nl-voice")
        precondition(BuddyReplyLanguage.english.voiceID(dutch: "nl-voice", english: "en-voice", legacy: nil) == "en-voice")
        precondition(BuddyReplyLanguage.english.voiceID(dutch: "nl-voice", english: nil, legacy: nil) == "nl-voice")
        print("Buddy reply language selection: passed")
    }
}
