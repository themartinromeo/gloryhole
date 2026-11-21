import {TransferRate, rateLabel, timeLabel} from './transfer-metrics.js';
import {formatReport, reportFilename} from './report-format.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('request') || location.hash.slice(1);
// Keep the capability out of the address bar once loaded. It is never sent as a URL path or referrer.
history.replaceState(null, '', location.pathname);
const size = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${n.toLocaleString()} bytes`;
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', data));
// How long a sender keeps trying to reconnect, and how long an interrupted session can be resumed.
// Both match the receiver's ten-minute idle window for pending files.
const RECONNECT_WINDOW = 10 * 60000;
const RESUME_WINDOW = 10 * 60000;
const STALL_TIMEOUT = 60000;
const RETRY_STATUS = new Set([0, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const LOST = 'Connection lost. Receipt is unconfirmed; check with the recipient before retrying.';
let request, current, uploadId, busy = false, stop = false;
let batchAccess, reportFileId, latestReport, reportFolder;
let resumeKey, session, pendingResume;
try {latestReport = JSON.parse(sessionStorage.getItem('gloryhole-latest-report') || 'null');} catch {}
if (latestReport && !latestReport.endedAt) {
  latestReport.endedAt = Date.now(); latestReport.status = 'interrupted';
  for (const file of latestReport.files) if (['pending', 'sending'].includes(file.status)) Object.assign(file, {status: 'unconfirmed', error: 'The page reloaded before a final confirmation was available.'});
}
function rememberReport() {
  if (!latestReport) return;
  try {sessionStorage.setItem('gloryhole-latest-report', JSON.stringify(latestReport));} catch {}
  $('download-report').disabled = false;
}
rememberReport();
function reportHeaders() {
  return batchAccess ? {'X-Report-Id': batchAccess.id, 'X-Report-Token': batchAccess.key, ...(reportFileId ? {'X-Report-File': reportFileId} : {})} : {};
}
// The resumable session is stored per link (under a hash of the link, never the link itself) so that reopening the
// original link after closing or reloading the page can continue unfinished files.
function saveSession() {
  if (!resumeKey || !session) return;
  try {localStorage.setItem(resumeKey, JSON.stringify({...session, savedAt: Date.now()}));} catch {}
}
function clearSession() {
  session = null;
  if (resumeKey) try {localStorage.removeItem(resumeKey);} catch {}
}
function readSession() {
  if (!resumeKey) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(resumeKey) || 'null');
    if (saved?.batch?.id && Array.isArray(saved.files) && Date.now() - saved.savedAt < RESUME_WINDOW) return saved;
    localStorage.removeItem(resumeKey);
  } catch {}
  return null;
}
function downloadReport() {
  if (!latestReport) return;
  const url = URL.createObjectURL(new Blob([formatReport(latestReport)], {type: 'text/plain;charset=utf-8'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = reportFilename(latestReport); document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function saveReport() {
  rememberReport();
  if (reportFolder) {
    try {
      const handle = await reportFolder.getFileHandle(reportFilename(latestReport), {create: true});
      const writer = await handle.createWritable(); await writer.write(formatReport(latestReport)); await writer.close();
      $('report-status').textContent = `Report saved in ${reportFolder.name}.`; return;
    } catch {$('report-status').textContent = 'Could not save in the chosen folder. The report is ready to download instead.';}
  }
  downloadReport();
  $('report-status').textContent = 'Report ready; download requested. Use Download latest report if your browser blocked it.';
}
function notice(message, error = false) {$('notice').textContent = message; $('notice').classList.toggle('error', error);}
const problem = (message, status, data) => Object.assign(Error(message), {status, retryable: data?.retry === true || RETRY_STATUS.has(status)});
async function api(url, {method = 'POST', data, headers = {}} = {}) {
  let response;
  try {
    response = await fetch(url, {method, headers: {Authorization: `Bearer ${token}`, ...(data === undefined ? {} : {'Content-Type': 'application/json'}), ...reportHeaders(), ...headers}, ...(data === undefined ? {} : {body: JSON.stringify(data)})});
  } catch {throw problem(LOST, 0);}
  let result; try {result = await response.json();} catch {}
  if (!response.ok) throw problem(result?.error || `The receiver could not be reached (error ${response.status}).`, response.status, result);
  return result;
}
const uploadApi = (url, data) => api(url, {data});
async function load() {
  if (!token) {notice('Open the complete upload link the recipient sent you.', true); $('intro').textContent = 'A private link is needed to send files.'; return;}
  try {
    const response = await fetch('/api/request', {headers: {Authorization: `Bearer ${token}`}});
    const data = await response.json(); if (!response.ok) throw Error(data.error);
    request = data; $('intro').textContent = data.label;
    $('limits').textContent = `${size(data.maxFileBytes)} per file · ${size(data.remainingBytes)} remaining · Expires ${new Date(data.expiresAt).toLocaleString()}`;
    $('choose').disabled = data.remainingFiles <= 0 || data.remainingBytes <= 0;
  } catch (err) {notice(err.message || 'The receiver is unavailable. Try again when their computer is online.', true); $('intro').textContent = 'This inbox is unavailable.'; $('choose').disabled = true; request = null;}
}
// Wait in short steps so Cancel takes effect promptly; `tick` receives the whole seconds remaining.
async function pause(ms, tick = () => {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stop) throw Error('Cancelled.');
    tick(Math.ceil((end - Date.now()) / 1000));
    await new Promise(resolve => setTimeout(resolve, Math.min(250, end - Date.now())));
  }
}
function chunk(file, id, offset, progress) {
  return new Promise((resolve, reject) => {
    const xhr = current = new XMLHttpRequest();
    let stalled = false, lastProgress = Date.now();
    // Some network changes leave a connection open but silent. Abort and resynchronise rather than wait forever.
    const watchdog = setInterval(() => {if (Date.now() - lastProgress > STALL_TIMEOUT) {stalled = true; xhr.abort();}}, 5000);
    const settle = (fn, value) => {clearInterval(watchdog); fn(value);};
    xhr.open('POST', `/api/uploads/${id}/chunk`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Offset', String(offset));
    for (const [key, value] of Object.entries(reportHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = e => {lastProgress = Date.now(); if (e.lengthComputable) progress(e.loaded / e.total);};
    xhr.onload = () => {
      let data; try {data = JSON.parse(xhr.responseText);} catch {}
      if (xhr.status === 200) settle(resolve, data);
      else settle(reject, problem(data?.error || 'Upload failed. The file has not been confirmed received.', xhr.status, data));
    };
    xhr.onerror = () => settle(reject, problem(LOST, 0));
    xhr.onabort = () => settle(reject, stalled ? problem(LOST, 0) : Error('Cancelled. Receipt is unconfirmed if the upload had already finished.'));
    xhr.send(file);
  });
}
// After a retryable failure, keep asking the receiver for this upload's status until it answers. The receiver's byte
// count, not the browser's, decides where to continue. Gives up after RECONNECT_WINDOW without contact.
async function recover(id, state) {
  let lastContact = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (Date.now() - lastContact > RECONNECT_WINDOW) throw Error('Connection lost for more than 10 minutes. Receipt is unconfirmed; check with the recipient before retrying.');
    await pause(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)), seconds => state(`Connection interrupted. Reconnecting in ${seconds}s…`));
    state('Reconnecting…');
    try {
      const status = await api(`/api/uploads/${id}`, {method: 'GET'});
      if (status.completed || !status.busy || status.phase !== 'saving') return status;
      // The receiver is still verifying and saving; it is reachable, so keep waiting without a deadline.
      lastContact = Date.now(); attempt = -1;
      state('Verifying & saving… waiting for the receiver to confirm.');
    } catch (err) {if (stop || !err.retryable) throw err;}
  }
}
// Reattach to an upload started before the page was reloaded. The receiver checks the last bytes it holds against
// the file that was reselected before allowing the upload to continue.
async function prepareResume(file, id, state) {
  for (;;) {
    try {
      const status = await api(`/api/uploads/${id}`, {method: 'GET'});
      if (status.completed) return status;
      if (status.size !== file.size) throw problem('This is not the same file that was being sent.', 409);
      const sample = Math.min(status.bytes, 1024 ** 2);
      const digest = await sha256(await file.slice(status.bytes - sample, status.bytes).arrayBuffer());
      const result = await uploadApi(`/api/uploads/${id}/resume`, {length: sample, sha256: digest});
      return {id, bytes: result.bytes, chunkBytes: result.chunkBytes};
    } catch (err) {
      if (err.status === 404) return null; // The receiver no longer holds the partial file; start this file again.
      if (stop || !err.retryable) throw err;
      const status = await recover(id, state);
      if (status.completed) return status;
    }
  }
}
async function transfer(file, {progress, state}, resumed) {
  if (resumed?.completed) return resumed;
  const upload = resumed || await uploadApi('/api/uploads', {name: file.name, size: file.size});
  uploadId = upload.id;
  if (session) {session.uploadId = upload.id; session.uploadFileId = reportFileId; saveSession();}
  const fraction = bytes => file.size ? bytes / file.size : 0;
  let offset = resumed?.bytes || 0;
  progress(fraction(offset));
  try {
    while (offset < file.size) {
      if (stop) throw Error('Cancelled.');
      const part = file.slice(offset, offset + upload.chunkBytes);
      try {
        const result = await chunk(part, upload.id, offset, value => progress(fraction(offset + value * part.size)));
        offset = result.bytes; state(''); saveSession();
      } catch (err) {
        if (stop || !err.retryable) throw err;
        const status = await recover(upload.id, state);
        if (status.completed) return status;
        offset = status.bytes; state(''); progress(fraction(offset));
      }
    }
    if (stop) throw Error('Cancelled.');
    progress(1);
    for (;;) {
      try {return await uploadApi(`/api/uploads/${upload.id}/finish`, {});}
      catch (err) {
        // A lost confirmation is recovered from the receiver: finishing twice returns the original receipt.
        if (stop || !err.retryable) throw err;
        const status = await recover(upload.id, state);
        if (status.completed) return status;
        state('');
      }
    }
  } catch (err) {
    await uploadApi(`/api/uploads/${upload.id}/cancel`, {}).catch(() => {});
    throw err;
  } finally {uploadId = null;}
}
function showResume() {
  if (!pendingResume) {$('resume').hidden = true; return;}
  const names = pendingResume.remaining.map(file => file.name);
  $('resume-text').textContent = `Your previous session stopped before ${names.length === 1 ? 'this file was' : `${names.length} files were`} received: ${names.join(', ')}. Choose the same file${names.length === 1 ? '' : 's'} to continue where ${names.length === 1 ? 'it' : 'they'} stopped.`;
  $('resume').hidden = false;
}
async function offerResume() {
  const saved = readSession();
  if (!saved || !request) return;
  try {
    const response = await fetch(`/api/reports/${saved.batch.id}`, {headers: {'X-Report-Token': saved.batch.key}});
    const report = await response.json();
    if (!response.ok) {if (response.status === 403) clearSession(); return;}
    if (report.endedAt) {clearSession(); return;}
    const remaining = saved.files.filter(file => report.files.find(item => item.id === file.reportFileId)?.status !== 'completed');
    if (!remaining.length) {clearSession(); return;}
    session = saved;
    pendingResume = {...saved, report, remaining};
    showResume();
  } catch {}
}
async function discardResume() {
  const saved = pendingResume;
  pendingResume = null; showResume(); clearSession();
  if (!saved) return;
  const headers = {'X-Report-Id': saved.batch.id, 'X-Report-Token': saved.batch.key};
  if (saved.uploadId) await api(`/api/uploads/${saved.uploadId}/cancel`, {data: {}, headers: {...headers, 'X-Report-File': saved.uploadFileId}}).catch(() => {});
  try {latestReport = await api(`/api/reports/${saved.batch.id}/finish`, {data: {cancelled: true}, headers}); rememberReport();} catch {}
}
function choose(files, fromResume = false) {
  if (busy || !request || !files.length) return;
  if (pendingResume) {
    const unused = new Set(pendingResume.remaining);
    const matched = [];
    for (const file of files) {
      const entry = [...unused].find(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
      if (entry) {unused.delete(entry); matched.push({file, entry});}
    }
    if (matched.length) {
      const extra = files.length - matched.length;
      send(matched.map(item => item.file), {...pendingResume, matched}).then(() => {if (extra) notice(`${$('notice').textContent} ${extra} other file${extra === 1 ? ' was' : 's were'} not part of the interrupted session. Send ${extra === 1 ? 'it' : 'them'} now as a new session.`, true);});
      return;
    }
    if (fromResume) {notice('None of those files match the interrupted session. Choose the original files, or discard the session.', true); return;}
    discardResume();
  }
  send(files);
}
async function send(files, resume = null) {
  busy = true; stop = false; $('choose').disabled = true; $('cancel').hidden = false; notice('Keep this page open while your files send.');
  $('current-transfer').classList.add('is-transferring');
  $('drop').classList.add('is-transferring');
  batchAccess = null; reportFileId = null;
  let batchProblem, plan;
  if (resume) {
    pendingResume = null; showResume();
    batchAccess = resume.batch; latestReport = resume.report; latestReport.status = 'in progress'; rememberReport();
    plan = resume.matched.map(({file, entry}) => ({file, entry, reportFile: latestReport.files.find(item => item.id === entry.reportFileId)}));
  } else {
    clearSession();
    latestReport = {id: crypto.randomUUID(), label: request.label, sender: $('sender-name').value.trim(), startedAt: Date.now(), status: 'in progress', files: files.map(file => ({id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, status: 'pending'}))};
    rememberReport();
    try {
      batchAccess = await uploadApi('/api/batches', {sender: latestReport.sender, files: latestReport.files.map(({id, name, size}) => ({id, name, size}))});
      latestReport.id = batchAccess.id; latestReport.startedAt = batchAccess.report.startedAt; rememberReport();
    } catch (err) {batchProblem = err.message || 'Could not contact the receiver to start a reported transfer.';}
    plan = files.map((file, index) => ({file, reportFile: latestReport.files[index]}));
  }
  if (batchAccess && crypto.subtle) {
    session = {batch: {id: batchAccess.id, key: batchAccess.key}, files: plan.map(({file, reportFile}) => ({reportFileId: reportFile.id, name: file.name, size: file.size, lastModified: file.lastModified})), uploadId: null, uploadFileId: null};
    saveSession();
  }
  let sent = 0, failed = 0;
  for (const {file, reportFile, entry} of plan) {
    if (stop) break;
    reportFileId = reportFile.id;
    reportFile.startedAt ??= Date.now(); reportFile.status = 'sending'; rememberReport();
    const row = document.createElement('div'), line = document.createElement('div'), name = document.createElement('span'), status = document.createElement('span'), bar = document.createElement('progress'), detail = document.createElement('div');
    line.className = 'file-line'; name.className = 'file-name'; status.className = 'file-status';
    name.textContent = `${file.name} · ${size(file.size)}`; status.textContent = 'Sending…'; bar.max = 1; bar.value = 0;
    detail.className = 'rate-detail'; detail.textContent = 'Measuring transfer speed…';
    line.append(name, status); row.append(line, bar, detail); $('current-transfer').replaceChildren(row); $('current-transfer').hidden = false;
    const meter = new TransferRate();
    let fraction = 0, stateText = '';
    const render = () => {
      const rate = meter.rate();
      reportFile.bytes = Math.round(fraction * file.size); rememberReport();
      bar.value = fraction;
      status.textContent = stateText && fraction < 1 ? 'Reconnecting…' : fraction >= 1 ? 'Verifying & saving…' : `${Math.floor(fraction * 100)}%`;
      detail.textContent = stateText || (fraction >= 1 ? 'Waiting for the receiver to confirm the file is saved.' : `${rateLabel(rate)} · ${size(Math.round(fraction * file.size))} of ${size(file.size)} · ${rate > 0 ? timeLabel(file.size * (1 - fraction) / rate) : 'Measuring…'}`);
    };
    const ticker = setInterval(render, 500);
    const hooks = {progress: value => {fraction = value; meter.sample(value * file.size); render();}, state: text => {stateText = text; render();}};
    try {
      if (batchProblem) throw Error(batchProblem);
      if (file.size > request.maxFileBytes) throw Error('Exceeds the per-file limit.');
      let resumed = null;
      if (resume && resume.uploadId && entry.reportFileId === resume.uploadFileId) {
        hooks.state('Checking the partly sent file with the receiver…');
        resumed = await prepareResume(file, resume.uploadId, hooks.state);
        hooks.state('');
      }
      if (!resumed && file.size > request.remainingBytes) throw Error('Exceeds the remaining allowance.');
      const receipt = await transfer(file, hooks, resumed);
      Object.assign(reportFile, {status: 'completed', bytes: receipt.bytes, sha256: receipt.sha256, endedAt: Date.now(), error: null});
      clearInterval(ticker); status.textContent = 'Received ✓'; detail.textContent = 'Saved to the Wookey Films inbox.'; bar.value = 1; request.remainingBytes -= file.size; sent++;
      if (session) {session.files = session.files.filter(item => item.reportFileId !== reportFile.id); session.uploadId = null; session.uploadFileId = null; saveSession();}
    } catch (err) {
      clearInterval(ticker); status.textContent = 'Not confirmed'; detail.textContent = err.message; failed++;
      Object.assign(reportFile, {status: stop ? 'cancelled' : /connection|network|fetch|unconfirmed|lost/i.test(err.message) ? 'unconfirmed' : 'failed', error: err.message, endedAt: Date.now()});
      if (batchAccess) await uploadApi(`/api/reports/${batchAccess.id}/event`, {fileId: reportFile.id, status: reportFile.status, error: reportFile.error}).catch(() => {});
      if (session) {session.files = session.files.filter(item => item.reportFileId !== reportFile.id); session.uploadId = null; session.uploadFileId = null; saveSession();}
    }
    finally {clearInterval(ticker); const historyItem = document.createElement('li'); historyItem.append(row); $('queue').prepend(historyItem); $('current-transfer').replaceChildren(); $('current-transfer').hidden = true;}
  }
  current = null; $('cancel').hidden = true;
  $('current-transfer').classList.remove('is-transferring');
  $('drop').classList.remove('is-transferring');
  for (const file of latestReport.files) if (['pending', 'sending'].includes(file.status)) Object.assign(file, {status: stop ? 'cancelled' : 'skipped', endedAt: Date.now(), error: 'This file was not attempted.'});
  latestReport.endedAt = Date.now(); latestReport.status = sent === plan.length && latestReport.files.every(file => file.status === 'completed') ? 'completed' : latestReport.files.some(file => file.status === 'completed') ? 'completed with issues' : stop ? 'cancelled' : 'failed or interrupted';
  if (batchAccess) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {latestReport = await uploadApi(`/api/reports/${batchAccess.id}/finish`, {cancelled: stop}); break;}
      catch {if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt));}
    }
  }
  clearSession();
  reportFileId = null;
  await saveReport();
  busy = false;
  notice(stop ? 'Upload stopped.' : `${sent} file${sent === 1 ? '' : 's'} received${failed ? ` · ${failed} not confirmed` : '.'}`, failed > 0);
  await load();
}
$('choose').onclick = () => $('files').click();
$('resume-choose').onclick = () => {$('files').dataset.resume = '1'; $('files').click();};
$('resume-discard').onclick = () => {discardResume(); notice('The interrupted session was discarded. Choose files to start again.');};
$('download-report').onclick = downloadReport;
$('report-folder').onclick = async () => {
  if (!window.showDirectoryPicker) {$('report-status').textContent = 'Folder selection is unavailable in this browser. Reports can still be downloaded normally.'; return;}
  try {reportFolder = await window.showDirectoryPicker({mode: 'readwrite', id: 'wookey-transfer-reports'}); $('report-location').textContent = `Reports will be saved in ${reportFolder.name}. Choose the folder containing your originals to save beside them.`;}
  catch (err) {if (err.name !== 'AbortError') $('report-status').textContent = 'Could not access that folder. Reports can still be downloaded normally.';}
};
$('files').onchange = e => {const fromResume = e.target.dataset.resume === '1'; delete e.target.dataset.resume; choose([...e.target.files], fromResume); e.target.value = '';};
$('files').addEventListener('cancel', e => {delete e.target.dataset.resume;});
$('cancel').onclick = () => {stop = true; current?.abort(); if (uploadId) uploadApi(`/api/uploads/${uploadId}/cancel`, {}).catch(() => {});};
for (const event of ['dragenter', 'dragover']) $('drop').addEventListener(event, e => {e.preventDefault(); if (request && !busy) $('drop').classList.add('over');});
for (const event of ['dragleave', 'drop']) $('drop').addEventListener(event, e => {e.preventDefault(); $('drop').classList.remove('over');});
$('drop').addEventListener('drop', e => choose([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
window.addEventListener('beforeunload', e => {if (busy) {e.preventDefault(); e.returnValue = '';}});
(async () => {
  if (token && crypto.subtle) resumeKey = `gloryhole-resume-${(await sha256(new TextEncoder().encode(`gloryhole:${token}`))).slice(0, 32)}`;
  await load();
  await offerResume();
})();
