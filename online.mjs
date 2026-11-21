import {startInbox} from './server.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(here, 'bin', 'cloudflared');
if (!fs.existsSync(binary)) {console.error('Run setup.mjs first to install the verified connection helper.'); process.exit(1);}
const app = await startInbox();
const awake = spawn('/usr/bin/caffeinate', ['-i'], {stdio: 'ignore'});
awake.on('error', () => {});
console.log(`Gloryhole is starting.\nControl panel: ${app.adminUrl}\nReceived files: ${app.folder}\nKeep this window open. Your Mac will stay awake while it runs.`);
const controlFile = path.join(app.root, '.state', 'control-panel-url.txt');
fs.writeFileSync(controlFile, app.adminUrl, {mode: 0o600});
const tunnel = spawn(binary, ['tunnel', '--no-autoupdate', '--url', app.uploadOrigin, '--protocol', 'http2'], {stdio: ['ignore', 'ignore', 'pipe']});
let buffer = '', publicUrl = '', connected = false, stopping = false;
let resolveReady;
const ready = new Promise(resolve => {resolveReady = resolve;});
const timeout = setTimeout(() => resolveReady(false), 45000);
function openPanel() {if (process.argv.includes('--open')) {const child = spawn('/usr/bin/open', [app.adminUrl], {stdio: 'ignore'}); child.on('error', () => {});}}
tunnel.stderr.on('data', chunk => {
  buffer = (buffer + chunk.toString()).slice(-24000);
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match) publicUrl = match[0];
  if (buffer.includes('Registered tunnel connection') && publicUrl && !connected) {
    connected = true; app.setPublicBase(publicUrl); clearTimeout(timeout);
    console.log(`\nOnline: ${publicUrl}\nCreate an upload link in your control panel. The bare address cannot accept files without a private link.\nThis temporary address changes on restart. Press Control-C to stop.`);
    resolveReady(true);
  }
});
tunnel.on('error', err => {console.error(`Could not start the connection helper: ${err.message}`); resolveReady(false);});
tunnel.on('exit', () => {app.setPublicBase(''); if (!stopping) console.error('Public connection stopped. The local inbox is still running; restart Gloryhole to reconnect.'); resolveReady(false);});
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timeout); tunnel.kill(); awake.kill();
  await app.close(); fs.rmSync(controlFile, {force: true}); process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
if (!await ready) console.error('No public connection is ready yet. The control panel works locally; check your internet connection or restart.');
openPanel();
