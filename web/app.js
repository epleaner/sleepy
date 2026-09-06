import "./styles.css";
import { icon as fontAwesomeIcon } from "@fortawesome/fontawesome-svg-core";
import {
  faChartLine,
  faClock,
  faCopy,
  faList,
  faMoon,
  faPen,
  faSliders,
  faSun,
  faTrash,
  faXmark
} from "@fortawesome/free-solid-svg-icons";

const HOUSEHOLD_STORAGE_KEY = "nappy.household.id";
const API_ROOT = "/api";
const WAKE_CUE_SECONDS = 75 * 60;
const NAP_REMINDER_SECONDS = 105 * 60;

const ICONS = {
  timer: faClock,
  list: faList,
  chart: faChartLine,
  settings: faSliders,
  sun: faSun,
  moon: faMoon,
  edit: faPen,
  trash: faTrash,
  close: faXmark,
  copy: faCopy
};

function icon(name) {
  return fontAwesomeIcon(ICONS[name], { classes: ["ui-icon"], attributes: { "aria-hidden": "true" } }).html.join("");
}

document.querySelectorAll("[data-icon]").forEach((node) => {
  node.innerHTML = icon(node.dataset.icon);
});
const params = new URLSearchParams(window.location.search);
if (params.has("reset") && !params.has("household")) localStorage.removeItem(HOUSEHOLD_STORAGE_KEY);

let householdId = null;
let entries = [];
let active = null;
let timerRevision = 0;
let serverClockOffset = 0;
let timerMutationInFlight = false;
let householdDeletionInFlight = false;
let selectedTab = "timer";
let selectedPeriod = "day";
let notificationTimers = [];
let editingEntryId = null;
let toastTimer = null;
let refreshInFlight = false;

const householdGate = document.querySelector("#household-gate");
const app = document.querySelector("#app");
const householdError = document.querySelector("#household-error");
const householdCode = document.querySelector("#household-code");
const timerScreen = document.querySelector("#timer-screen");
const entriesScreen = document.querySelector("#entries-screen");
const insightsScreen = document.querySelector("#insights-screen");
const settingsScreen = document.querySelector("#settings-screen");

document.querySelector("#create-household").addEventListener("click", createHousehold);
document.querySelector("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  joinHousehold(householdCode.value);
});
document.querySelector("#share-household").addEventListener("click", shareHousehold);
document.querySelector("#settings-content").addEventListener("click", (event) => {
  if (event.target.closest("[data-action='copy-household']")) void copyHouseholdId();
  if (event.target.closest("[data-action='delete-household']")) void deleteHousehold();
});
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
setInterval(() => refreshEntries(true), 2000);
void boot();

async function boot() {
  const queryValue = params.get("household");
  const queryHousehold = normalizeHouseholdId(queryValue || "");
  if (queryValue && !queryHousehold) {
    showGate("That household link is invalid. Enter an eight-character household ID.");
    householdCode.value = queryValue.slice(0, 8).toUpperCase();
    return;
  }
  if (queryHousehold) {
    householdCode.value = queryHousehold;
    await joinHousehold(queryHousehold, true);
    return;
  }

  const savedHousehold = normalizeHouseholdId(localStorage.getItem(HOUSEHOLD_STORAGE_KEY) || "");
  if (savedHousehold) {
    try {
      await loadHousehold(savedHousehold);
      enterHousehold(savedHousehold);
      return;
    } catch {
      localStorage.removeItem(HOUSEHOLD_STORAGE_KEY);
    }
  }
  showGate();
}

async function createHousehold() {
  setGateBusy(true);
  clearGateError();
  try {
    const household = await api("/households", { method: "POST" });
    await loadHousehold(household.id);
    enterHousehold(household.id);
  } catch (error) {
    showGate(error.message);
  } finally {
    setGateBusy(false);
  }
}

async function joinHousehold(value, fromLink = false) {
  const id = normalizeHouseholdId(value);
  if (!id) {
    showGate("Enter the eight-character household ID.");
    return;
  }
  setGateBusy(true);
  clearGateError();
  try {
    await api(`/households/${id}/join`, { method: "POST" });
    await loadHousehold(id);
    enterHousehold(id);
  } catch (error) {
    showGate(fromLink ? "That household could not be found." : error.message);
  } finally {
    setGateBusy(false);
  }
}

function enterHousehold(id) {
  householdId = id;
  localStorage.setItem(HOUSEHOLD_STORAGE_KEY, id);
  const url = new URL(window.location.href);
  url.searchParams.delete("reset");
  url.searchParams.set("household", id);
  window.history.replaceState({}, "", url);
  householdGate.classList.add("hidden");
  app.classList.remove("hidden");
  render();
}

function showGate(error = "") {
  householdGate.classList.remove("hidden");
  app.classList.add("hidden");
  householdError.textContent = error;
}

function clearGateError() {
  householdError.textContent = "";
}

function setGateBusy(busy) {
  document.querySelector("#create-household").disabled = busy;
  document.querySelector("#join-form button").disabled = busy;
}

async function loadHousehold(id) {
  const household = await api(`/households/${id}`);
  entries = household.entries.map(normalizeEntry).sort((a, b) => b.startedAt - a.startedAt);
  applyTimerState(household);
}

function applyTimerState(state, requestNotifications = false) {
  const nextRevision = Number(state.timerRevision || 0);
  if (nextRevision < timerRevision) return;
  const previous = active;
  timerRevision = nextRevision;
  if (!state.activeTimer) {
    active = null;
    if (previous) cancelWakeNotifications();
    return;
  }
  const next = normalizeTimer(state.activeTimer);
  const changed = !previous
    || previous.mode !== next.mode
    || previous.startedAt !== next.startedAt
    || previous.accumulatedSeconds !== next.accumulatedSeconds
    || previous.lastResumedAt !== next.lastResumedAt
    || previous.isPaused !== next.isPaused;
  serverClockOffset = next.serverNow - Date.now();
  active = next;
  if (changed) {
    cancelWakeNotifications();
    if (active.mode === "wake") scheduleWakeNotifications(active.startedAt, requestNotifications);
  }
}

async function mutateTimer(action, mode = null, requestNotifications = false) {
  if (!householdId || timerMutationInFlight) return;
  timerMutationInFlight = true;
  try {
    const state = await api(`/households/${householdId}/timer`, {
      method: "POST",
      body: JSON.stringify({ action, ...(mode ? { mode } : {}) })
    });
    if (state.entry) entries = [normalizeEntry(state.entry), ...entries].sort((a, b) => b.startedAt - a.startedAt);
    applyTimerState(state, requestNotifications);
    render();
  } catch (error) {
    showToast(error.message);
  } finally {
    timerMutationInFlight = false;
  }
}

async function refreshEntries(silent = false) {
  if (!householdId || refreshInFlight) return;
  refreshInFlight = true;
  try {
    await loadHousehold(householdId);
    if (!app.classList.contains("hidden")) render();
  } catch (error) {
    if (!silent) showToast(error.message);
  } finally {
    refreshInFlight = false;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      cache: "no-store",
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) }
    });
  } catch {
    throw new Error("Could not connect to the household service.");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Empty responses, such as DELETE, are valid.
  }
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function render() {
  document.querySelector("#today-date").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date());
  timerScreen.classList.toggle("hidden", selectedTab !== "timer");
  entriesScreen.classList.toggle("hidden", selectedTab !== "entries");
  insightsScreen.classList.toggle("hidden", selectedTab !== "insights");
  settingsScreen.classList.toggle("hidden", selectedTab !== "settings");
  document.querySelectorAll(".tab-button").forEach((button) => {
    const isActive = button.dataset.tab === selectedTab;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  renderTimerScreen();
  renderEntriesScreen();
  renderInsightsScreen();
  renderSettingsScreen();
}

function renderTimerScreen() {
  const timerCard = document.querySelector("#timer-card-mount");
  const totals = dailyTotals();
  timerCard.innerHTML = active ? renderActiveTimer() : "";

  document.querySelector("#daily-totals").innerHTML = `
    <h2 id="totals-title" class="panel-title">Today's totals</h2>
    <div class="totals-grid">
      ${renderTotal("Total wake", totals.wakeDuration, "wake", "sun")}
      ${renderTotal("Total sleep", totals.napDuration, "nap", "moon")}
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

  document.querySelectorAll("[data-action='start']").forEach((button) => button.addEventListener("click", () => { void startMode(button.dataset.mode); }));
  document.querySelector("[data-action='pause']")?.addEventListener("click", () => { void toggleNapPause(); });
  document.querySelector("[data-action='stop']")?.addEventListener("click", () => { void stopTimer(); });
}

function renderActiveTimer() {
  const elapsed = elapsedSeconds();
  const status = active.isPaused
    ? '<p class="pause-note">Paused</p>'
    : active.mode === "wake"
      ? `<p class="timer-note">sleepies starting around ${formatTime(sleepiesStartAt(active.startedAt))}</p>`
      : "";
  const pauseButton = active.mode === "nap"
    ? `<button class="primary-button pause-button" data-action="pause" type="button" ${timerMutationInFlight ? "disabled" : ""}>${active.isPaused ? "Resume nap" : "Pause nap"}</button>`
    : "";
  return `
    <section class="timer-card" aria-label="${active.mode === "nap" ? "Nap" : "Wake window"} timer">
      <div class="timer-kind ${active.mode}">${icon(active.mode === "nap" ? "moon" : "sun")}<span>${active.mode === "nap" ? "Nap" : "Wake window"}</span></div>
      <div class="timer-value" aria-live="off">${timerText(elapsed)}</div>
      ${status}
      <div class="timer-actions">
        ${pauseButton}
        <button class="secondary-button" data-action="stop" type="button" ${timerMutationInFlight ? "disabled" : ""}>Stop timer</button>
      </div>
    </section>
  `;
}

function renderModeButton(mode) {
  const isActive = active?.mode === mode;
  return `<button class="primary-button ${mode}" data-action="start" data-mode="${mode}" type="button" aria-label="${mode === "wake" ? "Start wake timer" : "Start nap timer"}" ${isActive || timerMutationInFlight ? "disabled" : ""}>
    ${icon(mode === "wake" ? "sun" : "moon")}<span>${mode === "wake" ? "Start wake" : "Start nap"}</span>
  </button>`;
}
function renderTotal(title, duration, color, iconName) {
  return `<div class="total-card">
    <span class="total-label ${color}">${icon(iconName)}<span>${title}</span></span>
    <span class="total-value">${formatDuration(duration)}</span>
  </div>`;
}

function renderHomeEntry(entry) {
  return `<div class="entry-row">
    <div class="entry-main">
      ${icon(entry.mode === "nap" ? "moon" : "sun")}<span class="entry-type">${entry.mode === "nap" ? "Sleep" : "Wake"}</span>
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
  mount.querySelectorAll("[data-action='delete']").forEach((button) => button.addEventListener("click", () => { void deleteEntry(button.dataset.id); }));
}

function renderManagedEntry(entry) {
  return `<div class="entry-row">
    <div class="entry-main">
      ${icon(entry.mode === "nap" ? "moon" : "sun")}<span class="entry-type">${entry.mode === "nap" ? "Sleep" : "Wake"}</span>
      <span class="entry-time">${formatTime(new Date(entry.startedAt))} – ${formatTime(new Date(entry.endedAt))}</span>
    </div>
    <span class="entry-duration">${formatDuration(entry.duration)}</span>
    <div class="entry-actions">
      <button class="icon-button" data-action="edit" data-id="${entry.id}" type="button" aria-label="Edit ${entry.mode === "nap" ? "sleep" : "wake"} entry">${icon("edit")}</button>
      <button class="icon-button delete-button" data-action="delete" data-id="${entry.id}" type="button" aria-label="Delete ${entry.mode === "nap" ? "sleep" : "wake"} entry">${icon("trash")}</button>
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
        ${renderAverage("Wake", averages.wakeAverage, averages.wakeCount, "wake", "sun")}
        ${renderAverage("Sleep", averages.napAverage, averages.napCount, "nap", "moon")}
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

function renderSettingsScreen() {
  document.querySelector("#settings-content").innerHTML = `
    <div class="settings-stack">
      <section class="panel" aria-labelledby="household-settings-title">
        <h2 id="household-settings-title" class="panel-title">Household</h2>
        <p class="settings-copy">Share this ID with anyone who should join this household.</p>
        <button class="copy-id-button" data-action="copy-household" type="button" aria-label="Copy household ID ${householdId}">
          <code class="household-id">${householdId}</code>
          ${icon("copy")}
        </button>
      </section>
      <section class="panel danger-panel" aria-labelledby="delete-household-title">
        <h2 id="delete-household-title" class="panel-title">Delete household</h2>
        <p class="settings-copy">This permanently deletes the household, its completed entries, and any active timer.</p>
        <button class="danger-button" data-action="delete-household" type="button" ${householdDeletionInFlight ? "disabled" : ""}>Delete household</button>
      </section>
    </div>
  `;
}

function renderAverage(title, duration, count, color, iconName) {
  return `<div class="average-card">
    <span class="total-label ${color}">${icon(iconName)}<span>${title}</span></span>
    <span class="average-value">${formatDuration(duration)}</span>
    <span class="average-count">${count} ${count === 1 ? "entry" : "entries"}</span>
  </div>`;
}

async function startMode(mode) {
  if (active?.mode === mode || timerMutationInFlight) return;
  await mutateTimer("start", mode, true);
}

async function toggleNapPause() {
  if (!active || active.mode !== "nap" || timerMutationInFlight) return;
  await mutateTimer(active.isPaused ? "resume" : "pause");
}

async function stopTimer() {
  if (!active || timerMutationInFlight) return;
  await mutateTimer("stop");
}

function elapsedSeconds(now = nowMs()) {
  if (!active) return 0;
  if (active.isPaused || active.lastResumedAt === null) return active.accumulatedSeconds;
  return Math.max(0, active.accumulatedSeconds + (now - active.lastResumedAt) / 1000);
}

function nowMs() {
  return Date.now() + serverClockOffset;
}

function dailyTotals(now = new Date()) {
  const calendarDayStart = startOfDay(now);
  const cutoff = new Date(calendarDayStart.getTime() + 390 * 60 * 1000);
  const nextDay = new Date(calendarDayStart.getTime() + 24 * 60 * 60 * 1000);
  const wakeStarts = entries
    .filter((entry) => entry.mode === "wake" && entry.startedAt >= cutoff.getTime() && entry.startedAt < nextDay.getTime())
    .map((entry) => entry.startedAt);
  if (active?.mode === "wake" && active.startedAt >= cutoff.getTime() && active.startedAt < nextDay.getTime()) wakeStarts.push(active.startedAt);
  if (!wakeStarts.length) return { dayStart: null, wakeDuration: null, napDuration: null };
  const dayStart = new Date(Math.min(...wakeStarts));
  const relevant = entries.filter((entry) => entry.startedAt >= dayStart.getTime() && entry.startedAt <= now.getTime());
  let wakeDuration = relevant.filter((entry) => entry.mode === "wake").reduce((sum, entry) => sum + entry.duration, 0);
  let napDuration = relevant.filter((entry) => entry.mode === "nap").reduce((sum, entry) => sum + entry.duration, 0);
  if (active?.startedAt >= dayStart.getTime() && active.startedAt <= now.getTime()) {
    if (active.mode === "wake") wakeDuration += elapsedSeconds(now.getTime() + serverClockOffset);
    if (active.mode === "nap") napDuration += elapsedSeconds(now.getTime() + serverClockOffset);
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

function scheduleWakeNotifications(startedAt, requestPermission = false) {
  cancelWakeNotifications();
  const schedule = (delay, body) => {
    const timer = window.setTimeout(() => showNotification(body), Math.max(1000, delay * 1000));
    notificationTimers.push(timer);
  };
  const permission = requestPermission
    ? requestNotificationPermission()
    : Promise.resolve("Notification" in window && Notification.permission === "granted");
  permission.then((allowed) => {
    if (!allowed || active?.mode !== "wake" || active.startedAt !== startedAt) return;
    schedule(WAKE_CUE_SECONDS - (nowMs() - startedAt) / 1000, "Start looking for sleep cues");
    schedule(NAP_REMINDER_SECONDS - (nowMs() - startedAt) / 1000, "Time for a nap!");
  });
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

function showNotification(body) {
  if ("Notification" in window && Notification.permission === "granted") new Notification("Nappy", { body });
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

async function saveEditedEntry(event) {
  event.preventDefault();
  const entry = entries.find((candidate) => candidate.id === editingEntryId);
  if (!entry) return;
  const startedAt = new Date(document.querySelector("#edit-started").value).getTime();
  const duration = Math.max(0, Number(document.querySelector("#edit-duration").value) || 0) * 60;
  if (!Number.isFinite(startedAt)) return;
  const updated = { ...entry, mode: document.querySelector("#edit-mode").value, startedAt, duration, endedAt: startedAt + duration * 1000 };
  try {
    const saved = await api(`/households/${householdId}/entries/${entry.id}`, { method: "PUT", body: JSON.stringify(updated) });
    entries = entries.map((candidate) => candidate.id === entry.id ? normalizeEntry(saved) : candidate).sort((a, b) => b.startedAt - a.startedAt);
    closeEditor();
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteEntry(id) {
  try {
    await api(`/households/${householdId}/entries/${id}`, { method: "DELETE" });
    entries = entries.filter((entry) => entry.id !== id);
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function shareHousehold() {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("household", householdId);
  const shareUrl = url.toString();
  try {
    if (navigator.share) {
      await navigator.share({ title: "Join our Nappy household", text: "Use this link to share our Nappy sleep log.", url: shareUrl });
      return;
    }
    await navigator.clipboard.writeText(shareUrl);
    showToast("Household link copied");
  } catch {
    showToast("Could not share the household link");
  }
}

async function copyHouseholdId() {
  if (!householdId) return;
  try {
    await navigator.clipboard.writeText(householdId);
    showToast("Household ID copied");
  } catch {
    showToast("Could not copy household ID");
  }
}

async function deleteHousehold() {
  if (!householdId || householdDeletionInFlight) return;
  if (!window.confirm("Delete this household and all of its entries? This cannot be undone.")) return;
  householdDeletionInFlight = true;
  render();
  try {
    await api(`/households/${householdId}`, { method: "DELETE" });
    cancelWakeNotifications();
    localStorage.removeItem(HOUSEHOLD_STORAGE_KEY);
    householdId = null;
    entries = [];
    active = null;
    timerRevision = 0;
    serverClockOffset = 0;
    selectedTab = "timer";
    const url = new URL(window.location.href);
    url.searchParams.delete("household");
    window.history.replaceState({}, "", url);
    showGate();
    showToast("Household deleted");
  } catch (error) {
    showToast(error.message);
  } finally {
    householdDeletionInFlight = false;
    if (householdId) render();
  }
}

function normalizeEntry(entry) {
  return { ...entry, startedAt: Number(entry.startedAt), endedAt: Number(entry.endedAt), duration: Number(entry.duration) };
}
function normalizeTimer(timer) {
  return {
    mode: timer.mode,
    startedAt: Number(timer.startedAt),
    accumulatedSeconds: Number(timer.accumulatedSeconds),
    lastResumedAt: timer.lastResumedAt === null ? null : Number(timer.lastResumedAt),
    isPaused: Boolean(timer.isPaused),
    serverNow: Number(timer.serverNow)
  };
}

function normalizeHouseholdId(value) {
  const id = value.toUpperCase();
  return /^[A-F0-9]{8}$/.test(id) ? id : null;
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

function sleepiesStartAt(startedAt) {
  const target = startedAt + WAKE_CUE_SECONDS * 1000;
  const fiveMinutes = 5 * 60 * 1000;
  return new Date(Math.ceil(target / fiveMinutes) * fiveMinutes);
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
