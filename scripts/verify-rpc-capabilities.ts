/** Explicit read-only preflight. Never deploys, signs, submits or enables a service. */
import { open } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { networkConfig } from '../packages/evm/src/config';
import { probeRpcCapabilities, type RpcCapabilityOptions } from '../packages/evm/src/rpc-capabilities';
import { RpcError, type RpcProviderLabel } from '../packages/evm/src/rpc';

export function parseRpcCapabilityArguments(args: string[]): { help: true } | { help: false; planPath: string; envPath?: string } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = new Map<string, string>();
  if (args.length !== 2 && args.length !== 4) throw new Error('INVALID_ARGUMENTS');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--plan', '--env-file'].includes(args[i]) || values.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    values.set(args[i], args[i + 1]);
  }
  const planPath = values.get('--plan');
  if (!planPath) throw new Error('INVALID_ARGUMENTS');
  return { help: false, planPath, ...(values.has('--env-file') ? { envPath: values.get('--env-file')! } : {}) };
}

export async function verifyConfiguredCapabilities(env: Record<string, string | undefined>, plan: unknown, options: RpcCapabilityOptions = {}) {
  let config: ReturnType<typeof networkConfig>;
  try { config = networkConfig(env); } catch { throw new RpcError('CONFIG_INVALID'); }
  return probeRpcCapabilities(config, plan, { ...options, provider: (env.ONESHOT_RPC_PROVIDER || 'custom') as RpcProviderLabel });
}

export async function readRpcCapabilityPlan(path: string): Promise<unknown> {
  const file = await open(resolve(path), 'r');
  try {
    // Read through one opened descriptor with a fixed allocation, including when
    // a file grows or is replaced while this command is running.
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    for (;;) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      size += read.bytesRead;
      if (size > 65_536) throw new Error('CAPABILITY_PLAN_UNAVAILABLE');
      if (!read.bytesRead) break;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { await file.close(); }
}

async function main(args: string[]) {
  let parsed: ReturnType<typeof parseRpcCapabilityArguments>;
  const failed = (code: string) => { console.error(JSON.stringify({ status: 'failed', code, readOnly: true, executionEnabled: false })); process.exitCode = 1; };
  try { parsed = parseRpcCapabilityArguments(args); } catch { failed('INVALID_ARGUMENTS'); return; }
  if (parsed.help) {
    console.log('Usage: npm run verify:rpc-capabilities -- --plan PATH [--env-file PATH]\nExplicit JSON plan: chainId, genesisHash, 1–4 contracts with address/codeHash/call.data/call.expectedResult. Optionally supply checkpoint {number: decimal string, hash} and expectedLog {address, transactionHash, logIndex: decimal string, topics, data}. A positive known event is required for a passed log check. Reads at most 64 KiB of plan data; at most 48 RPC requests and 30 seconds total. A pass does not establish NFT/AMM readiness, finality, native precision, gas estimation or transaction execution. No signing or broadcasting.');
    return;
  }
  if (parsed.envPath) { try { loadEnvFile(resolve(parsed.envPath)); } catch { failed('ENV_FILE_UNAVAILABLE'); return; } }
  let plan: unknown;
  try { plan = await readRpcCapabilityPlan(parsed.planPath); } catch { failed('CAPABILITY_PLAN_UNAVAILABLE'); return; }
  try {
    const report = await verifyConfiguredCapabilities(process.env, plan);
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) { failed(error instanceof RpcError ? error.code : 'CAPABILITY_UNAVAILABLE'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main(process.argv.slice(2));
