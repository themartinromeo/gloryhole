import {TransferRate, rateLabel, timeLabel} from './transfer-metrics.js';
import {formatReport, reportFilename} from './report-format.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('request') || location.hash.slice(1);
// Keep the capability out of the address bar once loaded. It is never sent as a URL path or referrer.
history.replaceState(null, '', location.pathname);
const size = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${n.toLocaleString()} bytes`;
let request, current, uploadId, busy = false, stop = false;
let batchAccess, reportFileId, latestReport, reportFolder;
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
async function uploadApi(url, data) {
  const response = await fetch(url, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...reportHeaders()}, body: JSON.stringify(data)});
  const result = await response.json(); if (!response.ok) throw Error(result.error); return result;
}
function chunk(file, id, offset, progress) {
  return new Promise((resolve, reject) => {
    const xhr = current = new XMLHttpRequest();
    xhr.open('POST', `/api/uploads/${id}/chunk`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Offset', String(offset));
    for (const [key, value] of Object.entries(reportHeaders())) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = e => {if (e.lengthComputable) progress(e.loaded / e.total);};
    xhr.onload = () => {let data; try {data = JSON.parse(xhr.responseText);} catch {} if (xhr.status === 200) resolve(data); else reject(Error(data?.error || 'Upload failed. The file has not been confirmed received.'));};
    xhr.onerror = () => reject(Error('Connection lost. Receipt is unconfirmed; check with the recipient before retrying.'));
    xhr.onabort = () => reject(Error('Cancelled. Receipt is unconfirmed if the upload had already finished.'));
    xhr.send(file);
  });
}
async function transfer(file, progress) {
  const session = await uploadApi('/api/uploads', {name: file.name, size: file.size});
  uploadId = session.id;
  try {
    for (let offset = 0; offset < file.size; offset += session.chunkBytes) {
      if (stop) throw Error('Cancelled.');
      const part = file.slice(offset, offset + session.chunkBytes);
      await chunk(part, session.id, offset, fraction => progress((offset + fraction * part.size) / file.size));
    }
    if (stop) throw Error('Cancelled.');
    progress(1);
    return await uploadApi(`/api/uploads/${session.id}/finish`, {});
  } catch (err) {
    await uploadApi(`/api/uploads/${session.id}/cancel`, {}).catch(() => {});
    throw err;
  } finally {uploadId = null;}
}
async function send(files) {
  if (busy || !request || !files.length) return;
  busy = true; stop = false; $('choose').disabled = true; $('cancel').hidden = false; notice('Keep this page open while your files send.');
  $('current-transfer').classList.add('is-transferring');
  $('drop').classList.add('is-transferring');
  batchAccess = null; reportFileId = null;
  latestReport = {id: crypto.randomUUID(), label: request.label, sender: $('sender-name').value.trim(), startedAt: Date.now(), status: 'in progress', files: files.map(file => ({id: crypto.randomUUID(), name: file.name, size: file.size, bytes: 0, status: 'pending'}))};
  rememberReport();
  let batchProblem;
  try {
    batchAccess = await uploadApi('/api/batches', {sender: latestReport.sender, files: latestReport.files.map(({id, name, size}) => ({id, name, size}))});
    latestReport.id = batchAccess.id; latestReport.startedAt = batchAccess.report.startedAt; rememberReport();
  } catch (err) {batchProblem = err.message || 'Could not contact the receiver to start a reported transfer.';}
  let sent = 0, failed = 0;
  for (const [index, file] of files.entries()) {
    if (stop) break;
    const reportFile = latestReport.files[index]; reportFileId = reportFile.id;
    reportFile.startedAt = Date.now(); reportFile.status = 'sending'; rememberReport();
    const row = document.createElement('div'), line = document.createElement('div'), name = document.createElement('span'), status = document.createElement('span'), bar = document.createElement('progress'), detail = document.createElement('div');
    line.className = 'file-line'; name.className = 'file-name'; status.className = 'file-status';
    name.textContent = `${file.name} · ${size(file.size)}`; status.textContent = 'Sending…'; bar.max = 1; bar.value = 0;
    detail.className = 'rate-detail'; detail.textContent = 'Measuring transfer speed…';
    line.append(name, status); row.append(line, bar, detail); $('current-transfer').replaceChildren(row); $('current-transfer').hidden = false;
    const meter = new TransferRate();
    let fraction = 0;
    const render = () => {
      const rate = meter.rate();
      reportFile.bytes = Math.round(fraction * file.size); rememberReport();
      bar.value = fraction;
      status.textContent = fraction >= 1 ? 'Verifying & saving…' : `${Math.floor(fraction * 100)}%`;
      detail.textContent = fraction >= 1 ? 'Waiting for the receiver to confirm the file is saved.' : `${rateLabel(rate)} · ${size(Math.round(fraction * file.size))} of ${size(file.size)} · ${rate > 0 ? timeLabel(file.size * (1 - fraction) / rate) : 'Measuring…'}`;
    };
    const ticker = setInterval(render, 500);
    try {
      if (batchProblem) throw Error(batchProblem);
      if (file.size > request.maxFileBytes) throw Error('Exceeds the per-file limit.');
      if (file.size > request.remainingBytes) throw Error('Exceeds the remaining allowance.');
      const receipt = await transfer(file, value => {fraction = value; meter.sample(value * file.size); render();});
      Object.assign(reportFile, {status: 'completed', bytes: receipt.bytes, sha256: receipt.sha256, endedAt: Date.now()});
      clearInterval(ticker); status.textContent = 'Received ✓'; detail.textContent = 'Saved to the Wookey Films inbox.'; bar.value = 1; request.remainingBytes -= file.size; sent++;
    } catch (err) {
      clearInterval(ticker); status.textContent = 'Not confirmed'; detail.textContent = err.message; failed++;
      Object.assign(reportFile, {status: stop ? 'cancelled' : /connection|network|fetch|unconfirmed|lost/i.test(err.message) ? 'unconfirmed' : 'failed', error: err.message, endedAt: Date.now()});
      if (batchAccess) await uploadApi(`/api/reports/${batchAccess.id}/event`, {fileId: reportFile.id, status: reportFile.status, error: reportFile.error}).catch(() => {});
    }
    finally {clearInterval(ticker); const historyItem = document.createElement('li'); historyItem.append(row); $('queue').prepend(historyItem); $('current-transfer').replaceChildren(); $('current-transfer').hidden = true;}
  }
  current = null; $('cancel').hidden = true;
  $('current-transfer').classList.remove('is-transferring');
  $('drop').classList.remove('is-transferring');
  for (const file of latestReport.files) if (['pending', 'sending'].includes(file.status)) Object.assign(file, {status: stop ? 'cancelled' : 'skipped', endedAt: Date.now(), error: 'This file was not attempted.'});
  latestReport.endedAt = Date.now(); latestReport.status = sent === files.length ? 'completed' : sent ? 'completed with issues' : stop ? 'cancelled' : 'failed or interrupted';
  if (batchAccess) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {latestReport = await uploadApi(`/api/reports/${batchAccess.id}/finish`, {cancelled: stop}); break;}
      catch {if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 150));}
    }
  }
  reportFileId = null;
  await saveReport();
  busy = false;
  notice(stop ? 'Upload stopped.' : `${sent} file${sent === 1 ? '' : 's'} received${failed ? ` · ${failed} not confirmed` : '.'}`, failed > 0);
  await load();
}
$('choose').onclick = () => $('files').click();
$('download-report').onclick = downloadReport;
$('report-folder').onclick = async () => {
  if (!window.showDirectoryPicker) {$('report-status').textContent = 'Folder selection is unavailable in this browser. Reports can still be downloaded normally.'; return;}
  try {reportFolder = await window.showDirectoryPicker({mode: 'readwrite', id: 'wookey-transfer-reports'}); $('report-location').textContent = `Reports will be saved in ${reportFolder.name}. Choose the folder containing your originals to save beside them.`;}
  catch (err) {if (err.name !== 'AbortError') $('report-status').textContent = 'Could not access that folder. Reports can still be downloaded normally.';}
};
$('files').onchange = e => {send([...e.target.files]); e.target.value = '';};
$('cancel').onclick = () => {stop = true; current?.abort(); if (uploadId) uploadApi(`/api/uploads/${uploadId}/cancel`, {}).catch(() => {});};
for (const event of ['dragenter', 'dragover']) $('drop').addEventListener(event, e => {e.preventDefault(); if (request && !busy) $('drop').classList.add('over');});
for (const event of ['dragleave', 'drop']) $('drop').addEventListener(event, e => {e.preventDefault(); $('drop').classList.remove('over');});
$('drop').addEventListener('drop', e => send([...e.dataTransfer.files]));
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
window.addEventListener('beforeunload', e => {if (busy) {e.preventDefault(); e.returnValue = '';}});
load();
