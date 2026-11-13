import {
  effectiveStatus, formatDue, isUrgent, semesterForDate, semesterLabel, semesterOf, STATUS,
} from './src/core.js';
import {
  connectGoogle, deleteTasks, findDuplicateTasks, googleConfigured, googleConnected, syncEvent, syncMany, syncTask,
  urgentUnsynced,
} from './src/google.js';
import { getState, patchUserState } from './src/store.js';
import { h, relativeDue, safeHref, sendSync, STATUS_LABELS, timeAgo } from './src/ui.js';

const $ = (id) => document.getElementById(id);
const ALL = '__all__';

const view = {
  semester: null, // null until the first render picks the current semester
  course: ALL,
  status: STATUS.NOT_SUBMITTED,
  preset: 'open',
  selected: null, // Set of keys chosen for Google Tasks; null = apply preset
  busy: false,
};
let state = null;

function message(kind, text) {
  $('messages').append(h('div', { className: `notice ${kind}` }, text));
}

function clearMessages() {
  $('messages').replaceChildren();
}

async function withBusy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  view.busy = true;
  try {
    return await work();
  } finally {
    view.busy = false;
    button.disabled = false;
    button.textContent = original;
  }
}

function reportBatch(result, what) {
  if (result.synced) message('ok', `${what}: synced ${result.synced} assignment(s).`);
  const counts = new Map();
  for (const failure of result.failures) counts.set(failure.error, (counts.get(failure.error) || 0) + 1);
  for (const [error, count] of counts) message('error', `${count} assignment(s) not synced: ${error}`);
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

function filtered(items) {
  const tz = state.settings.timezone;
  const now = Date.now();
  return items.filter((a) =>
    (view.semester === ALL || semesterLabel(semesterOf(a, tz)) === view.semester)
    && (view.course === ALL || a.courseCode === view.course)
    && (view.status === ALL || effectiveStatus(a, now) === view.status));
}

function renderFilters() {
  const tz = state.settings.timezone;
  const semesters = [...new Map(state.items.map((a) => {
    const s = semesterOf(a, tz);
    return [semesterLabel(s), s];
  }))].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).map(([label]) => label);
  if (view.semester === null) {
    const current = semesterLabel(semesterForDate(new Date(), tz));
    view.semester = semesters.includes(current) ? current : ALL;
  }
  fillSelect($('f-semester'), [...semesters.map((s) => [s, s]), [ALL, 'All semesters']], view.semester);
  const inSemester = state.items.filter((a) => view.semester === ALL || semesterLabel(semesterOf(a, tz)) === view.semester);
  const courses = [...new Set(inSemester.map((a) => a.courseCode))].sort();
  if (view.course !== ALL && !courses.includes(view.course)) view.course = ALL;
  fillSelect($('f-course'), [[ALL, 'All courses'], ...courses.map((c) => [c, c])], view.course);
  fillSelect($('f-status'), [[ALL, 'All statuses'], ...Object.entries(STATUS_LABELS)], view.status);
}

function calendarButton(a, className = 'small') {
  return h('button', {
    className,
    onclick: (event) => withBusy(event.currentTarget, 'Saving…', async () => {
      clearMessages();
      try {
        const result = await syncEvent(a, state.settings);
        message('ok', `[${a.courseCode}] ${a.title}: calendar event ${result.created ? 'created' : 'updated'}.`);
      } catch (error) {
        message('error', `Calendar sync failed: ${error.message}`);
      }
    }).then(render),
  }, a.eventId ? 'Update Calendar' : 'Add to Calendar');
}

function renderAlerts(items) {
  const now = Date.now();
  const urgent = items.filter((a) => isUrgent(a, now));
  const overdue = items.filter((a) => effectiveStatus(a, now) === STATUS.OVERDUE);
  const box = $('alerts');
  box.replaceChildren();
  $('sync-urgent').disabled = !urgentUnsynced(items, now).length;
  if (!state.items.length) {
    box.append(h('p', { className: 'muted' }, 'No coursework yet. Sign in to HuskyCT in this browser, then press Sync HuskyCT.'));
    return;
  }
  if (!urgent.length) box.append(h('div', { className: 'notice ok' }, 'No unsubmitted assignments due in the next 48 hours.'));
  const list = h('div', { className: 'urgent-list' });
  for (const a of urgent) {
    const href = safeHref(a.url);
    list.append(h('div', { className: 'urgent-item' },
      h('div', {},
        h('div', {}, h('strong', {}, `[${a.courseCode}] ${a.title}`)),
        h('div', { className: 'small muted' }, `${formatDue(a.due, state.settings.timezone)} · ${relativeDue(a.due, now)}`,
          a.isExternal ? ' · External publisher: check submission in Connect' : '')),
      h('div', { className: 'row' },
        href ? h('a', { href, target: '_blank', className: 'small' }, 'Open') : null,
        calendarButton(a))));
  }
  box.append(list);
  if (overdue.length) {
    box.append(h('div', { className: 'notice error', style: 'margin-top:8px' },
      `${overdue.length} assignment(s) are past due with no recorded submission.`));
  }
}

function defaultSelection(items) {
  const now = Date.now();
  if (view.preset === 'all') return new Set(items.map((a) => a.key));
  if (view.preset === 'none') return new Set();
  return new Set(items.filter((a) => effectiveStatus(a, now) !== STATUS.SUBMITTED).map((a) => a.key));
}

function renderTable(items) {
  const now = Date.now();
  const tz = state.settings.timezone;
  if (view.selected === null) view.selected = defaultSelection(items);
  const table = $('table');
  table.replaceChildren();
  if (!items.length) {
    table.append(h('tr', {}, h('td', { className: 'muted' }, 'No assignments match these filters.')));
    $('sync-tasks').disabled = true;
    return;
  }
  table.append(h('thead', {}, h('tr', {},
    h('th', { title: 'Send to Google Tasks' }, 'Tasks'),
    h('th', {}, 'Course'), h('th', {}, 'Assignment'), h('th', {}, 'Due'), h('th', {}, 'Status'),
    h('th', {}, 'Calendar'), h('th', { className: 'hide-sm' }, 'Google Tasks'), h('th', {}, 'Done'))));
  const body = h('tbody');
  for (const a of items) {
    const status = effectiveStatus(a, now);
    const href = safeHref(a.url);
    body.append(h('tr', { className: status === STATUS.SUBMITTED ? 'done' : '' },
      h('td', {}, h('input', {
        type: 'checkbox',
        checked: view.selected.has(a.key),
        'aria-label': `Send ${a.title} to Google Tasks`,
        onchange: (event) => {
          if (event.target.checked) view.selected.add(a.key);
          else view.selected.delete(a.key);
          updateTaskButton(items);
        },
      })),
      h('td', { className: 'nowrap', title: a.courseName }, a.courseCode),
      h('td', { className: 'title' }, href ? h('a', { href, target: '_blank' }, a.title) : a.title,
        a.isExternal ? h('div', { className: 'small muted' }, 'External publisher') : null),
      h('td', { className: 'nowrap' }, formatDue(a.due, tz), h('div', { className: 'small muted' }, relativeDue(a.due, now))),
      h('td', {}, h('span', { className: `pill ${status}` }, STATUS_LABELS[status])),
      h('td', {}, calendarButton(a)),
      h('td', { className: 'small muted hide-sm' }, a.taskId ? 'Synced' : 'Not synced'),
      h('td', {}, h('input', {
        type: 'checkbox',
        checked: Boolean(a.done),
        title: 'Mark as done (for work finished outside HuskyCT)',
        'aria-label': `Mark ${a.title} as done`,
        onchange: (event) => patchUserState(a.key, { done: event.target.checked }),
      }))));
  }
  table.append(body);
  updateTaskButton(items);
}

function updateTaskButton(items) {
  const count = items.filter((a) => view.selected.has(a.key)).length;
  $('sync-tasks').textContent = `Sync ${count} selected to Google Tasks`;
  $('sync-tasks').disabled = !count;
}

function renderStatus() {
  const { lastSync } = state;
  $('sync-status').textContent = lastSync ? `Last sync ${timeAgo(lastSync.at)}` : 'Not synced yet';
}

function renderSyncMessages() {
  const { lastSync, settings } = state;
  if (!lastSync) return;
  if (!lastSync.ok) {
    $('messages').append(h('div', { className: 'notice error' }, lastSync.message, ' ',
      lastSync.needsLogin ? h('a', { href: `${settings.baseUrl}/ultra/stream`, target: '_blank' }, 'Open HuskyCT to sign in') : null));
  }
  for (const warning of lastSync.warnings || []) message('warn', warning);
}

async function renderGoogle() {
  if (!googleConfigured()) {
    $('google-status').textContent = 'Not set up in this build (add an OAuth client ID; see README.md).';
    $('google-connect').disabled = true;
    return;
  }
  const connected = await googleConnected();
  $('google-status').textContent = connected ? 'Connected' : 'Not connected. Calendar and Tasks buttons will ask you to sign in.';
  $('google-connect').hidden = connected;
}

async function render() {
  if (view.busy) return;
  state = await getState();
  renderStatus();
  renderFilters();
  const items = filtered(state.items);
  renderAlerts(items);
  renderTable(items);
}

$('sync').addEventListener('click', (event) => withBusy(event.currentTarget, 'Syncing…', async () => {
  clearMessages();
  const result = await sendSync();
  state = await getState();
  if (result?.ok) message('ok', result.message);
  renderSyncMessages();
}).then(render));

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('google-connect').addEventListener('click', async () => {
  clearMessages();
  try {
    await connectGoogle();
  } catch (error) {
    message('error', `Google sign-in failed: ${error.message}`);
  }
  renderGoogle();
});

$('sync-urgent').addEventListener('click', (event) => withBusy(event.currentTarget, 'Saving…', async () => {
  clearMessages();
  reportBatch(await syncMany(urgentUnsynced(filtered(state.items)), state.settings, syncEvent), 'Google Calendar');
}).then(render));

$('sync-tasks').addEventListener('click', (event) => withBusy(event.currentTarget, 'Saving…', async () => {
  clearMessages();
  const chosen = filtered(state.items).filter((a) => view.selected.has(a.key));
  reportBatch(await syncMany(chosen, state.settings, syncTask), 'Google Tasks');
}).then(render));

$('dedupe-tasks').addEventListener('click', (event) => withBusy(event.currentTarget, 'Checking…', async () => {
  clearMessages();
  try {
    const extras = await findDuplicateTasks(state.settings);
    if (!extras.length) {
      message('ok', 'No duplicate HuskySync tasks found.');
      return;
    }
    if (!confirm(`Delete ${extras.length} duplicate HuskySync task(s) from Google Tasks? One copy of each assignment is kept.`)) return;
    message('ok', `Deleted ${await deleteTasks(extras, state.settings)} duplicate task(s).`);
  } catch (error) {
    message('error', `Could not remove duplicates: ${error.message}`);
  }
}).then(render));

for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    view.preset = button.dataset.preset;
    view.selected = null;
    render();
  });
}

for (const [id, field] of [['f-semester', 'semester'], ['f-course', 'course'], ['f-status', 'status']]) {
  $(id).addEventListener('change', (event) => {
    view[field] = event.target.value;
    view.selected = null;
    render();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.assignments || changes.userState || changes.lastSync || changes.settings)) render();
});

await render();
renderSyncMessages();
renderGoogle();
