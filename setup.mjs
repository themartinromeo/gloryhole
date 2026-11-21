import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw Error('This launcher is for Intel and Apple Silicon Macs.');
const bin = path.join(here, 'bin'); fs.mkdirSync(bin, {recursive: true});
const response = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {headers: {'User-Agent': 'Gloryhole-setup'}});
if (!response.ok) throw Error(`Could not read the official release: ${response.status}`);
const release = await response.json();
const name = `cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
const asset = release.assets.find(item => item.name === name);
if (!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/)) throw Error('No verifiable release digest was published. Installation stopped.');
if (!asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/')) throw Error('Unexpected download origin.');
console.log(`Downloading Cloudflare’s connection helper ${release.tag_name}…`);
const download = await fetch(asset.browser_download_url);
if (!download.ok) throw Error(`Download failed: ${download.status}`);
const bytes = Buffer.from(await download.arrayBuffer());
if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw Error('Download verification failed.');
const archive = path.join(bin, 'cloudflared.tgz'); fs.writeFileSync(archive, bytes);
try {
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', bin, 'cloudflared']);
  fs.chmodSync(path.join(bin, 'cloudflared'), 0o755);
  fs.writeFileSync(path.join(bin, 'release.json'), JSON.stringify({version: release.tag_name, digest: asset.digest, source: asset.browser_download_url}, null, 2));
} finally {fs.rmSync(archive, {force: true});}
console.log('Connection helper verified and ready.');
