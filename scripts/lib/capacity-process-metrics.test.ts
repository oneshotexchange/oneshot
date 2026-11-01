import { describe, expect, it } from 'vitest';
import { parseLinuxProcessSample, parseWindowsProcessSample, readPoolSnapshot, sampleOwnedProcess } from './capacity-process-metrics';

const unavailable = { supported: false, rssBytes: null, privateBytes: null, cpuMs: null };
const windows = { WorkingSet64: 12_345_678, PrivateMemorySize64: 23_456_789, CpuMilliseconds: 1234.375 };
function stat(user = '250', system = '50') {
  const fields = Array.from({ length: 22 }, () => '0');
  fields[0] = 'S'; fields[11] = user; fields[12] = system;
  return `123 (private process ) name) ${fields.join(' ')}`;
}

describe('bounded owned-process measurements', () => {
  it('reads Windows memory and CPU numbers without retaining extra process fields', () => {
    const result = parseWindowsProcessSample(JSON.stringify({ ...windows, Id: 123, Path: 'C:/private-user/private-app', ProcessName: 'private-process' }));
    expect(result).toEqual({ supported: true, rssBytes: 12_345_678, privateBytes: 23_456_789, cpuMs: 1234.375 });
    expect(JSON.stringify(result)).not.toMatch(/private-|Path|ProcessName|Id/);
  });
  it('sanitizes malformed or unsafe Windows numbers and output', () => {
    for (const value of [undefined, null, [], 'private-command-error', 'x'.repeat(16_385), JSON.stringify([windows]), JSON.stringify({ ...windows, CpuMilliseconds: '12' }),
      JSON.stringify({ ...windows, WorkingSet64: -1 }), JSON.stringify({ ...windows, PrivateMemorySize64: 1.2 }),
      JSON.stringify({ ...windows, CpuMilliseconds: Number.MAX_VALUE }), JSON.stringify({ ...windows, WorkingSet64: Number.MAX_SAFE_INTEGER + 1 })]) {
      expect(parseWindowsProcessSample(value)).toEqual(unavailable);
    }
  });
  it('uses verified Linux clock ticks and handles parentheses/spaces in process names', () => {
    const result = parseLinuxProcessSample('Name:\tprivate process\nVmRSS:\t12345 kB\n', stat(), '250\n');
    expect(result).toEqual({ supported: true, rssBytes: 12_641_280, privateBytes: null, cpuMs: 1200 });
    expect(JSON.stringify(result)).not.toMatch(/private process|Name|123 \(/);
  });
  it('rejects malformed Linux input and unknown clock rates without guessing', () => {
    for (const clock of ['', 'private-error', '0', '-100', '100.5', '100 extra', '1000001']) expect(parseLinuxProcessSample('VmRSS: 10 kB\n', stat(), clock)).toEqual(unavailable);
    for (const status of ['', 'VmRSS: unknown kB\n', 'VmRSS: -1 kB\n', 'VmRSS: 1 kB\nVmRSS: 2 kB\n', 'VmRSS: 999999999999999999999999999999 kB\n', 'x'.repeat(16_385)]) {
      expect(parseLinuxProcessSample(status, stat(), '100')).toEqual(unavailable);
    }
    for (const processStat of ['private-error', '123 (not closed', stat('-1'), stat('1.2'), stat('999999999999999999999999999999')]) expect(parseLinuxProcessSample('VmRSS: 10 kB\n', processStat, '100')).toEqual(unavailable);
  });
  it('rejects nonnumeric, group, fractional and oversized PIDs before any OS call', async () => {
    const values: unknown[] = [undefined, null, '123', '1; private-command', 0, -1, 1.5, NaN, Infinity, 2_147_483_648, {}, []];
    for (const value of values) expect(await sampleOwnedProcess(value as number)).toEqual(unavailable);
  });
  it('copies only bounded pool counters and rejects impossible counts', () => {
    expect(readPoolSnapshot({ totalCount: 4, idleCount: 2, waitingCount: 3, privateConnection: 'private-secret' } as never)).toEqual({ totalCount: 4, idleCount: 2, waitingCount: 3 });
    for (const value of [-1, NaN, Infinity, 1.5, 1_000_001]) expect(readPoolSnapshot({ totalCount: value, idleCount: 0, waitingCount: 0 })).toBeNull();
    expect(readPoolSnapshot({ totalCount: 1, idleCount: 2, waitingCount: 0 })).toBeNull();
  });
});
