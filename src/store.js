// chrome.storage.local layout:
//   settings     user options (see DEFAULT_SETTINGS)
//   assignments  { key: assignment } written only by the background sync
//   userState    { key: { eventId, taskId, tasklistId, done } } written only by extension pages
//   lastSync     { at, ok, needsLogin, message, warnings, count }
// Keeping imports and user actions in separate keys means a background sync
// can never overwrite a calendar link saved from the dashboard at the same time.

import { assignmentView, DEFAULT_SETTINGS } from './core.js';

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings } });
}

export async function getState() {
  const data = await chrome.storage.local.get(['assignments', 'userState', 'lastSync', 'settings']);
  const assignments = data.assignments || {};
  const userState = data.userState || {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...data.settings },
    lastSync: data.lastSync || null,
    assignments,
    userState,
    items: assignmentView(assignments, userState),
  };
}

export async function patchUserState(key, patch) {
  const { userState = {} } = await chrome.storage.local.get('userState');
  userState[key] = { ...userState[key], ...patch };
  await chrome.storage.local.set({ userState });
}
