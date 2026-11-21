import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {formatReport, reportFilename} from './public/report-format.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const safe = (value, limit = 180) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);
const problem = (status, message) => Object.assign(new Error(message), {status});
const finalStates = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unconfirmed', 'skipped']);

export class ReportStore {
  constructor(directory, destinationInfo) {
    this.file = path.join(directory, 'transfer-reports.json');
    this.destinationInfo = destinationInfo;
    this.reports = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    for (const report of this.reports) {
      if (!report.endedAt) {
        for (const file of report.files) if (!finalStates.has(file.status)) Object.assign(file, {status: 'interrupted', error: 'The receiver restarted before this transfer was confirmed.', endedAt: Date.now()});
        report.endedAt = Date.now(); report.status = 'interrupted'; report.needsDelivery = true;
      }
    }
    this.persist(); this.deliverPending();
  }
  persist() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.reports, null, 2), {mode: 0o600});
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  view(report) {
    const {keyHash, folder, device, inode, needsDelivery, deliveryError, ...publicView} = report;
    return structuredClone(publicView);
  }
  authenticate(id, token, requestId) {
    if (typeof id !== 'string' || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw problem(403, 'Invalid report access.');
    const report = this.reports.find(item => item.id === id && item.keyHash === hash(token));
    if (!report || (requestId && report.requestId !== requestId)) throw problem(403, 'Invalid report access.');
    return report;
  }
  create(record, input, destination) {
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100) throw problem(400, 'Choose between 1 and 100 files for a report.');
    if (this.reports.filter(item => !item.endedAt).length >= 100) throw problem(429, 'Too many report sessions are open. Try again later.');
    const ids = new Set();
    const files = input.files.map(file => {
      if (typeof file.id !== 'string' || !/^[a-f0-9-]{36}$/.test(file.id) || ids.has(file.id) || typeof file.name !== 'string' || !file.name || !Number.isSafeInteger(file.size) || file.size < 0) throw problem(400, 'Invalid report file list.');
      ids.add(file.id);
      return {id: file.id, name: safe(file.name), size: file.size, bytes: 0, status: 'pending'};
    });
    const key = crypto.randomBytes(32).toString('base64url');
    const report = {id: crypto.randomUUID(), requestId: record.id, keyHash: hash(key), label: safe(record.label), sender: safe(input.sender, 100), files, startedAt: Date.now(), touchedAt: Date.now(), status: 'in progress', ...destination, needsDelivery: true};
    this.reports.push(report); this.persist(); this.deliver(report); this.persist();
    return {id: report.id, key, report: this.view(report)};
  }
  deliver(report) {
    let temporary;
    try {
      const current = this.destinationInfo(report.folder);
      if (report.device === null) {report.device = current.device; report.inode = current.inode;}
      if (current.device !== report.device || current.inode !== report.inode) throw Error('The original destination is not connected.');
      temporary = path.join(report.folder, `.${reportFilename(report)}.${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, formatReport(this.view(report)), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temporary, path.join(report.folder, reportFilename(report)));
      report.needsDelivery = false; report.deliveryError = null;
    } catch {
      report.needsDelivery = true;
      report.deliveryError = 'Report saved privately on this Mac; waiting for the original destination to become writable.';
      if (temporary) {try {fs.rmSync(temporary, {force: true});} catch {}}
    }
  }
  deliverPending() {
    for (const report of this.reports) if (report.needsDelivery) this.deliver(report);
    this.persist();
  }
  confirmDestination(destination) {
    for (const report of this.reports) if (report.needsDelivery && report.folder === destination.folder) {
      report.device = destination.device; report.inode = destination.inode;
      this.deliver(report);
    }
    this.persist();
  }
  update(report, fileId, change) {
    const file = report.files.find(item => item.id === fileId);
    if (!file) throw problem(400, 'This file is not part of the report.');
    if (file.status === 'completed') return;
    Object.assign(file, change); report.touchedAt = Date.now(); report.needsDelivery = true;
    this.persist();
    if (change.status && change.status !== 'sending') {this.deliver(report); this.persist();}
  }
  finalize(report, reason = 'interrupted') {
    if (report.endedAt) return;
    for (const file of report.files) if (!finalStates.has(file.status)) Object.assign(file, {status: reason, endedAt: Date.now(), error: reason === 'skipped' ? 'No transfer was attempted.' : 'The sending session ended before this file was confirmed.'});
    report.endedAt = Date.now();
    report.status = report.files.every(file => file.status === 'completed') ? 'completed' : report.files.some(file => file.status === 'completed') ? 'completed with issues' : reason === 'cancelled' ? 'cancelled' : 'failed or interrupted';
    report.needsDelivery = true; this.persist(); this.deliver(report); this.persist();
  }
  sweep(activeReportIds, now = Date.now()) {
    for (const report of this.reports) if (!report.endedAt && !activeReportIds.has(report.id) && now - report.touchedAt > 10 * 60000) this.finalize(report);
    this.deliverPending();
  }
  shutdown() {
    for (const report of this.reports) if (!report.endedAt) this.finalize(report);
  }
}
