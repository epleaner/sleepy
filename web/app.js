if (import.meta.env.DEV) import("./styles.css");

const STORAGE_KEY = "nappy.pwa.entries";
const WAKE_CUE_SECONDS = 75 * 60;
const NAP_REMINDER_SECONDS = 105 * 60;

if (new URLSearchParams(window.location.search).has("reset")) {
  localStorage.removeItem(STORAGE_KEY);
}

let entries = loadEntries();
let active = null;
let selectedTab = "timer";
let selectedPeriod = "day";
let notificationTimers = [];
let editingEntryId = null;
let toastTimer = null;

const timerScreen = document.querySelector("#timer-screen");
const entriesScreen = document.querySelector("#entries-screen");
const insightsScreen = document.querySelector("#insights-screen");
const toast = document.querySelector("#toast");

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    selectedTab = button.dataset.tab;
    render();
  });
});

document.querySelector("#edit-form").addEventListener("submit", saveEditedEntry);
document.querySelector("#cancel-edit").addEventListener("click", closeEditor);
document.querySelector("#cancel-edit-secondary").addEventListener("click", closeEditor);

document.querySelector("#edit-modal").addEventListener("click", (event) => {
  if (event.target.id === "edit-modal") closeEditor();
});

setInterval(render, 1000);
render();
registerServiceWorker();

function render() {
  document.querySelector("#today-date").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date());
  timerScreen.classList.toggle("hidden", selectedTab !== "timer");
  entriesScreen.classList.toggle("hidden", selectedTab !== "entries");
  insightsScreen.classList.toggle("hidden", selectedTab !== "insights");
  document.querySelectorAll(".tab-button").forEach((button) => {
    const isActive = button.dataset.tab === selectedTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  renderTimerScreen();
  renderEntriesScreen();
  renderInsightsScreen();
}

function renderTimerScreen() {
  const timerCard = document.querySelector("#timer-card-mount");
  const totals = dailyTotals();
  timerCard.innerHTML = active ? renderActiveTimer() : "";

  document.querySelector("#daily-totals").innerHTML = `
    <h2 id="totals-title" class="panel-title">Today's totals</h2>
    <div class="totals-grid">
      ${renderTotal("Total wake", totals.wakeDuration, "wake", "☀")}
      ${renderTotal("Total sleep", totals.napDuration, "nap", "☾")}
    </div>
    <p class="panel-note">${totals.dayStart ? `Day started at ${formatTime(totals.dayStart)}` : "Day starts with the first wake after 6:30 AM."}</p>
  `;

  document.querySelector("#mode-controls").innerHTML = `
    <div class="controls">
      ${renderModeButton("wake")}
      ${renderModeButton("nap")}
    </div>
  `;

  const todaysEntries = totals.dayStart
    ? entries.filter((entry) => entry.startedAt >= totals.dayStart.getTime() && entry.startedAt <= Date.now())
    : [];
  document.querySelector("#today-entries").innerHTML = `
    <h2 id="entries-title" class="panel-title">Today's entries</h2>
    ${todaysEntries.length ? todaysEntries.map(renderHomeEntry).join("") : '<p class="empty-state">No completed windows today.</p>'}
  `;

  document.querySelectorAll("[data-action='start']").forEach((button) => {
    button.addEventListener("click", () => startMode(button.dataset.mode));
  });
  document.querySelector("[data-action='pause']")?.addEventListener("click", toggleNapPause);
}

function renderActiveTimer() {
  const elapsed = elapsedSeconds();
  const isCueTime = active.mode === "wake" && elapsed >= WAKE_CUE_SECONDS;
  const status = active.isPaused
    ? '<p class="pause-note">Paused</p>'
    : isCueTime
      ? '<p class="cue-note" role="status">Look for sleep cues</p>'
      : "";
  const pauseButton = active.mode === "nap"
    ? `<button class="primary-button pause-button" data-action="pause" type="button">${active.isPaused ? "Resume nap" : "Pause nap"}</button>`
    : "";
  return `
    <section class="timer-card" aria-label="${active.mode === "nap" ? "Nap" : "Wake window"} timer">
      <div class="timer-kind ${active.mode}">${active.mode === "nap" ? "☾ Nap" : "☀ Wake window"}</div>
      <div class="timer-value" aria-live="off">${timerText(elapsed)}</div>
      ${status}
      ${pauseButton}
    </section>
  `;
}

function renderModeButton(mode) {
  const isActive = active?.mode === mode;
  return `<button class="primary-button ${mode}" data-action="start" data-mode="${mode}" type="button" aria-label="${mode === "wake" ? "Start wake timer" : "Start nap timer"}" ${isActive ? "disabled" : ""}>
    ${mode === "wake" ? "☀ Start wake" : "☾ Start nap"}
  </button>`;
}

function renderTotal(title, duration, color, icon) {
  return `<div class="total-card">
    <span class="total-label ${color}"><span aria-hidden="true">${icon}</span>${title}</span>
    <span class="total-value">${formatDuration(duration)}</span>
  </div>`;
}

function renderHomeEntry(entry) {
  return `<div class="entry-row">
    <div class="entry-main">
      <span aria-hidden="true">${entry.mode === "nap" ? "☾" : "☀"}</span>
      <span class="entry-type">${entry.mode === "nap" ? "Sleep" : "Wake"}</span>
      <span class="entry-time">${formatTime(new Date(entry.startedAt))}</span>
    </div>
    <span class="entry-duration">${formatDuration(entry.duration)}</span>
  </div>`;
}

function renderEntriesScreen() {
  const mount = document.querySelector("#entries-list");
  if (!entries.length) {
    mount.innerHTML = '<section class="panel"><p class="empty-state">No entries yet. Completed wake windows and naps will appear here.</p></section>';
    return;
  }

  const groups = new Map();
  [...entries].sort((a, b) => b.startedAt - a.startedAt).forEach((entry) => {
    const key = startOfDay(new Date(entry.startedAt)).getTime();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  mount.innerHTML = `<div class="entries-stack">${[...groups.entries()].map(([day, dayEntries]) => `
    <section class="entry-section panel" aria-labelledby="day-${day}">
      <h2 id="day-${day}">${formatDate(new Date(Number(day)))}</h2>
      ${dayEntries.map(renderManagedEntry).join("")}
    </section>
  `).join("")}</div>`;
  mount.querySelectorAll("[data-action='edit']").forEach((button) => button.addEventListener("click", () => openEditor(button.dataset.id)));
  mount.querySelectorAll("[data-action='delete']").forEach((button) => button.addEventListener("click", () => deleteEntry(button.dataset.id)));
}

function renderManagedEntry(entry) {
  return `<div class="entry-row">
    <div class="entry-main">
      <span aria-hidden="true">${entry.mode === "nap" ? "☾" : "☀"}</span>
      <span class="entry-type">${entry.mode === "nap" ? "Sleep" : "Wake"}</span>
      <span class="entry-time">${formatTime(new Date(entry.startedAt))} – ${formatTime(new Date(entry.endedAt))}</span>
    </div>
    <span class="entry-duration">${formatDuration(entry.duration)}</span>
    <div class="entry-actions">
      <button class="icon-button" data-action="edit" data-id="${entry.id}" type="button" aria-label="Edit ${entry.mode === "nap" ? "sleep" : "wake"} entry">✎</button>
      <button class="icon-button delete-button" data-action="delete" data-id="${entry.id}" type="button" aria-label="Delete ${entry.mode === "nap" ? "sleep" : "wake"} entry">×</button>
    </div>
  </div>`;
}

function renderInsightsScreen() {
  const averages = calculateAverages(selectedPeriod);
  document.querySelector("#insights-content").innerHTML = `
    <div class="segmented-control" role="tablist" aria-label="Time range">
      ${["day", "week", "month", "allTime"].map((period) => `<button class="segment-button ${period === selectedPeriod ? "active" : ""}" data-period="${period}" type="button" role="tab" aria-selected="${period === selectedPeriod}">${periodTitle(period)}</button>`).join("")}
    </div>
    <section aria-labelledby="average-title">
      <h2 id="average-title">${periodTitle(selectedPeriod)}</h2>
      <p class="muted">Average completed window</p>
      <div class="average-grid">
        ${renderAverage("Wake", averages.wakeAverage, averages.wakeCount, "wake", "☀")}
        ${renderAverage("Sleep", averages.napAverage, averages.napCount, "nap", "☾")}
      </div>
      ${averages.wakeCount === 0 && averages.napCount === 0
        ? '<p class="empty-state panel">Not enough data. Complete a wake window or nap to see averages.</p>'
        : '<p class="panel-note">Counts use entries started within the selected range. Paused nap time is excluded from duration.</p>'}
    </section>
  `;
  document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    render();
  }));
}

function renderAverage(title, duration, count, color, icon) {
  return `<div class="average-card">
    <span class="total-label ${color}"><span aria-hidden="true">${icon}</span>${title}</span>
    <span class="average-value">${formatDuration(duration)}</span>
    <span class="average-count">${count} ${count === 1 ? "entry" : "entries"}</span>
  </div>`;
}

function startMode(mode) {
  if (active?.mode === mode) return;
  const now = Date.now();
  if (active) {
    addEntry(stopActive(now));
  }
  active = {
    mode,
    startedAt: now,
    accumulatedSeconds: 0,
    lastResumedAt: now,
    isPaused: false
  };
  if (mode === "wake") scheduleWakeNotifications(now);
  else cancelWakeNotifications();
  render();
}

function toggleNapPause() {
  if (!active || active.mode !== "nap") return;
  const now = Date.now();
  if (active.isPaused) {
    active.isPaused = false;
    active.lastResumedAt = now;
  } else {
    active.accumulatedSeconds = elapsedSeconds(now);
    active.isPaused = true;
    active.lastResumedAt = null;
  }
  render();
}

function stopActive(now) {
  const stopped = {
    id: crypto.randomUUID(),
    mode: active.mode,
    startedAt: active.startedAt,
    endedAt: now,
    duration: elapsedSeconds(now)
  };
  active = null;
  return stopped;
}

function elapsedSeconds(now = Date.now()) {
  if (!active) return 0;
  if (active.isPaused || active.lastResumedAt === null) return active.accumulatedSeconds;
  return Math.max(0, active.accumulatedSeconds + (now - active.lastResumedAt) / 1000);
}

function addEntry(entry) {
  entries = [entry, ...entries].sort((a, b) => b.startedAt - a.startedAt);
  saveEntries();
}

function dailyTotals(now = new Date()) {
  const calendarDayStart = startOfDay(now);
  const cutoff = new Date(calendarDayStart.getTime() + 390 * 60 * 1000);
  const nextDay = new Date(calendarDayStart.getTime() + 24 * 60 * 60 * 1000);
  const wakeStarts = entries
    .filter((entry) => entry.mode === "wake" && entry.startedAt >= cutoff.getTime() && entry.startedAt < nextDay.getTime())
    .map((entry) => entry.startedAt);
  if (active?.mode === "wake" && active.startedAt >= cutoff.getTime() && active.startedAt < nextDay.getTime()) {
    wakeStarts.push(active.startedAt);
  }
  if (!wakeStarts.length) return { dayStart: null, wakeDuration: null, napDuration: null };

  const dayStart = new Date(Math.min(...wakeStarts));
  const relevant = entries.filter((entry) => entry.startedAt >= dayStart.getTime() && entry.startedAt <= now.getTime());
  let wakeDuration = relevant.filter((entry) => entry.mode === "wake").reduce((sum, entry) => sum + entry.duration, 0);
  let napDuration = relevant.filter((entry) => entry.mode === "nap").reduce((sum, entry) => sum + entry.duration, 0);
  if (active?.startedAt >= dayStart.getTime() && active.startedAt <= now.getTime()) {
    if (active.mode === "wake") wakeDuration += elapsedSeconds(now.getTime());
    if (active.mode === "nap") napDuration += elapsedSeconds(now.getTime());
  }
  return { dayStart, wakeDuration, napDuration };
}

function calculateAverages(period) {
  const interval = periodInterval(period, new Date());
  const filtered = entries.filter((entry) => !interval || (entry.startedAt >= interval.start.getTime() && entry.startedAt < interval.end.getTime()));
  const wake = filtered.filter((entry) => entry.mode === "wake").map((entry) => entry.duration);
  const nap = filtered.filter((entry) => entry.mode === "nap").map((entry) => entry.duration);
  return {
    wakeAverage: wake.length ? wake.reduce((sum, value) => sum + value, 0) / wake.length : null,
    napAverage: nap.length ? nap.reduce((sum, value) => sum + value, 0) / nap.length : null,
    wakeCount: wake.length,
    napCount: nap.length
  };
}

function periodInterval(period, now) {
  const day = startOfDay(now);
  if (period === "day") return { start: day, end: new Date(day.getTime() + 86400000) };
  if (period === "month") return { start: new Date(day.getFullYear(), day.getMonth(), 1), end: new Date(day.getFullYear(), day.getMonth() + 1, 1) };
  if (period === "week") {
    const mondayOffset = (day.getDay() + 6) % 7;
    const start = new Date(day.getTime() - mondayOffset * 86400000);
    return { start, end: new Date(start.getTime() + 7 * 86400000) };
  }
  return null;
}

function scheduleWakeNotifications(startedAt) {
  cancelWakeNotifications();
  const schedule = (delay, body) => {
    const timer = window.setTimeout(() => showNotification(body), Math.max(1000, delay * 1000));
    notificationTimers.push(timer);
  };
  requestNotificationPermission().then((allowed) => {
    if (!allowed) return;
    if (active?.mode !== "wake" || active.startedAt !== startedAt) return;
    schedule(WAKE_CUE_SECONDS - (Date.now() - startedAt) / 1000, "Start looking for sleep cues");
    schedule(NAP_REMINDER_SECONDS - (Date.now() - startedAt) / 1000, "Time for a nap!");
  });
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

function showNotification(body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("Nappy", { body });
  }
  showToast(body);
}

function cancelWakeNotifications() {
  notificationTimers.forEach((timer) => window.clearTimeout(timer));
  notificationTimers = [];
}

function openEditor(id) {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  editingEntryId = id;
  document.querySelector("#edit-mode").value = entry.mode;
  document.querySelector("#edit-started").value = toLocalInputValue(new Date(entry.startedAt));
  document.querySelector("#edit-duration").value = String(Math.floor(entry.duration / 60));
  document.querySelector("#edit-modal").classList.remove("hidden");
  document.querySelector("#edit-mode").focus();
}

function closeEditor() {
  editingEntryId = null;
  document.querySelector("#edit-modal").classList.add("hidden");
}

function saveEditedEntry(event) {
  event.preventDefault();
  const entry = entries.find((candidate) => candidate.id === editingEntryId);
  if (!entry) return;
  const startedAt = new Date(document.querySelector("#edit-started").value).getTime();
  const duration = Math.max(0, Number(document.querySelector("#edit-duration").value) || 0) * 60;
  if (!Number.isFinite(startedAt)) return;
  entry.mode = document.querySelector("#edit-mode").value;
  entry.startedAt = startedAt;
  entry.duration = duration;
  entry.endedAt = startedAt + duration * 1000;
  entries.sort((a, b) => b.startedAt - a.startedAt);
  saveEntries();
  closeEditor();
  render();
}

function deleteEntry(id) {
  entries = entries.filter((entry) => entry.id !== id);
  saveEntries();
  render();
}

function loadEntries() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const localDevelopment = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname.endsWith(".localhost");
  if (localDevelopment) {
    navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())));
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
    return;
  }
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timerText(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function periodTitle(period) {
  return { day: "Today", week: "This week", month: "This month", allTime: "All time" }[period];
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 3500);
}
