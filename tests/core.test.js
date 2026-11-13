import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  columnToAssignment, courseCode, deterministicEventId, effectiveStatus, eventBody, gradeEvidence,
  isStudentMembership, isUrgent, mergeAssignments, semesterLabel, semesterOf, STATUS, taskBody,
} from '../src/core.js';

const TZ = 'America/New_York';
const HOUR = 3600 * 1000;
const course = { id: '_123_1', courseId: '1268-CSE-3100-SEC001', name: 'CSE 3100: Systems Programming' };
const column = (overrides = {}) => ({
  id: '_55_1', name: 'Lab 4', grading: { type: 'Attempts', due: '2026-10-11T03:59:00.000Z' }, ...overrides,
});

test('course codes come from the name, then the course ID', () => {
  assert.equal(courseCode('CSE 3100: Systems Programming'), 'CSE 3100');
  assert.equal(courseCode('Intro', '1268-math-1131q-SEC010'), 'MATH 1131Q');
  assert.equal(courseCode('Orientation', ''), 'UNKNOWN');
});

test('semester comes from the term code, else the due date', () => {
  assert.equal(semesterLabel(semesterOf({ courseName: 'x', courseId: '1268-CSE-3100', due: '2027-02-01T00:00:00Z' }, TZ)), 'Fall 2026');
  assert.equal(semesterLabel(semesterOf({ courseName: 'Chem-1263', due: '2026-10-01T00:00:00Z' }, TZ)), 'Spring 2026');
  assert.equal(semesterLabel(semesterOf({ courseName: 'x', due: '2026-07-01T12:00:00Z' }, TZ)), 'Summer 2026');
  assert.equal(semesterLabel(semesterOf({ courseName: 'x', due: '2026-08-20T12:00:00Z' }, TZ)), 'Fall 2026');
});

test('urgency covers unsubmitted work due in less than 48 hours', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const at = (hours, extra = {}) => ({ due: new Date(now + hours * HOUR).toISOString(), status: STATUS.NOT_SUBMITTED, ...extra });
  assert.equal(isUrgent(at(1), now), true);
  assert.equal(isUrgent(at(47.9), now), true);
  assert.equal(isUrgent(at(48), now), false);
  assert.equal(isUrgent(at(-1), now), false);
  assert.equal(isUrgent(at(1, { status: STATUS.SUBMITTED }), now), false);
  assert.equal(isUrgent(at(1, { done: true }), now), false);
  assert.equal(effectiveStatus(at(-1), now), STATUS.OVERDUE);
  assert.equal(effectiveStatus(at(-1, { done: true }), now), STATUS.SUBMITTED);
});

test('grade records give submission evidence', () => {
  assert.equal(gradeEvidence(undefined), null);
  assert.equal(gradeEvidence({ status: 'NeedsGrading' }), STATUS.SUBMITTED);
  assert.equal(gradeEvidence({ status: 'Graded', score: 0 }), STATUS.SUBMITTED);
  assert.equal(gradeEvidence({ exempt: true }), STATUS.SUBMITTED);
  assert.equal(gradeEvidence({ columnId: '_55_1' }), STATUS.NOT_SUBMITTED);
});

test('only student memberships in available courses are read', () => {
  assert.equal(isStudentMembership({ courseRoleId: 'Student', course }), true);
  assert.equal(isStudentMembership({ courseRoleId: 'Instructor', course }), false);
  assert.equal(isStudentMembership({ courseRoleId: 'Student', course: { ...course, availability: { available: 'No' } } }), false);
  assert.equal(isStudentMembership({ courseRoleId: 'Student' }), false);
});

test('gradebook columns become assignments; undated or calculated ones are skipped', () => {
  const item = columnToAssignment({ column: column(), course, baseUrl: 'https://lms.uconn.edu/', evidence: STATUS.SUBMITTED });
  assert.deepEqual(item, {
    key: 'blackboard:_123_1:_55_1',
    courseId: '1268-CSE-3100-SEC001',
    courseName: 'CSE 3100: Systems Programming',
    courseCode: 'CSE 3100',
    title: 'Lab 4',
    due: '2026-10-11T03:59:00.000Z',
    url: 'https://lms.uconn.edu/ultra/courses/_123_1/outline',
    origin: 'BLACKBOARD',
    isExternal: false,
    status: STATUS.SUBMITTED,
    statusKnown: true,
  });
  assert.equal(columnToAssignment({ column: column({ grading: { type: 'Attempts' } }), course, baseUrl: 'x' }), null);
  assert.equal(columnToAssignment({ column: column({ grading: { type: 'Calculated', due: '2026-10-11T03:59:00Z' } }), course, baseUrl: 'x' }), null);
  assert.equal(columnToAssignment({ column: column({ grading: { due: 'not a date' } }), course, baseUrl: 'x' }), null);
  const external = columnToAssignment({ column: column({ name: 'McGraw-Hill Connect: Ch. 3' }), course, baseUrl: 'x' });
  assert.equal(external.origin, 'MCGRAW_CONNECT');
  assert.equal(external.statusKnown, false);
});

test('merging keeps old semesters and does not undo an observed submission', () => {
  const existing = {
    a: { key: 'a', title: 'Old', status: STATUS.SUBMITTED, firstSeen: '2026-01-01T00:00:00.000Z' },
    old: { key: 'old', title: 'Last semester', status: STATUS.SUBMITTED },
  };
  const merged = mergeAssignments(existing, [
    { key: 'a', title: 'Renamed', status: STATUS.NOT_SUBMITTED, statusKnown: false },
    { key: 'b', title: 'New', status: STATUS.NOT_SUBMITTED, statusKnown: true },
  ], '2026-10-10T00:00:00.000Z');
  assert.equal(merged.a.title, 'Renamed');
  assert.equal(merged.a.status, STATUS.SUBMITTED);
  assert.equal(merged.a.firstSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(merged.b.firstSeen, '2026-10-10T00:00:00.000Z');
  assert.ok(merged.old);
  assert.equal('statusKnown' in merged.b, false);
  // Explicit new evidence may change the status.
  const reopened = mergeAssignments(existing, [{ key: 'a', title: 'Old', status: STATUS.NOT_SUBMITTED, statusKnown: true }]);
  assert.equal(reopened.a.status, STATUS.NOT_SUBMITTED);
});

test('calendar event IDs are stable and use Google-allowed characters', async () => {
  const id = await deterministicEventId('blackboard:_123_1:_55_1');
  assert.match(id, /^husk[0-9a-v]{64}$/);
  assert.equal(id, await deterministicEventId('blackboard:_123_1:_55_1'));
  assert.notEqual(id, await deterministicEventId('blackboard:_123_1:_55_1', 'oldid'));
});

test('event runs one hour before the deadline; task due date is the local date', () => {
  const item = { ...columnToAssignment({ column: column(), course, baseUrl: 'https://lms.uconn.edu' }), status: STATUS.NOT_SUBMITTED };
  const event = eventBody(item, TZ);
  assert.equal(event.summary, '[CSE 3100] Lab 4');
  assert.equal(event.start.dateTime, '2026-10-11T02:59:00.000Z');
  assert.equal(event.end.dateTime, '2026-10-11T03:59:00.000Z');
  assert.match(event.description, /Assignment: https:\/\/lms\.uconn\.edu\/ultra\/courses\/_123_1\/outline/);
  const task = taskBody(item, TZ);
  // 11:59 PM EDT on Oct 10 is 03:59 UTC on Oct 11; the task belongs on Oct 10.
  assert.equal(task.due, '2026-10-10T00:00:00.000Z');
  assert.match(task.notes, /^Due: Sat, Oct 10, 2026, 11:59 PM EDT/);
  assert.equal(task.status, 'needsAction');
  assert.equal(taskBody({ ...item, done: true }, TZ).status, 'completed');
});
