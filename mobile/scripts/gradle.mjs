// Runs the Android project's Gradle wrapper on any OS (gradlew.bat on
// Windows, ./gradlew elsewhere), so the apk:* npm scripts are portable.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The wrapper command for a platform. '.\\' on Windows as well as './'
 * elsewhere: Windows skips the current directory when looking up a bare
 * command name if NoDefaultCurrentDirectoryInExePath is set, and Node refuses
 * to spawn a .bat file without a shell.
 */
export function wrapperCommand(platform) {
  const windows = platform === 'win32';
  return { command: windows ? '.\\gradlew.bat' : './gradlew', shell: windows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const androidDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'android');
  const { command, shell } = wrapperCommand(process.platform);
  const result = spawnSync(command, process.argv.slice(2), { cwd: androidDir, stdio: 'inherit', shell });
  process.exit(result.status ?? 1);
}
