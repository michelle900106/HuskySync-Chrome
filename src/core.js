// Pure logic shared by the service worker and extension pages.
// No chrome.* calls here, so it runs under `node --test` too.

export const STATUS = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  OVERDUE: 'OVERDUE',
});

export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: 'https://lms.uconn.edu',
  timezone: 'America/New_York',
  calendarId: 'primary',
  tasklistId: '@default',
  syncHours: 6,
});

const HOUR = 3600 * 1000;
const COURSE_CODE_RE = /\b([A-Z]{2,8})[ -]*(\d{3,4}[A-Z]?)\b/i;
const TERM_CODE_RE = /^1(\d{2})([1358])-|-1(\d{2})([1358])$/;
const TERM_SEASONS = { 1: 0, 3: 1, 5: 2, 8: 3 };
export const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Fall'];
const EXTERNAL_RE = /mc\s*graw[\s-]*hill|mheducation|smartbook|\baleks\b/i;
const NOT_STUDENT_ROLES = new Set(['Instructor', 'TeachingAssistant', 'CourseBuilder', 'Grader']);

export function courseCode(...texts) {
  for (const text of texts) {
    const match = COURSE_CODE_RE.exec(text || '');
    if (match) return `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
  }
  return 'UNKNOWN';
}

function localParts(date, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date)) parts[part.type] = part.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function localDateISO(date, timeZone) {
  const { year, month, day } = localParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function semesterForDate(date, timeZone) {
  const { year, month, day } = localParts(date, timeZone);
  if (month <= 5) return [year, 1];
  return [year, month < 8 || (month === 8 && day < 16) ? 2 : 3];
}

/** [year, season] from a HuskyCT term code in the course name or ID, else from the due date. */
export function semesterOf(assignment, timeZone) {
  for (const text of [assignment.courseName, assignment.courseId]) {
    const match = TERM_CODE_RE.exec((text || '').trim());
    if (match) {
      const [year, season] = match[1] ? [match[1], match[2]] : [match[3], match[4]];
      return [2000 + Number(year), TERM_SEASONS[season]];
    }
  }
  return semesterForDate(new Date(assignment.due), timeZone);
}

export const semesterLabel = ([year, season]) => `${SEASON_NAMES[season]} ${year}`;

export function effectiveStatus(assignment, now = Date.now()) {
  if (assignment.done || assignment.status === STATUS.SUBMITTED) return STATUS.SUBMITTED;
  return Date.parse(assignment.due) < now ? STATUS.OVERDUE : STATUS.NOT_SUBMITTED;
}

/** Unsubmitted and due from now until strictly less than 48 hours away. */
export function isUrgent(assignment, now = Date.now()) {
  const due = Date.parse(assignment.due);
  return effectiveStatus(assignment, now) !== STATUS.SUBMITTED && due >= now && due < now + 48 * HOUR;
}

export function isStudentMembership(membership) {
  return Boolean(membership.course)
    && membership.availability?.available !== 'No'
    && membership.course.availability?.available !== 'No'
    && !NOT_STUDENT_ROLES.has(membership.courseRoleId);
}

/**
 * Submission evidence from the student's own grade record.
 * Returns SUBMITTED / NOT_SUBMITTED, or null when no evidence is available.
 */
export function gradeEvidence(grade) {
  if (grade === null || grade === undefined) return null;
  if (grade.exempt) return STATUS.SUBMITTED;
  if (grade.status === 'Graded' || grade.status === 'NeedsGrading') return STATUS.SUBMITTED;
  if (grade.score !== undefined && grade.score !== null) return STATUS.SUBMITTED;
  if (grade.displayGrade && (grade.displayGrade.score != null || grade.displayGrade.text)) return STATUS.SUBMITTED;
  return STATUS.NOT_SUBMITTED;
}

/** A gradebook column with a due date becomes an assignment; anything else is skipped (null). */
export function columnToAssignment({ column, course, baseUrl, evidence = null }) {
  const due = column.grading?.due;
  if (!due || column.grading?.type === 'Calculated' || column.availability?.available === 'No') return null;
  const dueDate = new Date(due);
  const title = String(column.displayName || column.name || '').trim();
  if (Number.isNaN(dueDate.getTime()) || !title) return null;
  const isExternal = EXTERNAL_RE.test(`${title} ${column.description || ''}`);
  return {
    key: `blackboard:${course.id}:${column.id}`,
    courseId: course.courseId || '',
    courseName: course.name || course.courseId || '',
    courseCode: courseCode(course.name, course.courseId),
    title,
    due: dueDate.toISOString(),
    url: `${baseUrl.replace(/\/+$/, '')}/ultra/courses/${encodeURIComponent(course.id)}/outline`,
    origin: isExternal ? 'MCGRAW_CONNECT' : 'BLACKBOARD',
    isExternal,
    status: evidence ?? STATUS.NOT_SUBMITTED,
    statusKnown: evidence !== null,
  };
}

/**
 * Merge a fresh import into stored assignments. Nothing is deleted, so older
 * semesters stay available. A run without grade evidence cannot undo a
 * submission that an earlier run observed.
 */
export function mergeAssignments(existing, incoming, nowIso = new Date().toISOString()) {
  const merged = { ...existing };
  for (const item of incoming) {
    const previous = existing[item.key];
    const { statusKnown, ...fields } = item;
    const status = !statusKnown && previous?.status === STATUS.SUBMITTED ? STATUS.SUBMITTED : fields.status;
    merged[item.key] = { ...previous, ...fields, status, firstSeen: previous?.firstSeen ?? nowIso, lastSeen: nowIso };
  }
  return merged;
}

/** Stored assignments combined with per-user state (calendar/task links, manual done), sorted by due date. */
export function assignmentView(assignments, userState = {}) {
  return Object.values(assignments)
    .map((item) => ({ ...item, ...userState[item.key] }))
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

/** Google Calendar event IDs allow base32hex (0-9a-v); hex is a subset. */
export async function deterministicEventId(key, replaces = null) {
  const identity = replaces ? `${key}|replaces:${replaces}` : key;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return 'husk' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatDue(iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

function description(assignment) {
  return `Course: ${assignment.courseName}\n`
    + `Platform: ${assignment.origin}\n`
    + `Assignment: ${assignment.url || '(no direct link available)'}\n`
    + 'Managed by HuskySync.';
}

/** One hour before the deadline until the deadline. */
export function eventBody(assignment, timeZone) {
  const due = new Date(assignment.due);
  return {
    summary: `[${assignment.courseCode}] ${assignment.title}`,
    description: description(assignment),
    start: { dateTime: new Date(due.getTime() - HOUR).toISOString(), timeZone },
    end: { dateTime: due.toISOString(), timeZone },
    status: 'confirmed',
  };
}

/** Google Tasks keeps a due date only; the exact time goes in the notes. */
export function taskBody(assignment, timeZone) {
  const submitted = effectiveStatus(assignment) === STATUS.SUBMITTED;
  return {
    title: `[${assignment.courseCode}] ${assignment.title}`,
    notes: `Due: ${formatDue(assignment.due, timeZone)}\n${description(assignment)}`,
    due: `${localDateISO(new Date(assignment.due), timeZone)}T00:00:00.000Z`,
    status: submitted ? 'completed' : 'needsAction',
  };
}

/** Run fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
