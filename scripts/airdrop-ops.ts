import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Address, Hex } from 'viem';
import { airdropService } from '../apps/api/lib/server/airdrop-service';
import { database } from '../apps/api/lib/server/store';
import {
  airdropOpsExportMerkle,
  airdropOpsOpenClaims,
  airdropOpsSetState,
  airdropOpsStatus,
  airdropOpsSweepPlan,
} from './lib/airdrop-ops';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
  console.log(
    'Usage:\n' +
      '  npm run airdrop:ops -- status [--env-file PATH]\n' +
      '  npm run airdrop:ops -- open [--project-x-id ID] [--project-handle HANDLE] [--announcement-post-id ID] [--opens-at ISO] [--closes-at ISO] [--snapshot-cutoff ISO] [--live-lz true|false] [--actor NAME]\n' +
      '  npm run airdrop:ops -- close [--actor NAME]\n' +
      '  npm run airdrop:ops -- export-merkle --chain-id ID --distributor ADDR [--publish] [--output .local/qa/NAME.json] [--actor NAME]\n' +
      '  npm run airdrop:ops -- open-claims --confirm-onchain-root HASH [--rpc-url URL] [--claim-deadline ISO] [--actor NAME]\n' +
      '  npm run airdrop:ops -- sweep-plan --chain-id ID --distributor ADDR --recipient ADDR\n',
  );
  process.exit(0);
}

const subcommand = args[0]!;
const flags = new Map<string, string>();
const booleans = new Set<string>();

for (let i = 1; i < args.length; i++) {
  const token = args[i]!;
  if (!token.startsWith('--')) {
    throw new Error(`Unexpected argument: ${token}`);
  }
  if (token === '--publish') {
    booleans.add(token);
    continue;
  }
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${token}`);
  }
  flags.set(token, value);
  i++;
}

if (flags.has('--env-file')) {
  loadEnvFile(path.resolve(process.cwd(), flags.get('--env-file')!));
}

const actor = flags.get('--actor') || 'cli:airdrop-ops';

try {
  if (subcommand === 'status') {
    console.log(JSON.stringify(await airdropOpsStatus(airdropService), null, 2));
  } else if (subcommand === 'open' || subcommand === 'close') {
    let liveLayerZeroLookup: boolean | undefined;
    if (flags.has('--live-lz')) {
      const val = flags.get('--live-lz')!;
      if (val !== 'true' && val !== 'false') {
        throw new Error('Invalid --live-lz value (expected true or false).');
      }
      liveLayerZeroLookup = val === 'true';
    }
    const updated = await airdropOpsSetState(airdropService, {
      state: subcommand === 'open' ? 'open' : 'closed',
      actor,
      overrides: {
        ...(flags.has('--project-x-id') ? { projectXId: flags.get('--project-x-id')! } : {}),
        ...(flags.has('--project-handle') ? { projectHandle: flags.get('--project-handle')!.replace(/^@/, '') } : {}),
        ...(flags.has('--announcement-post-id') ? { announcementPostId: flags.get('--announcement-post-id')! } : {}),
        ...(flags.has('--opens-at') ? { opensAt: flags.get('--opens-at')! } : {}),
        ...(flags.has('--closes-at') ? { closesAt: flags.get('--closes-at')! } : {}),
        ...(flags.has('--snapshot-cutoff') ? { snapshotCutoffAt: flags.get('--snapshot-cutoff')! } : {}),
        ...(liveLayerZeroLookup !== undefined ? { liveLayerZeroLookup } : {}),
      },
    });
    console.log(JSON.stringify(updated, null, 2));
  } else if (subcommand === 'export-merkle') {
    const chainIdRaw = flags.get('--chain-id');
    const distributor = flags.get('--distributor');
    if (!chainIdRaw || !/^[1-9]\d*$/.test(chainIdRaw)) throw new Error('Valid --chain-id is required.');
    if (!distributor || !/^0x[\da-fA-F]{40}$/.test(distributor)) throw new Error('Valid --distributor address is required.');

    const exported = await airdropOpsExportMerkle(airdropService, {
      chainId: Number(chainIdRaw),
      distributor: distributor as Address,
      publish: booleans.has('--publish'),
      actor,
    });

    if (flags.has('--output')) {
      const qaDir = path.join(root, '.local', 'qa');
      await mkdir(qaDir, { recursive: true });
      const target = path.resolve(root, flags.get('--output')!);
      const realQa = await realpath(qaDir);
      const realParent = await realpath(path.dirname(target));
      const rel = path.relative(realQa, realParent);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error('QA_OUTPUT_DIRECTORY_REQUIRED');
      }
      await writeFile(path.join(realParent, path.basename(target)), JSON.stringify(exported, null, 2) + '\n', 'utf8');
    }

    console.log(
      JSON.stringify(
        {
          root: exported.root,
          chainId: exported.chainId,
          distributor: exported.distributor,
          recipientCount: exported.recipientCount,
          totalCommittedRaw: exported.totalCommittedRaw,
          published: exported.published,
          activateTransaction: exported.activateTransaction,
          ...(flags.has('--output') ? { output: flags.get('--output') } : {}),
        },
        null,
        2,
      ),
    );
  } else if (subcommand === 'open-claims') {
    const rootHash = flags.get('--confirm-onchain-root');
    if (!rootHash || !/^0x[\da-fA-F]{64}$/.test(rootHash)) {
      throw new Error('Valid 32-byte --confirm-onchain-root is required.');
    }
    const res = await airdropOpsOpenClaims(airdropService, {
      confirmOnchainRoot: rootHash as Hex,
      actor,
      ...(flags.has('--rpc-url') ? { rpcUrl: flags.get('--rpc-url')! } : {}),
      ...(flags.has('--claim-deadline') ? { claimDeadline: flags.get('--claim-deadline')! } : {}),
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (subcommand === 'sweep-plan') {
    const chainIdRaw = flags.get('--chain-id');
    const distributor = flags.get('--distributor');
    const recipient = flags.get('--recipient');
    if (!chainIdRaw || !/^[1-9]\d*$/.test(chainIdRaw)) throw new Error('Valid --chain-id is required.');
    if (!distributor || !/^0x[\da-fA-F]{40}$/.test(distributor)) throw new Error('Valid --distributor address is required.');
    if (!recipient || !/^0x[\da-fA-F]{40}$/.test(recipient)) throw new Error('Valid --recipient address is required.');
    console.log(
      JSON.stringify(
        airdropOpsSweepPlan({
          chainId: Number(chainIdRaw),
          distributor: distributor as Address,
          recipient: recipient as Address,
        }),
        null,
        2,
      ),
    );
  } else {
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }
} finally {
  await database()?.end();
}
