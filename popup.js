import { effectiveStatus, formatDue, STATUS } from './src/core.js';
import { getState } from './src/store.js';
import { h, relativeDue, safeHref, sendSync, STATUS_LABELS, timeAgo } from './src/ui.js';

const WEEK = 7 * 24 * 3600 * 1000;

async function render() {
  const { items, lastSync, settings } = await getState();
  const now = Date.now();

  document.getElementById('status').textContent = lastSync
    ? `Last sync ${timeAgo(lastSync.at)}${lastSync.ok ? ` · ${lastSync.message}` : ''}`
    : 'Not synced yet.';

  const notice = document.getElementById('notice');
  notice.replaceChildren();
  if (lastSync && !lastSync.ok) {
    notice.append(h('div', { className: 'notice error small' },
      lastSync.message, ' ',
      lastSync.needsLogin ? h('a', { href: `${settings.baseUrl}/ultra/stream`, target: '_blank' }, 'Open HuskyCT') : null));
  }

  const upcoming = items.filter((a) => {
    const due = Date.parse(a.due);
    return effectiveStatus(a, now) !== STATUS.SUBMITTED && due >= now && due < now + WEEK;
  });
  const overdue = items.filter((a) => effectiveStatus(a, now) === STATUS.OVERDUE && Date.parse(a.due) > now - WEEK);

  const list = document.getElementById('list');
  list.replaceChildren();
  if (!items.length) {
    list.append(h('div', { className: 'muted small' }, 'No coursework yet. Sign in to HuskyCT in this browser, then press Sync now.'));
    return;
  }
  if (overdue.length) {
    list.append(h('div', { className: 'notice error small' }, `${overdue.length} assignment(s) overdue this week.`));
  }
  if (!upcoming.length) {
    list.append(h('div', { className: 'notice ok small' }, 'Nothing due in the next 7 days.'));
  }
  for (const a of upcoming) {
    const href = safeHref(a.url);
    list.append(h('div', { className: 'popup-item' },
      h('div', { className: 't' }, `[${a.courseCode}] `, href ? h('a', { href, target: '_blank' }, a.title) : a.title),
      h('div', { className: 'small muted' },
        `${formatDue(a.due, settings.timezone)} · ${relativeDue(a.due, now)} `,
        h('span', { className: `pill ${effectiveStatus(a, now)}` }, STATUS_LABELS[effectiveStatus(a, now)]))));
  }
}

document.getElementById('sync').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Syncing…';
  await sendSync();
  button.disabled = false;
  button.textContent = 'Sync now';
  render();
});

document.getElementById('dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

document.getElementById('settings').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();
