import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {startInbox} from '../server.mjs';
import {TransferRate, rateLabel} from '../public/transfer-metrics.js';
import {ReportStore} from '../reports.mjs';
import {formatReport, reportFilename} from '../public/report-format.js';

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryhole-test-'));
  const config = {root, adminPort: 0, uploadPort: 0, diskReserveBytes: 0, ...options};
  const app = await startInbox(config);
  t.after(async () => {await app.close(); fs.rmSync(root, {recursive: true, force: true});});
  const login = await fetch(`${app.adminOrigin}/api/session`, {method: 'POST', headers: {Origin: app.adminOrigin, 'Content-Type': 'application/json'}, body: JSON.stringify({secret: new URL(app.adminUrl).hash.slice(5)})});
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = (endpoint, data, origin = app.adminOrigin) => fetch(`${app.adminOrigin}${endpoint}`, {method: data === undefined ? 'GET' : 'POST', headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  const create = async (data = {}) => {const response = await admin('/api/requests', data); assert.equal(response.status, 201); const record = await response.json(); return {...record, token: new URL(record.url).hash.slice(1)};};
  const sender = (token, endpoint, data, extra = {}) => fetch(`${app.uploadOrigin}${endpoint}`, {method: data === undefined ? 'GET' : 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra}, ...(data === undefined ? {} : {body: Buffer.isBuffer(data) ? data : JSON.stringify(data)})});
  return {root, app, admin, create, sender, config};
}

test('receives multi-chunk bytes, persists a SHA-256 receipt, and prevents overwrites and traversal', async t => {
  const {root, admin, create, sender} = await fixture(t);
  const link = await create({label: '<script>never executable</script>'});
  const bytes = crypto.randomBytes(200000);
  for (let iteration = 0; iteration < 2; iteration++) {
    const start = await sender(link.token, '/api/uploads', {name: '../../outside.txt', size: bytes.length});
    assert.equal(start.status, 201); const {id} = await start.json();
    for (let offset = 0; offset < bytes.length; offset += 100000) {
      const response = await sender(link.token, `/api/uploads/${id}/chunk`, bytes.subarray(offset, offset + 100000), {'Content-Type': 'application/octet-stream', 'X-Upload-Offset': String(offset)});
      assert.equal(response.status, 200);
    }
    const finish = await sender(link.token, `/api/uploads/${id}/finish`, {});
    assert.equal(finish.status, 201); const receipt = await finish.json();
    assert.equal(receipt.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  const files = fs.readdirSync(path.join(root, 'Received'));
  assert.equal(files.length, 2); assert.notEqual(files[0], files[1]);
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(root, 'Received', file)), bytes);
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
  const state = await (await admin('/api/status')).json();
  assert.equal(state.requests[0].receivedBytes, bytes.length * 2);
  assert.equal(state.requests[0].tokenHash, undefined);
  assert.equal(fs.readFileSync(path.join(root, '.state/requests.json'), 'utf8').includes(link.token), false);
  assert.equal(fs.readdirSync(path.join(root, '.partial')).length, 0);
});

test('public listener exposes neither administration nor file downloads; rejects untrusted admin origins', async t => {
  const {app, admin, create, sender} = await fixture(t);
  assert.equal((await fetch(`${app.adminOrigin}/api/status`)).status, 401);
  assert.equal((await admin('/api/requests', {}, 'https://evil.example')).status, 403);
  assert.equal((await fetch(`${app.adminOrigin}/api/session`, {method: 'POST', headers: {Origin: 'https://evil.example', 'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  assert.equal((await fetch(`${app.uploadOrigin}/admin.js`)).status, 404);
  assert.equal((await fetch(`${app.uploadOrigin}/Received/example.txt`)).status, 404);
  assert.equal((await fetch(`${app.uploadOrigin}/api/request`)).status, 410);
  const {token} = await create();
  assert.equal((await sender(token, '/api/status')).status, 404);
  assert.equal((await sender(token, '/api/requests', {})).status, 404);
  const page = await fetch(app.uploadOrigin);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
});

test('revocation cancels pending uploads and rejects future uploads; expiry is enforced', async t => {
  const {root, admin, create, sender} = await fixture(t);
  const link = await create();
  const {id} = await (await sender(link.token, '/api/uploads', {name: 'pending', size: 10})).json();
  assert.equal((await admin(`/api/requests/${link.id}/revoke`, {})).status, 200);
  assert.equal((await sender(link.token, `/api/uploads/${id}/finish`, {})).status, 410);
  assert.equal((await sender(link.token, '/api/request')).status, 410);
  assert.deepEqual(fs.readdirSync(path.join(root, '.partial')), []);
  const expired = await create({hours: 0.000001});
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal((await sender(expired.token, '/api/request')).status, 410);
});

test('reserves total limits across pending files and rejects oversized and out-of-order chunks', async t => {
  const {create, sender} = await fixture(t);
  const {token} = await create({maxGiB: 16 / 1024 ** 3, fileGiB: 12 / 1024 ** 3});
  assert.equal((await sender(token, '/api/uploads', {name: 'big', size: 13})).status, 413);
  const {id} = await (await sender(token, '/api/uploads', {name: 'one', size: 12})).json();
  assert.equal((await sender(token, '/api/uploads', {name: 'two', size: 5})).status, 413);
  assert.equal((await sender(token, `/api/uploads/${id}/finish`, {})).status, 409);
  assert.equal((await sender(token, `/api/uploads/${id}/chunk`, Buffer.from('wrong'), {'X-Upload-Offset': '1'})).status, 409);
  assert.equal((await sender(token, `/api/uploads/${id}/chunk`, Buffer.alloc(13), {'X-Upload-Offset': '0'})).status, 413);
  assert.equal((await sender(token, `/api/uploads/${id}/cancel`, {})).status, 200);
  assert.equal((await sender(token, '/api/uploads', {name: 'two', size: 5})).status, 201);
});

test('empty files work and other links cannot manipulate another request’s upload', async t => {
  const {root, create, sender} = await fixture(t);
  const first = await create(), second = await create();
  const {id} = await (await sender(first.token, '/api/uploads', {name: 'empty.txt', size: 0})).json();
  assert.equal((await sender(second.token, `/api/uploads/${id}/finish`, {})).status, 404);
  assert.equal((await sender(first.token, `/api/uploads/${id}/finish`, {})).status, 201);
  assert.equal(fs.statSync(path.join(root, 'Received', fs.readdirSync(path.join(root, 'Received'))[0])).size, 0);
});

test('single-instance lock prevents a second receiver deleting partial files', async t => {
  const {root, config, create, sender} = await fixture(t);
  const {token} = await create();
  await sender(token, '/api/uploads', {name: 'partial', size: 8});
  await assert.rejects(startInbox(config), /already running/);
  assert.equal(fs.readdirSync(path.join(root, '.partial')).length, 1);
});

test('request state and quotas survive a restart', async t => {
  const {app, config, create} = await fixture(t);
  const {token} = await create();
  await app.close();
  const restarted = await startInbox(config); t.after(() => restarted.close());
  assert.equal((await fetch(`${restarted.uploadOrigin}/api/request`, {headers: {Authorization: `Bearer ${token}`}})).status, 200);
});

test('closing a link aborts a chunk in flight and cleans up its partial file', async t => {
  const {root, app, admin, create, sender} = await fixture(t);
  const link = await create();
  const {id} = await (await sender(link.token, '/api/uploads', {name: 'interrupted', size: 100})).json();
  const request = http.request(`${app.uploadOrigin}/api/uploads/${id}/chunk`, {method: 'POST', headers: {Authorization: `Bearer ${link.token}`, 'Content-Length': '100', 'X-Upload-Offset': '0'}}, response => response.resume());
  const closed = new Promise(resolve => {request.on('error', () => {}); request.on('close', resolve);});
  request.write(Buffer.alloc(50));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await admin(`/api/requests/${link.id}/revoke`, {})).status, 200);
  await closed;
  for (let i = 0; i < 20 && fs.readdirSync(path.join(root, '.partial')).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.readdirSync(path.join(root, '.partial')).length, 0);
  assert.equal(fs.readdirSync(path.join(root, 'Received')).length, 0);
});

test('destination settings persist and completed files go only to the selected folder', async t => {
  const {root, app, config, admin, create, sender} = await fixture(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gloryhole-destination-')));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  assert.equal((await admin('/api/destination', {folder})).status, 200);
  const {token} = await create();
  const {id} = await (await sender(token, '/api/uploads', {name: 'on-destination.txt', size: 4})).json();
  assert.equal((await admin('/api/destination', {folder: path.join(root, 'Received')})).status, 409);
  await sender(token, `/api/uploads/${id}/chunk`, Buffer.from('film'), {'X-Upload-Offset': '0'});
  assert.equal((await sender(token, `/api/uploads/${id}/finish`, {})).status, 201);
  assert.equal(fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'utf8'), 'film');
  assert.deepEqual(fs.readdirSync(path.join(root, 'Received')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.state/requests.json'))).receipts[0].folder, folder);
  await app.close();
  const restarted = await startInbox(config); t.after(() => restarted.close());
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.state/requests.json'))).destination, folder);
  const next = await fetch(`${restarted.uploadOrigin}/api/uploads`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({name: 'next', size: 0})});
  assert.equal(next.status, 201);
});

test('missing destinations are rejected, never recreated, and never fall back to the local inbox', async t => {
  const {root, admin, create, sender} = await fixture(t);
  const missing = path.join(root, 'missing');
  assert.equal((await admin('/api/destination', {folder: missing})).status, 400);
  assert.equal(fs.existsSync(missing), false);
  assert.equal((await admin('/api/destination', {folder: 'relative'})).status, 400);
  const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
  assert.equal((await admin('/api/destination', {folder})).status, 200);
  const {token} = await create();
  const {id} = await (await sender(token, '/api/uploads', {name: 'do-not-fallback', size: 0})).json();
  fs.rmdirSync(folder);
  assert.equal((await sender(token, `/api/uploads/${id}/finish`, {})).status, 400);
  assert.equal((await sender(token, '/api/uploads', {name: 'new', size: 1})).status, 400);
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'Received')), []);
});

test('receiver status includes live byte counts and destination paths stay private', async t => {
  const {admin, create, sender} = await fixture(t);
  const {token} = await create();
  const {id} = await (await sender(token, '/api/uploads', {name: 'live-footage', size: 100})).json();
  await sender(token, `/api/uploads/${id}/chunk`, Buffer.alloc(50), {'X-Upload-Offset': '0'});
  const status = await (await admin('/api/status')).json();
  assert.equal(status.transfers[0].bytes, 50);
  assert.equal(status.transfers[0].total, 100);
  assert.ok(status.transfers[0].bytesPerSecond > 0);
  const publicInfo = await (await sender(token, '/api/request')).json();
  assert.equal(publicInfo.folder, undefined);
  assert.equal(publicInfo.transfers, undefined);
});

test('transfer rates measure bytes per second, settle to zero when stalled, and recover after rollback', () => {
  const meter = new TransferRate(0);
  meter.sample(1e6, 1000); assert.equal(meter.rate(1000), 1e6);
  meter.sample(2e6, 2000); assert.equal(meter.rate(2000), 1e6);
  assert.equal(meter.rate(6000), 0);
  meter.sample(0, 7000); meter.sample(1e6, 8000); assert.equal(meter.rate(8000), 1e6);
  assert.equal(rateLabel(12500000), '12.5 MB/s');
});

test('new share links use compact 128-bit secrets without a query-style fragment', async t => {
  const {create, sender} = await fixture(t);
  const one = await create(), two = await create();
  assert.match(new URL(one.url).hash, /^#[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(one.token, 'base64url').length, 16);
  assert.notEqual(one.token, two.token);
  assert.equal((await sender(one.token, '/api/request')).status, 200);
  assert.equal((await sender('A'.repeat(22), '/api/request')).status, 410);
});

test('legacy 43-character upload tokens remain valid after upgrading', async t => {
  const {root, app, config, create} = await fixture(t);
  await create(); await app.close();
  const oldToken = crypto.randomBytes(32).toString('base64url');
  const file = path.join(root, '.state/requests.json');
  const state = JSON.parse(fs.readFileSync(file));
  state.requests[0].tokenHash = crypto.createHash('sha256').update(oldToken).digest('hex');
  fs.writeFileSync(file, JSON.stringify(state));
  const restarted = await startInbox(config); t.after(() => restarted.close());
  assert.equal((await fetch(`${restarted.uploadOrigin}/api/request`, {headers: {Authorization: `Bearer ${oldToken}`}})).status, 200);
});

test('folder picker saves the selected folder; cancellation preserves the destination', async t => {
  const selected = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gloryhole-picker-')));
  t.after(() => fs.rmSync(selected, {recursive: true, force: true}));
  let selection = selected;
  const {root, admin} = await fixture(t, {chooseDirectory: async () => selection});
  const picked = await admin('/api/destination/pick', {});
  assert.equal(picked.status, 200); assert.deepEqual(await picked.json(), {cancelled: false, folder: selected});
  selection = null;
  const cancelled = await (await admin('/api/destination/pick', {})).json();
  assert.deepEqual(cancelled, {cancelled: true, folder: selected});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.state/requests.json'))).destination, selected);
});

test('folder picker stays private and refuses changes if a transfer starts while it is open', async t => {
  let choose;
  const {root, admin, create, sender} = await fixture(t, {chooseDirectory: () => new Promise(resolve => {choose = resolve;})});
  const {token} = await create();
  assert.equal((await sender(token, '/api/destination/pick', {})).status, 404);
  const pending = admin('/api/destination/pick', {});
  for (let i = 0; i < 30 && !choose; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof choose, 'function');
  assert.equal((await admin('/api/destination/pick', {})).status, 409);
  await sender(token, '/api/uploads', {name: 'arriving', size: 1});
  choose(path.join(root, 'Received'));
  assert.equal((await pending).status, 409);
  assert.equal((await admin('/api/destination/pick', {})).status, 409);
});

async function reportFixture(t, requestOptions = {}, size = 4) {
  const context = await fixture(t);
  const link = await context.create(requestOptions);
  const fileId = crypto.randomUUID();
  const created = await context.sender(link.token, '/api/batches', {sender: 'Test sender', files: [{id: fileId, name: 'camera.mov', size}]});
  assert.equal(created.status, 201);
  const batch = await created.json();
  const headers = {'X-Report-Id': batch.id, 'X-Report-Token': batch.key, 'X-Report-File': fileId};
  return {...context, link, batch, fileId, headers, send: (endpoint, data, extras = {}) => context.sender(link.token, endpoint, data, {...headers, ...extras})};
}

test('successful reported session produces matching private sender and receiver reports with a checksum', async t => {
  const {root, link, batch, send, admin} = await reportFixture(t);
  const {id} = await (await send('/api/uploads', {name: 'camera.mov', size: 4})).json();
  assert.equal((await send(`/api/uploads/${id}/chunk`, Buffer.from('film'), {'X-Upload-Offset': '0'})).status, 200);
  assert.equal((await send(`/api/uploads/${id}/finish`, {})).status, 201);
  const finish = await send(`/api/reports/${batch.id}/finish`, {});
  assert.equal(finish.status, 200); const report = await finish.json();
  assert.equal(report.status, 'completed'); assert.equal(report.files[0].status, 'completed');
  assert.equal(report.files[0].sha256, crypto.createHash('sha256').update('film').digest('hex'));
  assert.equal(report.folder, undefined); assert.equal(report.keyHash, undefined);
  const text = fs.readFileSync(path.join(root, 'Received', reportFilename(report)), 'utf8');
  assert.equal(text, formatReport(report));
  for (const secret of [link.token, batch.key, root]) assert.equal(text.includes(secret), false);
  const download = await admin(`/api/reports/${batch.id}.txt`);
  assert.equal(download.status, 200); assert.equal(await download.text(), text);
  assert.match(download.headers.get('content-disposition'), /attachment/);
});

test('failed and cancelled files still produce receiver reports', async t => {
  const failed = await reportFixture(t, {fileGiB: 2 / 1024 ** 3, maxGiB: 4 / 1024 ** 3}, 4);
  assert.equal((await failed.send('/api/uploads', {name: 'camera.mov', size: 4})).status, 413);
  const failedReport = await (await failed.send(`/api/reports/${failed.batch.id}/finish`, {})).json();
  assert.equal(failedReport.files[0].status, 'failed');
  assert.match(fs.readFileSync(path.join(failed.root, 'Received', reportFilename(failedReport)), 'utf8'), /FAILED/);
  const cancelled = await reportFixture(t);
  const {id} = await (await cancelled.send('/api/uploads', {name: 'camera.mov', size: 4})).json();
  assert.equal((await cancelled.send(`/api/uploads/${id}/cancel`, {})).status, 200);
  const cancelledReport = await (await cancelled.send(`/api/reports/${cancelled.batch.id}/finish`, {cancelled: true})).json();
  assert.equal(cancelledReport.files[0].status, 'cancelled');
  assert.match(fs.readFileSync(path.join(cancelled.root, 'Received', reportFilename(cancelledReport)), 'utf8'), /CANCELLED/);
});

test('reports require their own secret and senders cannot forge successful receipts', async t => {
  const {link, batch, fileId, send, sender} = await reportFixture(t);
  assert.equal((await sender(link.token, `/api/reports/${batch.id}`)).status, 403);
  assert.equal((await sender(link.token, `/api/reports/${batch.id}`, undefined, {'X-Report-Token': crypto.randomBytes(32).toString('base64url')})).status, 403);
  assert.equal((await send(`/api/reports/${batch.id}/event`, {fileId, status: 'completed'})).status, 400);
  const info = await (await send(`/api/reports/${batch.id}`)).json(); assert.equal(info.files[0].status, 'pending');
});

test('two senders sharing an upload link have separate private reports', async t => {
  const {root, link, batch, sender, send} = await reportFixture(t);
  const second = await (await sender(link.token, '/api/batches', {files: [{id: crypto.randomUUID(), name: 'sound.wav', size: 0}]})).json();
  assert.notEqual(second.id, batch.id); assert.notEqual(second.key, batch.key);
  assert.equal((await sender(link.token, `/api/reports/${batch.id}`, undefined, {'X-Report-Token': second.key})).status, 403);
  assert.equal((await send(`/api/reports/${batch.id}/finish`, {})).status, 200);
  assert.equal(fs.readdirSync(path.join(root, 'Received')).filter(name => name.endsWith('.txt')).length, 2);
});

test('reports remain available after closing an upload link and confirmed successes cannot be overwritten by sender errors', async t => {
  const {link, batch, fileId, send, admin} = await reportFixture(t);
  const {id} = await (await send('/api/uploads', {name: 'camera.mov', size: 4})).json();
  await send(`/api/uploads/${id}/chunk`, Buffer.from('film'), {'X-Upload-Offset': '0'});
  await send(`/api/uploads/${id}/finish`, {});
  assert.equal((await admin(`/api/requests/${link.id}/revoke`, {})).status, 200);
  const event = await send(`/api/reports/${batch.id}/event`, {fileId, status: 'unconfirmed', error: 'Lost browser confirmation.'});
  assert.equal(event.status, 200); assert.equal((await event.json()).files[0].status, 'completed');
  assert.equal((await send(`/api/reports/${batch.id}/finish`, {})).status, 200);
});

test('queued reports survive a missing drive and are delivered when the owner confirms the reconnected destination', async t => {
  const {root, admin, create, sender} = await fixture(t);
  const folder = path.join(root, 'drive'); fs.mkdirSync(folder);
  await admin('/api/destination', {folder}); fs.rmdirSync(folder);
  const {token} = await create(); const fileId = crypto.randomUUID();
  const batch = await (await sender(token, '/api/batches', {files: [{id: fileId, name: 'offline.mov', size: 1}]})).json();
  const headers = {'X-Report-Token': batch.key};
  await sender(token, `/api/reports/${batch.id}/event`, {fileId, status: 'failed', error: 'Drive offline.'}, headers);
  const report = await (await sender(token, `/api/reports/${batch.id}/finish`, {}, headers)).json();
  assert.equal(fs.existsSync(folder), false);
  const status = await (await admin('/api/status')).json(); assert.equal(status.reports[0].pendingDelivery, true);
  fs.mkdirSync(folder);
  assert.equal((await admin('/api/destination', {folder})).status, 200);
  assert.match(fs.readFileSync(path.join(folder, reportFilename(report)), 'utf8'), /Drive offline/);
  assert.equal((await (await admin('/api/status')).json()).reports[0].pendingDelivery, false);
});

test('receiver restart and abandoned sessions produce interrupted reports rather than false successes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gloryhole-report-recovery-'));
  const destination = {folder: root, device: fs.statSync(root).dev, inode: fs.statSync(root).ino};
  const validate = () => destination;
  try {
    const first = new ReportStore(root, validate);
    const batch = first.create({id: crypto.randomUUID(), label: 'Recovery'}, {files: [{id: crypto.randomUUID(), name: 'unfinished', size: 99}]}, destination);
    const recovered = new ReportStore(root, validate);
    assert.equal(recovered.reports[0].files[0].status, 'interrupted');
    assert.match(fs.readFileSync(path.join(root, reportFilename(batch.report)), 'utf8'), /INTERRUPTED/);
    const idle = recovered.create({id: crypto.randomUUID(), label: 'Idle'}, {files: [{id: crypto.randomUUID(), name: 'never sent', size: 1}]}, destination);
    recovered.sweep(new Set(), Date.now() + 11 * 60000);
    assert.equal(recovered.authenticate(idle.id, idle.key).files[0].status, 'interrupted');
  } finally {fs.rmSync(root, {recursive: true, force: true});}
});
