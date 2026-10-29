// The app's public identity is set in four files that nothing ties together:
// capacitor.config.js, app/build.gradle, strings.xml and the shell's own
// offline/index pages. A drift between them ships an APK whose Play Store ID,
// launcher name and screens disagree -- and applicationId can never change
// once published. These tests pin them to each other.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const config = require('../capacitor.config.js');

test('the Play Store ID is the same in capacitor.config.js and build.gradle', () => {
  assert.equal(config.appId, 'com.barbell.gymapp');
  const gradle = read('android', 'app', 'build.gradle');
  assert.match(gradle, /applicationId\s+"com\.barbell\.gymapp"/);
});

test('the launcher name matches the configured app name', () => {
  assert.equal(config.appName, 'Barbell');
  const strings = read('android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  assert.match(strings, /<string name="app_name">Barbell<\/string>/);
  assert.match(strings, /<string name="title_activity_main">Barbell<\/string>/);
});

test('no user-visible text in the shell pages still says GymOS', () => {
  // Comments and the server-URL placeholder are internal; titles, headings and
  // messages are what a person sees.
  const visible = (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/__GYMOS_SERVER_URL__/g, '');
  assert.doesNotMatch(visible(read('src', 'offline.html')), /GymOS/);
  assert.match(read('scripts', 'build-www.mjs'), /<title>Barbell<\/title>/);
});

test('the Gradle wrapper is invoked with an explicit path on every platform', async () => {
  const { wrapperCommand } = await import('../scripts/gradle.mjs');
  assert.deepEqual(wrapperCommand('win32'), { command: '.\\gradlew.bat', shell: true });
  assert.deepEqual(wrapperCommand('linux'), { command: './gradlew', shell: false });
  assert.deepEqual(wrapperCommand('darwin'), { command: './gradlew', shell: false });
});
