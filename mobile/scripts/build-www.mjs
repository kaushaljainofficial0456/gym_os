// Builds mobile/www: the Android shell's OWN local files -- never the web app,
// which the APK loads live from server.url (see capacitor.config.js).
//
//   offline.html    shown when the GymOS origin cannot be reached
//   gymos-shell.js  injected by MainActivity into the GymOS origin
//   index.html      required by `cap sync`; never displayed, because the
//                   WebView starts at server.url
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontendPublic = join(mobileDir, '..', 'frontend', 'public');
const config = createRequire(import.meta.url)(join(mobileDir, 'capacitor.config.js'));
const www = join(mobileDir, config.webDir);
const serverUrl = JSON.stringify(config.server.url);

await rm(www, { recursive: true, force: true });
await mkdir(join(www, 'fonts'), { recursive: true });

const offline = await readFile(join(mobileDir, 'src', 'offline.html'), 'utf8');
if (!offline.includes('__GYMOS_SERVER_URL__')) {
  throw new Error('src/offline.html is missing its __GYMOS_SERVER_URL__ placeholder');
}
await writeFile(join(www, 'offline.html'), offline.replaceAll('__GYMOS_SERVER_URL__', serverUrl));
await copyFile(join(mobileDir, 'src', 'shell.js'), join(www, 'gymos-shell.js'));
await copyFile(join(mobileDir, 'src', 'logo.png'), join(www, 'logo.png'));
// The web app's own self-hosted face, so the offline screen is set in GymOS
// type even though it has no network to fetch anything from.
await copyFile(join(frontendPublic, 'fonts', 'dmsans-var-latin.woff2'), join(www, 'fonts', 'dmsans-var-latin.woff2'));
await writeFile(join(www, 'index.html'), `<!doctype html>\n<meta charset="utf-8">\n<title>GymOS</title>\n<script>location.replace(${serverUrl});</script>\n`);

console.log(`www built for ${config.server.url}`);
