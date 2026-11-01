import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';

export type OwnedProcessSample = {
  supported: boolean;
  rssBytes: number | null;
  privateBytes: number | null;
  cpuMs: number | null;
};
const unsupported = (): OwnedProcessSample => ({ supported: false, rssBytes: null, privateBytes: null, cpuMs: null });
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const integer = (value: unknown): value is number => validNumber(value) && Number.isSafeInteger(value);
const maximumOutput = 16_384;
const boundedText = (value: unknown): value is string => typeof value === 'string' && value.length <= maximumOutput;

export function parseWindowsProcessSample(text: unknown): OwnedProcessSample {
  if (!boundedText(text)) return unsupported();
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !integer(value.WorkingSet64) || !integer(value.PrivateMemorySize64) || !validNumber(value.CpuMilliseconds)) return unsupported();
    return { supported: true, rssBytes: value.WorkingSet64, privateBytes: value.PrivateMemorySize64, cpuMs: value.CpuMilliseconds };
  } catch { return unsupported(); }
}

/** Linux reports resident memory; private bytes are deliberately unavailable. */
export function parseLinuxProcessSample(status: unknown, stat: unknown, clockTicks: unknown): OwnedProcessSample {
  if (!boundedText(status) || !boundedText(stat) || !boundedText(clockTicks)) return unsupported();
  const ticksText = /^([1-9]\d{0,6})\s*$/.exec(clockTicks);
  if (!ticksText) return unsupported();
  const ticksPerSecond = Number(ticksText[1]);
  if (ticksPerSecond > 1_000_000) return unsupported();
  const rssMatches = [...status.matchAll(/^VmRSS:\s+(\d+) kB\s*$/gm)];
  if (rssMatches.length !== 1 || !/^\d+ \(/.test(stat)) return unsupported();
  // comm can contain spaces and parentheses. Fields after its final closing
  // parenthesis start at field 3; utime/stime are fields 14 and 15.
  const closing = stat.lastIndexOf(') ');
  if (closing < 0) return unsupported();
  const fields = stat.slice(closing + 2).trim().split(/\s+/);
  if (fields.length < 22 || !/^\d+$/.test(fields[11]) || !/^\d+$/.test(fields[12])) return unsupported();
  const rssBytes = Number(rssMatches[0][1]) * 1024;
  const userTicks = Number(fields[11]), systemTicks = Number(fields[12]);
  const totalTicks = userTicks + systemTicks;
  const cpuMs = totalTicks / ticksPerSecond * 1000;
  if (!integer(rssBytes) || !integer(userTicks) || !integer(systemTicks) || !integer(totalTicks) || !validNumber(cpuMs)) return unsupported();
  return { supported: true, rssBytes, privateBytes: null, cpuMs };
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 2500, maxBuffer: maximumOutput, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(new Error('PROCESS_SAMPLE_UNAVAILABLE'));
      else resolve(stdout);
    });
  });
}
async function readProcFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(maximumOutput);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === maximumOutput) throw new Error('PROCESS_SAMPLE_UNAVAILABLE');
    return buffer.toString('utf8', 0, bytesRead);
  } finally { await handle.close(); }
}

/** Read only a caller-owned child's exact PID. This helper never discovers or
 * terminates processes. Missing permissions/platform support produce nulls.
 */
export async function sampleOwnedProcess(pid: number): Promise<OwnedProcessSample> {
  // Enforce a numeric PID before interpolating it into the fixed PowerShell
  // expression or /proc path. Zero/process-group identifiers are never accepted.
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return unsupported();
  try {
    if (process.platform === 'win32') {
      const command = `$ownedProcess = Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{WorkingSet64=$ownedProcess.WorkingSet64;PrivateMemorySize64=$ownedProcess.PrivateMemorySize64;CpuMilliseconds=$ownedProcess.TotalProcessorTime.TotalMilliseconds} | ConvertTo-Json -Compress`;
      return parseWindowsProcessSample(await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]));
    }
    if (process.platform === 'linux') {
      const [status, stat, ticks] = await Promise.all([
        readProcFile(`/proc/${pid}/status`), readProcFile(`/proc/${pid}/stat`), runFile('getconf', ['CLK_TCK']),
      ]);
      return parseLinuxProcessSample(status, stat, ticks);
    }
  } catch { /* Raw errors, command output and paths never enter the report. */ }
  return unsupported();
}

export function readPoolSnapshot(pool: { totalCount: number; idleCount: number; waitingCount: number }) {
  const { totalCount, idleCount, waitingCount } = pool;
  if (![totalCount, idleCount, waitingCount].every(value => integer(value) && value <= 1_000_000) || idleCount > totalCount) return null;
  return { totalCount, idleCount, waitingCount };
}
