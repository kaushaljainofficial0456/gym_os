// ============================================================
// /uploads path validation (index.js's uploadPathSegments).
//
// The private-uploads route checks ownership against one path segment
// (the client id) and then serves the RESOLVED path. Express hands `..`
// through unchanged (verified: GET /uploads/photos/A/../B/x.jpg arrives as
// req.path '/photos/A/../B/x.jpg'), so without this check a client could
// pass the ownership test with their own id and be served another
// client's file. Every segment must now be a plain name.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadPathSegments } from '../src/index.js';

test('ordinary upload paths are accepted unchanged', () => {
  assert.deepEqual(uploadPathSegments('/photos/c_123/p_9.jpg'), ['photos', 'c_123', 'p_9.jpg']);
  assert.deepEqual(uploadPathSegments('/tmp/c_123/f_1.webp'), ['tmp', 'c_123', 'f_1.webp']);
  assert.deepEqual(uploadPathSegments('/c_123/avatar.png'), ['c_123', 'avatar.png']);
  assert.deepEqual(uploadPathSegments('/photos/c_1/my%20photo.jpg'), ['photos', 'c_1', 'my%20photo.jpg']);
});

test('dot-dot traversal into another client\'s directory is refused', () => {
  assert.equal(uploadPathSegments('/photos/mine/../theirs/x.jpg'), null);
  assert.equal(uploadPathSegments('/photos/mine/%2e%2e/theirs/x.jpg'), null, 'percent-encoded ..');
  assert.equal(uploadPathSegments('/photos/mine/%2E%2E/theirs/x.jpg'), null, 'upper-case encoding');
  assert.equal(uploadPathSegments('/photos/mine/./x.jpg'), null);
});

test('separators hidden inside a segment are refused', () => {
  assert.equal(uploadPathSegments('/photos/mine/..%2ftheirs%2fx.jpg'), null, 'encoded slash');
  assert.equal(uploadPathSegments('/photos/mine/..\\theirs\\x.jpg'), null, 'backslash (a separator on Windows)');
  assert.equal(uploadPathSegments('/photos/mine/x%5c..%5ctheirs'), null, 'encoded backslash');
});

test('empty segments, NUL bytes, malformed escapes and empty paths are refused', () => {
  assert.equal(uploadPathSegments('/photos//theirs/x.jpg'), null);
  assert.equal(uploadPathSegments('/photos/mine/x%00.jpg'), null);
  assert.equal(uploadPathSegments('/photos/mine/%E0%A4%A'), null);
  assert.equal(uploadPathSegments('/'), null);
  assert.equal(uploadPathSegments(''), null);
});
