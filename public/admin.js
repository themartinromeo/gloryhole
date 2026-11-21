import {rateLabel, timeLabel} from './transfer-metrics.js';
const $ = id => document.getElementById(id);
const size = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
const key = new URLSearchParams(location.hash.slice(1)).get('key');
history.replaceState(null, '', '/');
function notice(message, error = false) {$('notice').textContent = message; $('notice').classList.toggle('error', error);}
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
}
function row(title, detail) {
  const el = document.createElement('div'), text = document.createElement('div'), name = document.createElement('strong'), sub = document.createElement('p');
  el.className = 'row'; sub.className = 'fine'; name.textContent = title; sub.textContent = detail; text.append(name, sub); el.append(text); return el;
}
let savedFolder, lastHistory, pickerOpen = false;
async function refresh() {
  const state = await api('/api/status');
  $('connection').textContent = state.publicBase ? 'ONLINE · READY TO RECEIVE' : 'LOCAL ONLY · NOT YET SHAREABLE';
  $('connection-detail').textContent = state.publicBase ? 'Keep Gloryhole running while files arrive. Make a fresh link each time you restart: your temporary address changes.' : 'Open Gloryhole using the double-click launcher to receive files from other computers. Links created now work on this Mac only.';
  $('public-address').textContent = state.publicBase;
  if (savedFolder === undefined || $('manual-destination').value === savedFolder) $('manual-destination').value = state.folder;
  $('destination').textContent = state.folder;
  $('choose-destination').title = state.folder;
  $('folder-name').textContent = state.folder.split('/').filter(Boolean).pop() || 'Macintosh HD';
  $('storage-kind').textContent = state.folder.startsWith('/Volumes/') ? 'CONNECTED DRIVE' : 'THIS MAC';
  savedFolder = state.folder;
  $('save-destination').disabled = state.active > 0;
  $('choose-destination').disabled = state.active > 0 || pickerOpen;
  $('receiver-panel').classList.toggle('is-receiving', state.active > 0);
  $('receive-label').textContent = state.active ? ((state.transfers || []).every(item => item.phase === 'saving') ? 'SAVING FILES' : 'RECEIVING') : 'STANDING BY';
  document.querySelector('.live-panel').classList.toggle('is-transferring', state.active > 0);
  $('active').textContent = state.active ? `${state.active} active` : 'WAITING FOR FILES';
  $('transfers').replaceChildren();
  for (const transfer of state.transfers || []) {
    const el = document.createElement('div'), name = document.createElement('span'), detail = document.createElement('span'), bar = document.createElement('progress');
    el.className = 'live-row'; name.className = 'file-name'; detail.className = 'fine'; name.textContent = transfer.name;
    detail.textContent = transfer.phase === 'saving' ? 'Verifying & saving to destination…' : `${Math.floor(transfer.bytes / Math.max(1, transfer.total) * 100)}% · ${rateLabel(transfer.bytesPerSecond)} · ${transfer.bytesPerSecond > 0 ? timeLabel((transfer.total - transfer.bytes) / transfer.bytesPerSecond) : 'Waiting for data'}`;
    bar.max = Math.max(1, transfer.total); bar.value = transfer.bytes; el.append(name, detail, bar); $('transfers').append(el);
  }
  if (!state.active) {const text = document.createElement('p'); text.className = 'fine'; text.textContent = 'Ready for the next delivery.'; $('transfers').append(text);}
  const history = JSON.stringify([state.requests, state.receipts, state.reports]);
  if (history === lastHistory) return;
  lastHistory = history;
  $('requests').replaceChildren(); $('receipts').replaceChildren();
  for (const item of [...state.requests].reverse()) {
    const closed = item.revoked || item.expiresAt <= Date.now();
    const el = row(item.label, `${closed ? 'Closed' : `Expires ${new Date(item.expiresAt).toLocaleString()}`} · ${item.receivedFiles} file${item.receivedFiles === 1 ? '' : 's'} · ${size(item.receivedBytes)} of ${size(item.maxBytes)}`);
    if (!closed) {const button = document.createElement('button'); button.className = 'quiet'; button.textContent = 'Close link'; button.onclick = async () => {try {await api(`/api/requests/${item.id}/revoke`, {}); notice('Link closed. Further uploads are blocked.'); await refresh();} catch (err) {notice(err.message, true);}}; el.append(button);}
    $('requests').append(el);
  }
  for (const item of state.receipts) {const el = row(item.name, `${size(item.bytes)} · ${new Date(item.receivedAt).toLocaleString()}`); el.title = `Saved in ${item.folder || 'original inbox'} as ${item.storedName}\nSHA-256: ${item.sha256}`; $('receipts').append(el);}
  $('reports').replaceChildren();
  for (const report of state.reports || []) {
    const el = row(report.sender || 'Anonymous sender', `${report.label} · ${report.status} · ${new Date(report.startedAt).toLocaleString()}${report.pendingDelivery ? ' · Waiting to save to destination; local copy retained' : ''}`);
    const link = document.createElement('a'); link.href = `/api/reports/${report.id}.txt`; link.textContent = 'Download report ↧'; link.className = 'fine'; el.append(link); $('reports').append(el);
  }
}
$('create').onsubmit = async e => {
  e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
  try {const link = await api('/api/requests', Object.fromEntries(new FormData(e.target))); $('new-link').hidden = false; $('link').value = link.url; $('preview').href = link.url; $('link-note').textContent = link.localOnly ? 'Test link: works on this Mac only. Open Gloryhole with the launcher to make shareable links.' : 'Copy this link now. Anyone with it can upload until it expires or you close it.'; notice('Request created. The full link is shown only here.'); await refresh();} catch (err) {notice(err.message, true);} finally {button.disabled = false;}
};
$('open-folder').onclick = async () => {try {await api('/api/open-folder', {});} catch (err) {notice(err.message, true);}};
$('destination-form').onsubmit = async e => {
  e.preventDefault();
  try {const result = await api('/api/destination', {folder: $('manual-destination').value.trim()}); $('manual-destination').value = result.folder; savedFolder = result.folder; notice('Destination saved. Future uploads will arrive in this folder.'); await refresh();} catch (err) {notice(err.message, true);}
};
$('choose-destination').onclick = async () => {
  if (pickerOpen) return;
  pickerOpen = true; $('choose-destination').disabled = true;
  notice('Choose a folder in the macOS window. Connected drives appear in its sidebar.');
  try {
    const result = await api('/api/destination/pick', {});
    if (result.cancelled) notice('Folder selection cancelled. Your destination is unchanged.');
    else {$('manual-destination').value = result.folder; savedFolder = result.folder; notice('Destination selected. New files will arrive here.');}
  } catch (err) {notice(err.message, true);}
  finally {pickerOpen = false; await refresh().catch(err => notice(err.message, true));}
};
$('copy').onclick = async () => {
  try {
    const url = $('link').value;
    if (navigator.clipboard.write && window.ClipboardItem) {
      const anchor = document.createElement('a'); anchor.href = url; anchor.textContent = 'Send files to Wookey Films';
      try {await navigator.clipboard.write([new ClipboardItem({'text/plain': new Blob([url], {type: 'text/plain'}), 'text/html': new Blob([anchor.outerHTML], {type: 'text/html'})})]);}
      catch {await navigator.clipboard.writeText(url);}
    } else await navigator.clipboard.writeText(url);
    notice('Link copied. Paste into an email for a readable invitation, or into a message for the short URL.');
  } catch {$('link').select(); notice('Select and copy the link above.');}
};
(async () => {try {if (key) await api('/api/session', {secret: key}); await refresh(); const poll = async () => {try {await refresh();} catch (err) {notice(err.message, true);} setTimeout(poll, 1000);}; setTimeout(poll, 1000);} catch (err) {notice(err.message, true);}})();
