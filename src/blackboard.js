// Reads coursework through Blackboard Learn's documented REST API, using the
// session the student already has in this browser. No passwords or Duo are
// handled here: if the session is missing, the student signs in to HuskyCT normally.

import { columnToAssignment, gradeEvidence, isStudentMembership, mapLimit, STATUS } from './core.js';

export class AuthRequired extends Error {
  constructor() {
    super('Sign in to HuskyCT in this browser, then sync again.');
    this.name = 'AuthRequired';
  }
}

export class BlackboardHttpError extends Error {
  constructor(status) {
    super(`HuskyCT request failed (HTTP ${status}).`);
    this.name = 'BlackboardHttpError';
    this.status = status;
  }
}

export function createClient(baseUrl, fetchImpl = fetch) {
  const base = baseUrl.replace(/\/+$/, '');

  async function get(path) {
    const response = await fetchImpl(base + path, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401) throw new AuthRequired();
    if (!response.ok) throw new BlackboardHttpError(response.status);
    // An expired session is redirected to an HTML sign-in page rather than a 401.
    if (!(response.headers.get('content-type') || '').includes('json')) throw new AuthRequired();
    return response.json();
  }

  async function getAll(path, maxPages = 25) {
    const results = [];
    let next = path;
    for (let page = 0; next && page < maxPages; page++) {
      const data = await get(next);
      results.push(...(data.results || []));
      next = data.paging?.nextPage || null;
    }
    return results;
  }

  return { base, get, getAll };
}

const enc = encodeURIComponent;

/** Grades keyed by column ID, or null when the student's grades cannot be read. */
async function readGrades(client, courseId, userId, columns) {
  for (const version of ['v2', 'v1']) {
    try {
      const grades = await client.getAll(`/learn/api/public/${version}/courses/${enc(courseId)}/gradebook/users/${enc(userId)}`);
      return { byColumn: new Map(grades.map((g) => [g.columnId, g])), complete: true };
    } catch (error) {
      if (error instanceof AuthRequired) throw error;
    }
  }
  // Fall back to one request per column for the columns that matter.
  const byColumn = new Map();
  let complete = true;
  await mapLimit(columns, 4, async (column) => {
    try {
      byColumn.set(column.id, await client.get(
        `/learn/api/public/v2/courses/${enc(courseId)}/gradebook/columns/${enc(column.id)}/users/${enc(userId)}`,
      ));
    } catch (error) {
      if (error instanceof AuthRequired) throw error;
      // 404: no grade record yet, i.e. nothing submitted. Anything else: unknown.
      if (!(error instanceof BlackboardHttpError && error.status === 404)) complete = false;
      else byColumn.set(column.id, null);
    }
  });
  return { byColumn, complete };
}

async function syncCourse(client, course, userId) {
  const columns = (await client.getAll(`/learn/api/public/v2/courses/${enc(course.id)}/gradebook/columns?limit=200`))
    .filter((column) => column.grading?.due);
  if (!columns.length) return { assignments: [], skipped: 0, statusUnknown: false };
  const { byColumn, complete } = await readGrades(client, course.id, userId, columns);
  const assignments = [];
  let skipped = 0;
  let statusUnknown = false;
  for (const column of columns) {
    let evidence = gradeEvidence(byColumn.get(column.id));
    // No record in a full grade listing means nothing has been submitted.
    if (evidence === null && byColumn.has(column.id)) evidence = STATUS.NOT_SUBMITTED;
    if (evidence === null && complete) evidence = STATUS.NOT_SUBMITTED;
    if (evidence === null) statusUnknown = true;
    const assignment = columnToAssignment({ column, course, baseUrl: client.base, evidence });
    if (assignment) assignments.push(assignment);
    else skipped++;
  }
  return { assignments, skipped, statusUnknown };
}

/** Import every assignment with a due date from the student's current courses. */
export async function syncBlackboard(baseUrl, fetchImpl = fetch) {
  const client = createClient(baseUrl, fetchImpl);
  let me;
  try {
    me = await client.get('/learn/api/public/v1/users/me');
  } catch (error) {
    if (error instanceof BlackboardHttpError && error.status === 403) throw new AuthRequired();
    throw error;
  }
  const memberships = await client.getAll(`/learn/api/public/v1/users/${enc(me.id)}/courses?expand=course&limit=100`);
  const courses = memberships.filter(isStudentMembership).map((m) => m.course);
  const warnings = [];
  let skipped = 0;
  const perCourse = await mapLimit(courses, 4, async (course) => {
    try {
      const result = await syncCourse(client, course, me.id);
      skipped += result.skipped;
      if (result.statusUnknown) warnings.push(`${course.name}: submission status could not be read; earlier status is kept.`);
      return result.assignments;
    } catch (error) {
      if (error instanceof AuthRequired) throw error;
      warnings.push(`${course.name}: could not read the gradebook (${error.message})`);
      return [];
    }
  });
  const assignments = perCourse.flat();
  if (courses.length && !assignments.length) {
    warnings.push('No assignments with due dates were found in your current courses.');
  }
  return { assignments, courseCount: courses.length, skipped, warnings };
}
