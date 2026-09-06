import SwiftUI

struct EntriesView: View {
    @ObservedObject var model: BabyTimerModel
    @State private var editingEntry: SleepEntry?

    private var groupedEntries: [(Date, [SleepEntry])] {
        let groups = Dictionary(grouping: model.entries) { Calendar.current.startOfDay(for: $0.startedAt) }
        return groups.keys.sorted(by: >).map { ($0, groups[$0]!.sorted { $0.startedAt > $1.startedAt }) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.entries.isEmpty {
                    EmptyStateView(title: "No entries yet", systemImage: "list.bullet.clipboard", message: "Completed wake windows and naps will appear here.")
                } else {
                    List {
                        ForEach(groupedEntries, id: \.0) { day, entries in
                            Section(entryDateFormatter.string(from: day)) {
                                ForEach(entries) { entry in
                                    EntryRow(entry: entry)
                                        .contentShape(Rectangle())
                                        .onTapGesture { editingEntry = entry }
                                        .accessibilityHint("Double tap to edit")
                                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                            Button(role: .destructive) { model.delete(entry) } label: {
                                                Label("Delete", systemImage: "trash")
                                            }
                                        }
                                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                            Button { editingEntry = entry } label: {
                                                Label("Edit", systemImage: "pencil")
                                            }
                                            .tint(.indigo)
                                        }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Entries")
            .sheet(item: $editingEntry) { entry in
                EntryEditor(entry: entry) { updated in
                    model.update(updated)
                }
            }
        }
    }
}

private struct EntryRow: View {
    let entry: SleepEntry

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: entry.mode == .nap ? "moon.fill" : "sun.max.fill")
                .foregroundStyle(entry.mode == .nap ? .indigo : .orange)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.mode.shortTitle)
                    .font(.headline)
                Text("\(entryTimeFormatter.string(from: entry.startedAt)) – \(entryTimeFormatter.string(from: entry.endedAt))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(durationText(entry.duration))
                .font(.headline.monospacedDigit())
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.mode.shortTitle), \(durationText(entry.duration)), \(entryTimeFormatter.string(from: entry.startedAt)) to \(entryTimeFormatter.string(from: entry.endedAt))")
    }
}

private struct EntryEditor: View {
    @Environment(\.dismiss) private var dismiss
    let entry: SleepEntry
    let onSave: (SleepEntry) -> Void
    @State private var mode: TimerMode
    @State private var startedAt: Date
    @State private var durationMinutes: String

    init(entry: SleepEntry, onSave: @escaping (SleepEntry) -> Void) {
        self.entry = entry
        self.onSave = onSave
        _mode = State(initialValue: entry.mode)
        _startedAt = State(initialValue: entry.startedAt)
        _durationMinutes = State(initialValue: String(Int(entry.duration / 60)))
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $mode) {
                    ForEach(TimerMode.allCases) { mode in
                        Text(mode.shortTitle).tag(mode)
                    }
                }
                DatePicker("Started", selection: $startedAt, displayedComponents: [.date, .hourAndMinute])
                TextField("Duration in minutes", text: $durationMinutes)
                    .keyboardType(.numberPad)
                    .accessibilityLabel("Duration in minutes")
            }
            .navigationTitle("Edit entry")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let duration = max(0, Double(durationMinutes) ?? 0) * 60
                        let updated = SleepEntry(id: entry.id, mode: mode, startedAt: startedAt, endedAt: startedAt.addingTimeInterval(duration), duration: duration)
                        onSave(updated)
                        dismiss()
                    }
                }
            }
        }
    }
}
