export class TransferRate {
  constructor(now = performance.now()) {this.samples = [{time: now, bytes: 0}]; this.bytes = 0;}
  sample(bytes, now = performance.now()) {
    if (bytes < this.bytes) this.samples = [{time: now, bytes}];
    this.bytes = bytes;
    this.samples.push({time: now, bytes});
    while (this.samples.length > 2 && this.samples[1].time <= now - 3000) this.samples.shift();
  }
  rate(now = performance.now()) {
    this.sample(this.bytes, now);
    const first = this.samples[0];
    return (this.bytes - first.bytes) / Math.max(0.1, (now - first.time) / 1000);
  }
}
export function rateLabel(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB/s` : `${Math.max(0, bytes / 1000).toFixed(0)} KB/s`;
}
export function timeLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Calculating…';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s left`;
}
