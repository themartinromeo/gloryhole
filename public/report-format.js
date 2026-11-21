export function reportFilename(report) {
  return `Wookey-Transfer-${new Date(report.startedAt).toISOString().slice(0, 10)}-${report.id}.txt`;
}
export function formatReport(report) {
  const date = value => value ? new Date(value).toISOString() : 'Not finished';
  const line = value => String(value ?? '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  const statuses = {completed: 'RECEIVED', failed: 'FAILED', cancelled: 'CANCELLED', interrupted: 'INTERRUPTED', unconfirmed: 'UNCONFIRMED', skipped: 'NOT ATTEMPTED', pending: 'PENDING', sending: 'IN PROGRESS'};
  const totals = report.files.reduce((sum, file) => {sum.expected += file.size || 0; sum.confirmed += file.status === 'completed' ? file.size || 0 : 0; return sum;}, {expected: 0, confirmed: 0});
  const result = ['WOOKEY FILMS — TRANSFER REPORT', '================================', `Report ID: ${report.id}`, `Request: ${line(report.label)}`, `Sender: ${line(report.sender || 'Anonymous sender')}`, 'Sender name is self-reported; no identity verification.', `Started (UTC): ${date(report.startedAt)}`, `Ended (UTC): ${date(report.endedAt)}`, `Report state: ${line(report.status || 'in progress')}`, `Expected bytes: ${totals.expected}`, `Confirmed received bytes: ${totals.confirmed}`, `Files confirmed: ${report.files.filter(file => file.status === 'completed').length} / ${report.files.length}`, ''];
  for (const [index, file] of report.files.entries()) {
    result.push(`${index + 1}. ${line(file.name)}`, `   Result: ${statuses[file.status] || line(file.status)}`, `   Expected bytes: ${file.size}`, `   Bytes observed: ${file.bytes || 0}`, `   SHA-256: ${file.sha256 || 'Not confirmed'}`);
    if (file.startedAt) result.push(`   Started (UTC): ${date(file.startedAt)}`);
    if (file.endedAt) result.push(`   Ended (UTC): ${date(file.endedAt)}`);
    if (file.startedAt && file.endedAt) {
      const seconds = Math.max(0.001, (file.endedAt - file.startedAt) / 1000);
      result.push(`   Duration: ${seconds.toFixed(2)} seconds`);
      if (file.status === 'completed') result.push(`   Average rate including verification: ${(file.size / seconds / 1e6).toFixed(2)} MB/s`);
    }
    if (file.error) result.push(`   Detail: ${line(file.error)}`);
    result.push('');
  }
  result.push('RECEIVED means the receiver confirmed saving the file. A browser error or missing confirmation does not prove that no bytes arrived.', 'This report contains no upload-link credentials or receiver folder paths.', '');
  return result.join('\n');
}
