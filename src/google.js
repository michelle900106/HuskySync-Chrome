// Google Calendar and Google Tasks through chrome.identity.
// Call these from extension pages, so an interactive sign-in can appear.

import { deterministicEventId, eventBody, isUrgent, taskBody } from './core.js';
import { patchUserState } from './store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];

export class GoogleError extends Error {
  constructor(status, service = 'Google') {
    super(status === 403
      ? `${service} refused the request (HTTP 403). Make sure the ${service} API is enabled for the extension's Google Cloud project.`
      : `${service} request failed (HTTP ${status}).`);
    this.name = 'GoogleError';
    this.status = status;
  }
}

export function googleConfigured() {
  const clientId = chrome.runtime.getManifest().oauth2?.client_id || '';
  return clientId.endsWith('.apps.googleusercontent.com') && !clientId.startsWith('YOUR_');
}

async function getToken(interactive) {
  if (!googleConfigured()) {
    throw new Error('Google sign-in is not set up in this build: add an OAuth client ID to manifest.json (see README.md).');
  }
  const result = await chrome.identity.getAuthToken({ interactive, scopes: SCOPES });
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) throw new Error('Google sign-in was cancelled.');
  return token;
}

/** True when a Google token is available without showing a sign-in window. */
export async function googleConnected() {
  try {
    await getToken(false);
    return true;
  } catch {
    return false;
  }
}

export async function connectGoogle() {
  await getToken(true);
}

async function request(url, { method = 'GET', body, service } = {}, retried = false) {
  const token = await getToken(true);
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !retried) {
    // Expired or revoked: drop the cached token and try once more.
    await chrome.identity.removeCachedAuthToken({ token });
    return request(url, { method, body, service }, true);
  }
  if (!response.ok) throw new GoogleError(response.status, service);
  return response.status === 204 ? null : response.json();
}

const calendarUrl = (settings, eventId = '') =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(settings.calendarId)}/events`
  + (eventId ? `/${encodeURIComponent(eventId)}` : '');

const CALENDAR = 'Google Calendar';
const TASKS = 'Google Tasks';
// Both the Python app and the extension end their notes with this line, so items
// either one created can be recognized and reused instead of duplicated.
const MARK = 'Managed by HuskySync.';
const DAY = 24 * 3600 * 1000;
const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function linkedIds(field) {
  const { userState = {} } = await chrome.storage.local.get('userState');
  return new Set(Object.values(userState).map((state) => state[field]).filter(Boolean));
}

/** A HuskySync event for this assignment that no other assignment is linked to. */
async function findExistingEvent(settings, body) {
  const end = Date.parse(body.end.dateTime);
  const url = new URL(calendarUrl(settings));
  url.searchParams.set('q', body.summary);
  url.searchParams.set('timeMin', new Date(end - 3 * DAY).toISOString());
  url.searchParams.set('timeMax', new Date(end + 3 * DAY).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('maxResults', '50');
  const data = await request(url.href, { service: CALENDAR });
  const linked = await linkedIds('eventId');
  const candidates = (data?.items || []).filter((event) => event.status !== 'cancelled'
    && norm(event.summary) === norm(body.summary)
    && (event.description || '').includes(MARK)
    && !linked.has(event.id));
  return candidates.find((event) => Date.parse(event.end?.dateTime) === end)
    || (candidates.length === 1 ? candidates[0] : null);
}

const tasksUrl = (list) => `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list)}/tasks`;
const taskDay = (task) => (task.due || '').slice(0, 10);

/** Every HuskySync task in the list, including completed and hidden ones. */
async function listHuskySyncTasks(tasklistId) {
  const tasks = [];
  let pageToken = '';
  do {
    const url = new URL(tasksUrl(tasklistId));
    url.searchParams.set('showCompleted', 'true');
    url.searchParams.set('showHidden', 'true');
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await request(url.href, { service: TASKS });
    tasks.push(...(data?.items || []));
    pageToken = data?.nextPageToken || '';
  } while (pageToken);
  return tasks.filter((task) => (task.notes || '').includes(MARK));
}

/** Same title and due date, not linked to another assignment; else the only same-title one. */
function matchTask(ctx, body) {
  const free = ctx.tasks.filter((task) => !ctx.linkedTasks.has(task.id) && norm(task.title) === norm(body.title));
  return free.find((task) => taskDay(task) === body.due.slice(0, 10)) || (free.length === 1 ? free[0] : null);
}

async function createOrRecover(settings, eventId, body) {
  try {
    return { event: await request(calendarUrl(settings), { method: 'POST', body: { ...body, id: eventId }, service: CALENDAR }), created: true };
  } catch (error) {
    if (!(error instanceof GoogleError) || error.status !== 409) throw error;
    // An earlier insert succeeded before its ID was saved; update that event.
    const event = await request(calendarUrl(settings, eventId), { method: 'PUT', body, service: CALENDAR });
    return { event, created: false };
  }
}

/** Create or update the assignment's calendar event and remember its ID. */
export async function syncEvent(assignment, settings) {
  const body = eventBody(assignment, settings.timezone);
  let result;
  if (assignment.eventId) {
    try {
      result = {
        event: await request(calendarUrl(settings, assignment.eventId), { method: 'PUT', body, service: CALENDAR }),
        created: false,
      };
    } catch (error) {
      if (!(error instanceof GoogleError) || ![404, 410].includes(error.status)) throw error;
      result = await createOrRecover(settings, await deterministicEventId(assignment.key, assignment.eventId), body);
    }
  } else {
    const existing = await findExistingEvent(settings, body);
    result = existing
      ? { event: await request(calendarUrl(settings, existing.id), { method: 'PUT', body, service: CALENDAR }), created: false }
      : await createOrRecover(settings, await deterministicEventId(assignment.key), body);
  }
  if (!result.event?.id) throw new Error('Google Calendar returned an event without an ID.');
  await patchUserState(assignment.key, { eventId: result.event.id });
  return { created: result.created, htmlLink: result.event.htmlLink };
}

/** Create or update the assignment's Google Task and remember its ID. */
export async function syncTask(assignment, settings, ctx = {}) {
  const body = taskBody(assignment, settings.timezone);
  const taskUrl = (list, id) => `${tasksUrl(list)}/${encodeURIComponent(id)}`;
  if (assignment.taskId) {
    try {
      await request(taskUrl(assignment.tasklistId, assignment.taskId), { method: 'PATCH', body, service: TASKS });
      return { created: false };
    } catch (error) {
      if (!(error instanceof GoogleError) || ![404, 410].includes(error.status)) throw error;
    }
  }
  // List the task list once per batch, then reuse a task made earlier (e.g. by the Python app).
  if (!ctx.tasks) {
    ctx.tasks = await listHuskySyncTasks(settings.tasklistId);
    ctx.linkedTasks = await linkedIds('taskId');
  }
  const existing = matchTask(ctx, body);
  let task;
  if (existing) {
    task = await request(taskUrl(settings.tasklistId, existing.id), { method: 'PATCH', body, service: TASKS });
  } else {
    task = await request(tasksUrl(settings.tasklistId), { method: 'POST', body, service: TASKS });
    if (task?.id) ctx.tasks.push(task);
  }
  if (!task?.id) throw new Error('Google Tasks returned a task without an ID.');
  ctx.linkedTasks.add(task.id);
  await patchUserState(assignment.key, { taskId: task.id, tasklistId: settings.tasklistId });
  return { created: !existing };
}

/**
 * Extra copies of HuskySync tasks: same title and due date. One per group is
 * kept, preferring the one an assignment is linked to.
 */
export async function findDuplicateTasks(settings) {
  const linked = await linkedIds('taskId');
  const groups = new Map();
  for (const task of await listHuskySyncTasks(settings.tasklistId)) {
    const key = `${norm(task.title)}|${taskDay(task)}`;
    groups.set(key, [...(groups.get(key) || []), task]);
  }
  const extras = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keep = group.find((task) => linked.has(task.id)) || group[0];
    extras.push(...group.filter((task) => task !== keep && !linked.has(task.id)));
  }
  return extras;
}

export async function deleteTasks(tasks, settings) {
  let deleted = 0;
  for (const task of tasks) {
    await request(`${tasksUrl(settings.tasklistId)}/${encodeURIComponent(task.id)}`, { method: 'DELETE', service: TASKS });
    deleted++;
  }
  return deleted;
}

/** Run one sync per assignment; one failure does not stop the rest. */
export async function syncMany(assignments, settings, fn) {
  const result = { synced: 0, failures: [] };
  const ctx = {};
  for (const assignment of assignments) {
    try {
      await fn(assignment, settings, ctx);
      result.synced++;
    } catch (error) {
      result.failures.push({ assignment, error: error.message });
    }
  }
  return result;
}

export const urgentUnsynced = (items, now = Date.now()) => items.filter((a) => isUrgent(a, now) && !a.eventId);
