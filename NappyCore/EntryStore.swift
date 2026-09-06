import Foundation

public final class EntryStore {
    private let defaults: UserDefaults
    private let key: String
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(defaults: UserDefaults = .standard, key: String = "nappy.entries") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> [SleepEntry] {
        guard let data = defaults.data(forKey: key),
              let entries = try? decoder.decode([SleepEntry].self, from: data) else {
            return []
        }
        return entries.sorted { $0.startedAt > $1.startedAt }
    }

    public func save(_ entries: [SleepEntry]) {
        guard let data = try? encoder.encode(entries) else { return }
        defaults.set(data, forKey: key)
    }

    public func removeAll() {
        defaults.removeObject(forKey: key)
    }
}
