import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {execFile} from 'node:child_process';
import {TransferRate} from './public/transfer-metrics.js';
import {ReportStore} from './reports.mjs';
import {formatReport, reportFilename} from './public/report-format.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GiB = 1024 ** 3;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fail = (status, message) => Object.assign(new Error(message), {status});

export async function startInbox(options = {}) {
  const root = path.resolve(options.root || process.env.INBOX_DATA || path.join(here, 'data'));
  const stateDir = path.join(root, '.state');
  let incoming = path.join(root, 'Received');
  const staging = path.join(root, '.partial');
  for (const dir of [root, stateDir, incoming, staging]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const lockFile = path.join(stateDir, 'receiver.pid');
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Receiver lock is invalid. Check that no receiver is running before removing .state/receiver.pid.');
    let alive = true;
    try {process.kill(pid, 0);} catch (err) {if (err.code === 'ESRCH') alive = false;}
    if (alive) throw Error('Gloryhole is already running with this inbox folder.');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, String(process.pid), {flag: 'wx', mode: 0o600});
  // This directory is owned exclusively by this receiver. Partial files never count as completed uploads.
  for (const name of fs.readdirSync(staging)) if (/^[a-f0-9-]+\.part$/.test(name)) fs.rmSync(path.join(staging, name));
  const stateFile = path.join(stateDir, 'requests.json');
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {requests: [], receipts: []};
  incoming = state.destination || incoming;
  const destinationInfo = (folder, probe = false) => {
    try {
      const resolved = fs.realpathSync(folder);
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) throw Error('not a folder');
      const volume = resolved.match(/^\/Volumes\/[^/]+/);
      if (volume && fs.statSync(volume[0]).dev === fs.statSync('/Volumes').dev) throw Error('drive is not mounted');
      fs.accessSync(resolved, fs.constants.W_OK | fs.constants.X_OK);
      if (probe) {
        const check = path.join(resolved, `.gloryhole-write-check-${crypto.randomUUID()}`);
        fs.closeSync(fs.openSync(check, 'wx', 0o600)); fs.unlinkSync(check);
      }
      return {folder: resolved, device: stat.dev, inode: stat.ino};
    } catch {throw fail(400, 'The destination is unavailable or not writable. Connect the drive and choose an existing folder.');}
  };
  const persist = () => {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), {mode: 0o600});
    fs.renameSync(tmp, stateFile);
  };
  let publicBase = process.env.INBOX_PUBLIC_URL || '';
  const adminSecret = options.adminSecret || random();
  const sessionSecret = random();
  const active = new Map();
  const reports = new ReportStore(stateDir, destinationInfo);
  const discard = (item, status = 'cancelled', reason = 'The upload was cancelled.') => {
    item.cancelled = true;
    if (item.report) reports.update(item.report, item.reportFileId, {status, error: reason, bytes: item.bytes, endedAt: Date.now()});
    item.req?.destroy();
    if (!item.busy) {fs.rmSync(item.temporary, {force: true}); active.delete(item.id);}
  };
  const janitor = setInterval(() => {
    for (const item of active.values()) if (item.record.revoked || Date.now() >= item.record.expiresAt || (!item.busy && Date.now() - item.touched > 10 * 60000)) discard(item, 'interrupted', 'The link expired, was closed, or the sender disconnected.');
    reports.sweep(new Set([...active.values()].map(item => item.report?.id).filter(Boolean)));
  }, 15000);
  janitor.unref();
  const rates = new Map();
  let adminOrigin;
  let closing = false;
  let choosingDestination = false;
  const chooseDirectory = options.chooseDirectory || (folder => new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') return reject(fail(400, 'The folder picker is available on macOS.'));
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', path.join(here, 'folder-picker.jxa'), folder], {timeout: 300000, maxBuffer: 8192}, (err, stdout) => {
      if (err) return reject(fail(503, 'The folder picker could not open. Try again, or enter a path manually.'));
      resolve(stdout.trim() || null);
    });
  }));
  const json = (res, code, data) => {res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(data));};
  const headers = res => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  };
  const body = async (req, limit = 8192) => {
    if (req.headers['content-type'] !== 'application/json') throw fail(415, 'JSON required.');
    let raw = '';
    for await (const part of req) {raw += part; if (Buffer.byteLength(raw) > limit) throw fail(413, 'Request too large.');}
    try { return JSON.parse(raw || '{}'); } catch {throw fail(400, 'Invalid JSON.');}
  };
  const authorizeAdmin = req => {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('inbox_admin='))?.slice(12);
    if (!equal(cookie, sessionSecret)) throw fail(401, 'Open the control panel using the launcher.');
    if (req.method !== 'GET' && req.headers.origin !== adminOrigin) throw fail(403, 'Invalid control panel origin.');
  };
  const authorizeUpload = req => {
    const value = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43})$/)?.[1];
    const record = value && state.requests.find(item => item.tokenHash === digest(value));
    if (!record || record.revoked || Date.now() >= record.expiresAt) throw fail(410, 'This upload link has expired or been closed. Ask for a new link.');
    return record;
  };
  const staticFile = (res, name) => {
    const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf'};
    res.writeHead(200, {'Content-Type': `${types[path.extname(name)]}; charset=utf-8`});
    res.end(fs.readFileSync(path.join(here, 'public', name)));
  };
  const wrap = handler => async (req, res) => {
    headers(res);
    try {
      if (closing) throw fail(503, 'Receiver is stopping.');
      await handler(req, res);
    } catch (err) {
      if (req.reportContext) {
        const {report, fileId} = req.reportContext;
        const file = report.files.find(item => item.id === fileId);
        if (file && file.status !== 'cancelled' && file.status !== 'interrupted') {
          try {reports.update(report, fileId, {status: 'failed', error: err.status ? err.message : 'The receiver could not confirm this file.', endedAt: Date.now()});} catch {}
        }
      }
      if (!res.headersSent && !res.destroyed) json(res, err.status || 500, {error: err.status ? err.message : 'The receiver could not complete this request.'});
      else if (!res.destroyed) res.destroy();
      if (!err.status && err.code !== 'ECONNRESET' && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Receiver error:', err.message);
    }
  };
  const admin = http.createServer(wrap(async (req, res) => {
    if (req.headers.host !== new URL(adminOrigin).host) throw fail(403, 'Invalid host.');
    const url = new URL(req.url, adminOrigin);
    if (req.method === 'GET' && url.pathname === '/') return staticFile(res, 'admin.html');
    if (req.method === 'GET' && ['/style.css', '/admin.js', '/transfer-metrics.js', '/report-format.js', '/wookey-logo.png', '/wookey-regular.ttf', '/wookey-bold.ttf'].includes(url.pathname)) return staticFile(res, url.pathname.slice(1));
    if (req.method === 'POST' && url.pathname === '/api/session') {
      if (req.headers.origin !== adminOrigin) throw fail(403, 'Invalid origin.');
      const input = await body(req);
      if (!equal(input.secret, adminSecret)) throw fail(401, 'Invalid control panel key.');
      res.setHeader('Set-Cookie', `inbox_admin=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, 200, {ok: true});
    }
    authorizeAdmin(req);
    const reportDownload = url.pathname.match(/^\/api\/reports\/([a-f0-9-]{36})\.txt$/);
    if (req.method === 'GET' && reportDownload) {
      const report = reports.reports.find(item => item.id === reportDownload[1]);
      if (!report) throw fail(404, 'Report not found.');
      res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${reportFilename(report)}"`});
      return res.end(formatReport(reports.view(report)));
    }
    if (req.method === 'POST' && url.pathname === '/api/destination/pick') {
      await body(req);
      if (active.size) throw fail(409, 'Wait for current transfers to finish before changing the destination.');
      if (choosingDestination) throw fail(409, 'A folder picker is already open.');
      choosingDestination = true;
      try {
        const folder = await chooseDirectory(incoming);
        if (!folder) return json(res, 200, {cancelled: true, folder: incoming});
        if (active.size) throw fail(409, 'A transfer started while choosing. Try again once it finishes.');
        const selected = destinationInfo(folder, true);
        const prior = state.destination;
        state.destination = selected.folder;
        try {persist();} catch (err) {state.destination = prior; throw err;}
        incoming = selected.folder;
        reports.confirmDestination(selected);
        return json(res, 200, {cancelled: false, folder: incoming});
      } finally {choosingDestination = false;}
    }
    if (req.method === 'POST' && url.pathname === '/api/destination') {
      const {folder} = await body(req);
      if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw fail(400, 'Enter a full folder path, such as /Volumes/Studio/Incoming.');
      if (active.size) throw fail(409, 'Wait for current transfers to finish before changing the destination.');
      const selected = destinationInfo(folder, true);
      const prior = state.destination;
      state.destination = selected.folder;
      try {persist();} catch (err) {state.destination = prior; throw err;}
      incoming = selected.folder;
      reports.confirmDestination(selected);
      return json(res, 200, {folder: incoming});
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      await body(req);
      if (process.platform !== 'darwin') throw fail(400, 'Open the received-files folder using your file manager.');
      await new Promise((resolve, reject) => execFile('/usr/bin/open', [incoming], err => err ? reject(err) : resolve()));
      return json(res, 200, {ok: true});
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, {
      publicBase, folder: incoming, active: active.size,
      transfers: [...active.values()].map(item => ({id: item.id, name: item.name, bytes: item.bytes + (item.inflight || 0), total: item.length, bytesPerSecond: item.rate.rate(), phase: item.phase || 'receiving'})),
      reports: reports.reports.slice(-100).reverse().map(item => ({id: item.id, sender: item.sender, label: item.label, status: item.status, startedAt: item.startedAt, endedAt: item.endedAt, pendingDelivery: item.needsDelivery})),
      requests: state.requests.map(({tokenHash, ...rest}) => rest), receipts: state.receipts.slice(-100).reverse()
    });
    if (req.method === 'POST' && url.pathname === '/api/public-url') {
      const {url: supplied} = await body(req);
      if (supplied === '') publicBase = '';
      else {
        let candidate; try { candidate = new URL(supplied); } catch {throw fail(400, 'Enter a valid HTTPS address.');}
        if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) throw fail(400, 'Use an HTTPS origin, such as https://your-address.example.');
        publicBase = candidate.origin;
      }
      return json(res, 200, {ok: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/requests') {
      const input = await body(req);
      const hours = Number(input.hours ?? 24), maxBytes = Number(input.maxGiB ?? 25) * GiB, maxFileBytes = Number(input.fileGiB ?? 10) * GiB;
      if (!Number.isFinite(hours) || hours <= 0 || hours > 168 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * GiB || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > maxBytes) throw fail(400, 'Check the expiry and upload limits (maximum 7 days and 1 TB).');
      if (state.requests.filter(r => !r.revoked && r.expiresAt > Date.now()).length >= 100) throw fail(400, 'Close an existing request before creating another.');
      const token = crypto.randomBytes(16).toString('base64url');
      const record = {id: crypto.randomUUID(), tokenHash: digest(token), label: String(input.label || 'Send me files').slice(0, 100), createdAt: Date.now(), expiresAt: Date.now() + hours * 3600000, maxBytes, maxFileBytes, maxFiles: 100, receivedBytes: 0, receivedFiles: 0, revoked: false};
      state.requests.push(record); persist();
      const base = publicBase || `http://127.0.0.1:${upload.address().port}`;
      return json(res, 201, {url: `${base}/#${token}`, localOnly: !publicBase, id: record.id});
    }
    const revoke = url.pathname.match(/^\/api\/requests\/([a-f0-9-]+)\/revoke$/);
    if (req.method === 'POST' && revoke) {
      await body(req);
      const record = state.requests.find(r => r.id === revoke[1]);
      if (!record) throw fail(404, 'Request not found.');
      record.revoked = true; persist();
      for (const item of active.values()) if (item.record === record) discard(item, 'cancelled', 'The receiver closed this upload link.');
      return json(res, 200, {ok: true});
    }
    throw fail(404, 'Not found.');
  }));
  const upload = http.createServer(wrap(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return staticFile(res, 'upload.html');
    if (req.method === 'GET' && ['/style.css', '/upload.js', '/transfer-metrics.js', '/report-format.js', '/wookey-logo.png', '/wookey-regular.ttf', '/wookey-bold.ttf'].includes(url.pathname)) return staticFile(res, url.pathname.slice(1));
    if (!url.pathname.startsWith('/api/')) throw fail(404, 'Not found.');
    const reportRoute = url.pathname.match(/^\/api\/reports\/([a-f0-9-]{36})(?:\/(event|finish))?$/);
    if (reportRoute) {
      const report = reports.authenticate(reportRoute[1], req.headers['x-report-token']);
      if (req.method === 'GET' && !reportRoute[2]) return json(res, 200, reports.view(report));
      if (req.method !== 'POST') throw fail(404, 'Not found.');
      const input = await body(req);
      if (reportRoute[2] === 'event') {
        if (report.endedAt) throw fail(409, 'This report is already finished.');
        if (!['failed', 'cancelled', 'skipped', 'unconfirmed'].includes(input.status)) throw fail(400, 'Invalid report event.');
        reports.update(report, input.fileId, {status: input.status, error: String(input.error || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300), endedAt: Date.now()});
      } else if (reportRoute[2] === 'finish') {
        if ([...active.values()].some(item => item.report === report)) throw fail(409, 'A file is still in progress.');
        reports.finalize(report, input.cancelled ? 'cancelled' : 'skipped');
      } else throw fail(404, 'Not found.');
      return json(res, 200, reports.view(report));
    }
    const record = authorizeUpload(req);
    if (req.method === 'POST' && url.pathname === '/api/batches') {
      const key = `report:${record.id}`;
      const bucket = rates.get(key) || {start: Date.now(), count: 0};
      if (Date.now() - bucket.start > 60000) {bucket.start = Date.now(); bucket.count = 0;}
      rates.set(key, bucket);
      if (++bucket.count > 20) throw fail(429, 'Too many report sessions. Wait a minute before sending more files.');
      const input = await body(req, 65536);
      let destination;
      try {destination = destinationInfo(incoming);} catch {destination = {folder: incoming, device: null, inode: null};}
      return json(res, 201, reports.create(record, input, destination));
    }
    if (req.headers['x-report-id']) {
      const report = reports.authenticate(req.headers['x-report-id'], req.headers['x-report-token'], record.id);
      const fileId = req.headers['x-report-file'];
      if (!report.files.some(file => file.id === fileId) || report.endedAt) throw fail(400, 'Invalid report file.');
      req.reportContext = {report, fileId};
    }
    if (req.method === 'GET' && url.pathname === '/api/request') return json(res, 200, {
      label: record.label, expiresAt: record.expiresAt, maxFileBytes: record.maxFileBytes,
      remainingBytes: Math.max(0, record.maxBytes - record.receivedBytes), remainingFiles: record.maxFiles - record.receivedFiles
    });
    if (req.method !== 'POST') throw fail(404, 'Not found.');
    if (url.pathname !== '/api/uploads') {
      const match = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/(chunk|finish|cancel)$/);
      if (!match) throw fail(404, 'Not found.');
      const item = active.get(match[1]);
      if (!item || item.record !== record || item.cancelled) throw fail(404, 'Upload not found. Start the file again.');
      if (item.report) {
        if (!req.reportContext || req.reportContext.report !== item.report || req.reportContext.fileId !== item.reportFileId) throw fail(403, 'This file belongs to a different report session.');
      }
      if (match[2] === 'cancel') {await body(req); discard(item); return json(res, 200, {ok: true});}
      if (item.busy) throw fail(409, 'This upload already has a request in progress.');
      item.busy = true; item.req = req; item.touched = Date.now();
      try {
        if (match[2] === 'chunk') {
          const length = Number(req.headers['content-length']);
          const offset = Number(req.headers['x-upload-offset']);
          if (!Number.isSafeInteger(length) || length <= 0 || length > 8 * 1024 ** 2) throw fail(413, 'Chunk must be between 1 byte and 8 MB.');
          if (!Number.isSafeInteger(offset) || offset !== item.bytes) throw fail(409, 'Upload offset mismatch. Start the file again.');
          if (item.bytes + length > item.length) throw fail(413, 'Chunk exceeds the declared file size.');
          let received = 0;
          const meter = new Transform({transform(chunk, encoding, callback) {
            received += chunk.length;
            item.inflight = received; item.rate.sample(item.bytes + received);
            if (item.cancelled || record.revoked || Date.now() >= record.expiresAt) return callback(fail(410, 'Upload link is closed.'));
            if (received > length) return callback(fail(413, 'Chunk too large.'));
            callback(null, chunk);
          }});
          try {
            await pipeline(req, meter, fs.createWriteStream(item.temporary, {flags: 'r+', start: item.bytes}));
            if (received !== length) throw fail(400, 'Incomplete chunk.');
          } catch (err) {item.inflight = 0; item.rate.sample(item.bytes); fs.truncateSync(item.temporary, item.bytes); throw err;}
          item.bytes += received; item.inflight = 0;
          if (item.report) reports.update(item.report, item.reportFileId, {bytes: item.bytes});
          return json(res, 200, {bytes: item.bytes});
        }
        await body(req);
        if (item.bytes !== item.length) throw fail(409, 'The file is not fully uploaded yet.');
        item.phase = 'saving';
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(item.temporary)) {
          if (item.cancelled || record.revoked || Date.now() >= record.expiresAt) throw fail(410, 'Upload link is closed.');
          hash.update(chunk);
        }
        if (item.cancelled || record.revoked || Date.now() >= record.expiresAt) throw fail(410, 'Upload link is closed.');
        const currentFolder = destinationInfo(item.folder);
        if (currentFolder.device !== item.device || currentFolder.inode !== item.inode) throw fail(409, 'The destination drive changed during this upload. Reconnect it and try again.');
        const destination = path.join(item.folder, item.storedName);
        // COPYFILE_EXCL works across volumes and on SMB shares, without replacing existing files.
        let created = false;
        try {
          await fs.promises.copyFile(item.temporary, destination, fs.constants.COPYFILE_EXCL);
          created = true;
          const after = destinationInfo(item.folder);
          if (after.device !== item.device || after.inode !== item.inode) throw fail(409, 'The destination changed while saving.');
          if (item.cancelled || record.revoked || Date.now() >= record.expiresAt) throw fail(410, 'Upload link is closed.');
        } catch (err) {if (created) fs.rmSync(destination, {force: true}); throw err;}
        const receipt = {id: item.id, requestId: record.id, name: item.name, storedName: item.storedName, folder: item.folder, bytes: item.bytes, sha256: hash.digest('hex'), receivedAt: Date.now()};
        record.receivedBytes += item.bytes; record.receivedFiles++; state.receipts.push(receipt);
        try {persist();} catch (err) {record.receivedBytes -= item.bytes; record.receivedFiles--; state.receipts.pop(); fs.unlinkSync(destination); throw err;}
        if (item.report) reports.update(item.report, item.reportFileId, {status: 'completed', bytes: item.bytes, sha256: receipt.sha256, endedAt: Date.now(), error: null});
        active.delete(item.id); fs.rmSync(item.temporary, {force: true});
        return json(res, 201, {ok: true, name: item.name, bytes: item.bytes, sha256: receipt.sha256});
      } finally {
        item.busy = false; item.req = null; item.touched = Date.now();
        if (item.cancelled) discard(item);
      }
    }
    const bucket = rates.get(record.id) || {start: Date.now(), count: 0};
    if (Date.now() - bucket.start > 60000) {bucket.start = Date.now(); bucket.count = 0;}
    rates.set(record.id, bucket);
    if (++bucket.count > 120) throw fail(429, 'Too many upload attempts. Wait a minute.');
    const input = await body(req);
    const length = input.size;
    if (req.reportContext) {
      const {report, fileId} = req.reportContext;
      const file = report.files.find(item => item.id === fileId);
      if (file.size !== length || file.name !== String(input.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180) || file.status === 'completed') throw fail(400, 'File details do not match the transfer report.');
      if ([...active.values()].some(item => item.report === report && item.reportFileId === fileId)) throw fail(409, 'This report file is already uploading.');
    }
    if (!Number.isSafeInteger(length) || length < 0) throw fail(411, 'A file size is required.');
    if (length > record.maxFileBytes) throw fail(413, 'This file exceeds the per-file limit.');
    const own = [...active.values()].filter(item => item.record === record);
    if (active.size >= 4 || own.length >= 2) throw fail(429, 'The receiver is busy. Try again shortly.');
    const reserved = own.reduce((sum, item) => sum + item.length, 0);
    if (record.receivedBytes + reserved + length > record.maxBytes || record.receivedFiles + own.length >= record.maxFiles) throw fail(413, 'This upload link has reached its limit.');
    const selected = destinationInfo(req.reportContext?.report.folder || incoming);
    if (req.reportContext?.report.device != null && (selected.device !== req.reportContext.report.device || selected.inode !== req.reportContext.report.inode)) throw fail(409, 'The session destination changed. Reconnect and confirm the original destination before trying again.');
    const free = fs.statfsSync(root);
    const targetFree = fs.statfsSync(selected.folder);
    const allReserved = [...active.values()].reduce((sum, item) => sum + item.length, 0);
    if (free.bavail * free.bsize < length + allReserved + (options.diskReserveBytes ?? GiB)) throw fail(507, 'The receiving computer does not have enough free space.');
    if (targetFree.bavail * targetFree.bsize < length * (selected.device === fs.statSync(root).dev ? 2 : 1) + allReserved + (options.diskReserveBytes ?? GiB)) throw fail(507, 'The destination does not have enough free space.');
    const original = input.name;
    if (typeof original !== 'string' || !original || original.length > 1024) throw fail(400, 'A file name is required.');
    let name = original.normalize('NFC').replace(/[\x00-\x1f\x7f/\\:]/g, '_').replace(/^\.+/, '').slice(0, 150) || 'upload';
    while (Buffer.byteLength(name) > 180) name = name.slice(0, -1);
    const id = crypto.randomUUID();
    const temporary = path.join(staging, `${id}.part`);
    const storedName = `${id}--${name}`;
    fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
    active.set(id, {id, record, length, name, storedName, temporary, ...selected, report: req.reportContext?.report, reportFileId: req.reportContext?.fileId, rate: new TransferRate(), bytes: 0, touched: Date.now(), busy: false, req: null, cancelled: false});
    if (req.reportContext) reports.update(req.reportContext.report, req.reportContext.fileId, {status: 'sending', startedAt: Date.now(), bytes: 0, error: null});
    json(res, 201, {id, chunkBytes: 8 * 1024 ** 2});
  }));
  for (const server of [admin, upload]) {
    server.headersTimeout = 30000;
    server.requestTimeout = 24 * 60 * 60 * 1000;
    server.timeout = 120000;
    server.maxHeadersCount = 40;
    server.on('clientError', (_, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  }
  const listen = (server, port) => new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
  try {
    await listen(upload, options.uploadPort ?? Number(process.env.INBOX_UPLOAD_PORT || 48732));
    await listen(admin, options.adminPort ?? Number(process.env.INBOX_ADMIN_PORT || 48731));
  } catch (err) {clearInterval(janitor); upload.close(); fs.rmSync(lockFile, {force: true}); throw err;}
  adminOrigin = `http://127.0.0.1:${admin.address().port}`;
  return {
    adminOrigin, uploadOrigin: `http://127.0.0.1:${upload.address().port}`, adminUrl: `${adminOrigin}/#key=${adminSecret}`, root,
    get folder() {return incoming;},
    setPublicBase: value => {publicBase = value;},
    close: async () => {
      closing = true;
      clearInterval(janitor);
      for (const item of active.values()) discard(item, 'interrupted', 'The receiver stopped before the file was confirmed.');
      await Promise.all([admin, upload].map(server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();})));
      reports.shutdown();
      fs.rmSync(lockFile, {force: true});
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startInbox();
  console.log(`Gloryhole is running.\nControl panel: ${app.adminUrl}\nUpload listener: ${app.uploadOrigin}\nFiles: ${app.folder}\nKeep this window open. Press Control-C to stop.`);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, async () => {await app.close(); process.exit(0);});
}
