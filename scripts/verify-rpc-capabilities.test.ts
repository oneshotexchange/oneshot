import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseRpcCapabilityArguments, readRpcCapabilityPlan, verifyConfiguredCapabilities } from './verify-rpc-capabilities';

describe('explicit capability CLI inputs', () => {
  it('keeps the ordinary network identity command separate', () => {
    expect(parseRpcCapabilityArguments(['--help'])).toEqual({ help: true });
    expect(parseRpcCapabilityArguments(['--plan', 'known-deployment.json'])).toEqual({ help: false, planPath: 'known-deployment.json' });
    expect(parseRpcCapabilityArguments(['--env-file', 'network.env', '--plan', 'known-deployment.json']))
      .toEqual({ help: false, planPath: 'known-deployment.json', envPath: 'network.env' });
  });
  it.each([[], ['--env-file', 'network.env'], ['--plan'], ['--plan', '--env-file'], ['--plan', 'a', '--plan', 'b'],
    ['--help', '--plan', 'a'], ['--enable', 'true'], ['--plan', 'a', '--env-file', 'b', '--force', 'true']].map(args => ({ args })))('rejects unsupported arguments $args', ({ args }) => {
    expect(() => parseRpcCapabilityArguments(args)).toThrow('INVALID_ARGUMENTS');
  });
  it('bounds plan file bytes and rejects unreadable JSON/UTF-8', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneshot-capability-plan-'));
    try {
      const path = join(directory, 'plan.json');
      await writeFile(path, '{"known":true}');
      expect(await readRpcCapabilityPlan(path)).toEqual({ known: true });
      await writeFile(path, 'x'.repeat(65_537));
      await expect(readRpcCapabilityPlan(path)).rejects.toThrow('CAPABILITY_PLAN_UNAVAILABLE');
      await writeFile(path, '{invalid');
      await expect(readRpcCapabilityPlan(path)).rejects.toThrow();
      await writeFile(path, Buffer.from([0xff]));
      await expect(readRpcCapabilityPlan(path)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not contact a network for a malformed explicit plan or invalid environment', async () => {
    const fetcher = vi.fn();
    expect(await verifyConfiguredCapabilities({}, {}, { fetch: fetcher })).toMatchObject({ status: 'failed', code: 'CAPABILITY_PLAN_INVALID' });
    await expect(verifyConfiguredCapabilities({ ONESHOT_NETWORK: 'unknown' }, {}, { fetch: fetcher })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
