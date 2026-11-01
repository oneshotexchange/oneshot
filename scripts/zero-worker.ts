import { networkConfig, publicNetwork } from '@oneshot/evm';

// The old Aptos worker is reference code. No environment flags can silently start it here.
const config = networkConfig(process.env);
console.error(JSON.stringify({ service: 'oneshot-zero-indexer', status: 'unavailable', network: publicNetwork(config), reason: 'The Zero log indexer and deployment manifest are not integrated yet. The legacy Aptos worker was not started.' }, null, 2));
process.exitCode = 1;
