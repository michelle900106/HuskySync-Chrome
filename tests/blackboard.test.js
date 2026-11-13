import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuthRequired, syncBlackboard } from '../src/blackboard.js';
import { STATUS } from '../src/core.js';

const BASE = 'https://lms.example.edu';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** A fake Blackboard: routes map a path (with query) to a response factory. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = url.slice(BASE.length);
    calls.push({ path, options });
    const route = routes[path];
    return route ? route() : json({ status: 404 }, 404);
  };
  return { fetchImpl, calls };
}

const COURSES = {
  results: [
    { courseRoleId: 'Student', course: { id: '_1_1', courseId: '1268-CSE-3100', name: 'CSE 3100 Systems' } },
    { courseRoleId: 'Instructor', course: { id: '_2_1', courseId: '1268-TA-1000', name: 'TA 1000' } },
  ],
};

const COLUMNS = {
  results: [
    { id: 'c1', name: 'Lab 1', grading: { type: 'Attempts', due: '2026-10-01T03:59:00Z' } },
    { id: 'c2', name: 'Lab 2', grading: { type: 'Attempts', due: '2026-10-15T03:59:00Z' } },
    { id: 'total', name: 'Total', grading: { type: 'Calculated' } },
  ],
  paging: { nextPage: '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200&offset=3' },
};
const COLUMNS_PAGE_2 = { results: [{ id: 'c3', name: 'Quiz 1', grading: { type: 'Attempts', due: '2026-10-20T03:59:00Z' } }] };

test('imports dated columns from student courses with submission status', async () => {
  const { fetchImpl, calls } = fakeFetch({
    '/learn/api/public/v1/users/me': () => json({ id: 'u1' }),
    '/learn/api/public/v1/users/u1/courses?expand=course&limit=100': () => json(COURSES),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200': () => json(COLUMNS),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200&offset=3': () => json(COLUMNS_PAGE_2),
    '/learn/api/public/v2/courses/_1_1/gradebook/users/u1': () => json({ results: [{ columnId: 'c1', status: 'Graded', score: 9 }] }),
  });
  const result = await syncBlackboard(`${BASE}/`, fetchImpl);
  assert.equal(result.courseCount, 1);
  assert.deepEqual(result.assignments.map((a) => [a.title, a.status, a.statusKnown]), [
    ['Lab 1', STATUS.SUBMITTED, true],
    ['Lab 2', STATUS.NOT_SUBMITTED, true],
    ['Quiz 1', STATUS.NOT_SUBMITTED, true],
  ]);
  assert.deepEqual(result.warnings, []);
  assert.ok(calls.every((call) => call.options.credentials === 'include'));
  assert.ok(!calls.some((call) => call.path.includes('_2_1')), 'instructor course is not read');
});

test('falls back to per-column grades, and keeps status unknown when they are refused', async () => {
  const { fetchImpl } = fakeFetch({
    '/learn/api/public/v1/users/me': () => json({ id: 'u1' }),
    '/learn/api/public/v1/users/u1/courses?expand=course&limit=100': () => json(COURSES),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200': () => json({ results: COLUMNS.results }),
    '/learn/api/public/v2/courses/_1_1/gradebook/users/u1': () => json({}, 403),
    '/learn/api/public/v1/courses/_1_1/gradebook/users/u1': () => json({}, 403),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns/c1/users/u1': () => json({ status: 'NeedsGrading' }),
    // c2: 404 (default) means no grade record
  });
  const result = await syncBlackboard(BASE, fetchImpl);
  assert.deepEqual(result.assignments.map((a) => [a.title, a.status, a.statusKnown]), [
    ['Lab 1', STATUS.SUBMITTED, true],
    ['Lab 2', STATUS.NOT_SUBMITTED, true],
  ]);

  const refused = fakeFetch({
    '/learn/api/public/v1/users/me': () => json({ id: 'u1' }),
    '/learn/api/public/v1/users/u1/courses?expand=course&limit=100': () => json(COURSES),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200': () => json({ results: COLUMNS.results }),
    '/learn/api/public/v2/courses/_1_1/gradebook/users/u1': () => json({}, 403),
    '/learn/api/public/v1/courses/_1_1/gradebook/users/u1': () => json({}, 403),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns/c1/users/u1': () => json({}, 403),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns/c2/users/u1': () => json({}, 403),
  });
  const unknown = await syncBlackboard(BASE, refused.fetchImpl);
  assert.ok(unknown.assignments.every((a) => a.statusKnown === false));
  assert.equal(unknown.warnings.length, 1);
});

test('a missing session asks the student to sign in', async () => {
  for (const response of [
    () => json({}, 401),
    () => json({}, 403),
    () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  ]) {
    const { fetchImpl } = fakeFetch({ '/learn/api/public/v1/users/me': response });
    await assert.rejects(syncBlackboard(BASE, fetchImpl), AuthRequired);
  }
});

test('one unreadable course does not stop the others', async () => {
  const { fetchImpl } = fakeFetch({
    '/learn/api/public/v1/users/me': () => json({ id: 'u1' }),
    '/learn/api/public/v1/users/u1/courses?expand=course&limit=100': () => json({
      results: [
        { courseRoleId: 'Student', course: { id: '_1_1', name: 'CSE 3100' } },
        { courseRoleId: 'Student', course: { id: '_3_1', name: 'MATH 2210' } },
      ],
    }),
    '/learn/api/public/v2/courses/_1_1/gradebook/columns?limit=200': () => json({}, 500),
    '/learn/api/public/v2/courses/_3_1/gradebook/columns?limit=200': () => json({ results: [COLUMNS.results[0]] }),
    '/learn/api/public/v2/courses/_3_1/gradebook/users/u1': () => json({ results: [] }),
  });
  const result = await syncBlackboard(BASE, fetchImpl);
  assert.deepEqual(result.assignments.map((a) => a.courseCode), ['MATH 2210']);
  assert.match(result.warnings[0], /CSE 3100: could not read the gradebook \(HuskyCT request failed \(HTTP 500\)\.\)/);
});
