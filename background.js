// Service worker: syncs HuskyCT on a schedule and keeps the toolbar badge current.

import { isUrgent, mergeAssignments } from './src/core.js';
import { AuthRequired, syncBlackboard } from './src/blackboard.js';
import { getSettings, getState } from './src/store.js';

const SYNC_ALARM = 'huskysync-sync';
const BADGE_ALARM = 'huskysync-badge';

async function scheduleAlarms() {
  const { syncHours } = await getSettings();
  await chrome.alarms.clear(SYNC_ALARM);
  if (Number(syncHours) > 0) {
    // Also sync shortly after the browser starts.
    chrome.alarms.create(SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: Number(syncHours) * 60 });
  }
  // Urgency changes with the clock even without a new sync.
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 30 });
}

async function updateBadge() {
  const { items, lastSync } = await getState();
  const now = Date.now();
  const urgent = items.filter((item) => isUrgent(item, now)).length;
  if (lastSync && !lastSync.ok) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#868e96' });
    await chrome.action.setTitle({ title: `HuskySync: ${lastSync.message}` });
    return;
  }
  await chrome.action.setBadgeText({ text: urgent ? String(urgent) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d9480f' });
  await chrome.action.setTitle({
    title: urgent ? `HuskySync: ${urgent} due within 48 hours` : 'HuskySync',
  });
}

async function hasHostAccess(baseUrl) {
  try {
    return await chrome.permissions.contains({ origins: [`${new URL(baseUrl).origin}/*`] });
  } catch {
    return false;
  }
}

let inflight = null;

async function performSync() {
  const settings = await getSettings();
  const at = new Date().toISOString();
  let lastSync;
  if (!(await hasHostAccess(settings.baseUrl))) {
    lastSync = { at, ok: false, needsLogin: false, message: `HuskySync has no access to ${settings.baseUrl}. Grant it on the Settings page.` };
  } else {
    try {
      const result = await syncBlackboard(settings.baseUrl);
      const { assignments } = await chrome.storage.local.get('assignments');
      await chrome.storage.local.set({ assignments: mergeAssignments(assignments || {}, result.assignments, at) });
      lastSync = {
        at, ok: true, count: result.assignments.length, courses: result.courseCount,
        message: `Found ${result.assignments.length} assignment(s) in ${result.courseCount} course(s).`,
        warnings: result.warnings,
      };
    } catch (error) {
      const needsLogin = error instanceof AuthRequired;
      lastSync = { at, ok: false, needsLogin, message: needsLogin ? error.message : `Sync failed: ${error.message}` };
    }
  }
  await chrome.storage.local.set({ lastSync });
  await updateBadge();
  return lastSync;
}

function runSync() {
  inflight ??= performSync().finally(() => { inflight = null; });
  return inflight;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await scheduleAlarms();
  await updateBadge();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) runSync();
  else if (alarm.name === BADGE_ALARM) updateBadge();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) scheduleAlarms();
  if (changes.userState) updateBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'sync') {
    runSync().then(sendResponse);
    return true;
  }
  return false;
});
