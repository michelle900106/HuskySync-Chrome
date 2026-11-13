import { getSettings, saveSettings } from './src/store.js';
import { h } from './src/ui.js';

const FIELDS = ['baseUrl', 'timezone', 'syncHours', 'calendarId', 'tasklistId'];
const $ = (id) => document.getElementById(id);

function show(kind, text) {
  $('messages').replaceChildren(h('div', { className: `notice ${kind}` }, text));
}

const settings = await getSettings();
for (const field of FIELDS) $(field).value = String(settings[field]);

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = Object.fromEntries(FIELDS.map((field) => [field, $(field).value.trim()]));
  next.syncHours = Number(next.syncHours);
  let origin;
  try {
    const url = new URL(next.baseUrl);
    if (url.protocol !== 'https:') throw new Error();
    origin = url.origin;
    next.baseUrl = origin;
  } catch {
    show('error', 'Enter an https:// Blackboard address.');
    return;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: next.timezone });
  } catch {
    show('error', `"${next.timezone}" is not a recognized time zone.`);
    return;
  }
  // Must run inside this click handler so Chrome can show its permission prompt.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    show('error', `HuskySync needs access to ${origin} to read your coursework.`);
    return;
  }
  await saveSettings(next);
  show('ok', 'Settings saved.');
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete all coursework, calendar links, and settings stored by HuskySync in this browser? Events already in Google Calendar stay there.')) return;
  await chrome.storage.local.clear();
  show('ok', 'All HuskySync data deleted.');
  for (const field of FIELDS) $(field).value = String((await getSettings())[field]);
});
