// nexus-cal: read calendar events with EventKit (expands repeating events correctly).
//   nexus-cal <days>   → {"events":[{"title":…,"start":ISO8601,"end":…,"all_day":bool,"calendar":…,"location":…}]}
// Exit code 2 = calendar access was not granted.
import EventKit
import Foundation

final class Flag: @unchecked Sendable { var granted = false }

let store = EKEventStore()
let flag = Flag()
let semaphore = DispatchSemaphore(value: 0)
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, _ in
        flag.granted = ok
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .event) { ok, _ in
        flag.granted = ok
        semaphore.signal()
    }
}
semaphore.wait()
guard flag.granted else {
    FileHandle.standardError.write("calendar access denied\n".data(using: .utf8)!)
    exit(2)
}

let days = CommandLine.arguments.count > 1 ? (Int(CommandLine.arguments[1]) ?? 1) : 1
let calendar = Calendar.current
let start = calendar.startOfDay(for: Date())
let end = calendar.date(byAdding: .day, value: max(1, min(days, 31)), to: start) ?? start
let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
let formatter = ISO8601DateFormatter()
formatter.timeZone = TimeZone.current
let events: [[String: Any]] = store.events(matching: predicate)
    .sorted { $0.startDate < $1.startDate }
    .map { e in
        [
            "title": e.title ?? "",
            "start": formatter.string(from: e.startDate),
            "end": formatter.string(from: e.endDate),
            "all_day": e.isAllDay,
            "calendar": e.calendar.title,
            "location": e.location ?? "",
        ]
    }
let data = try JSONSerialization.data(withJSONObject: ["events": events], options: [])
FileHandle.standardOutput.write(data)
