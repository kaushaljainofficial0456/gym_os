// Runs the Android project's Gradle wrapper on any OS (gradlew.bat on
// Windows, ./gradlew elsewhere), so the apk:* npm scripts are portable.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'android');
const windows = process.platform === 'win32';
const result = spawnSync(windows ? 'gradlew.bat' : './gradlew', process.argv.slice(2), {
  cwd: androidDir,
  stdio: 'inherit',
  // Node refuses to spawn a .bat file without a shell.
  shell: windows,
});
process.exit(result.status ?? 1);
