# Read-only RPC capability evidence

`verify:rpc-capabilities` checks a bounded set of known deployment witnesses. It does not select a network, deploy contracts, enable a service or authorize transactions. Prepare the plan from independently verified network/deployment records, rather than constructing expectations from the endpoint under test.

```sh
npm run verify:rpc-capabilities -- --plan PATH_TO_PLAN.json --env-file PATH_TO_NETWORK.env
```

The environment file is optional; otherwise the command reads the process environment using the existing network configuration validator. Keep credentials outside version control. The plan file is required and limited to 64 KiB. Unknown fields and duplicate contract addresses are rejected.

## Plan

The runtime-validated TypeScript shape is `RpcCapabilityPlan` in [rpc-capabilities.ts](src/rpc-capabilities.ts):

| Field | Required value |
| --- | --- |
| `chainId` | Positive safe integer matching the independently known network and configuration. |
| `genesisHash` | Nonzero 32-byte genesis hash matching the independently known network. |
| `checkpoint` | Optional `{ number, hash }`: decimal block number string and nonzero 32-byte canonical block hash. Required with `expectedLog`. |
| `contracts` | One to four `{ address, codeHash, call }` entries. Each nonzero address must be unique. `codeHash` is the Keccak-256 hash of expected deployed runtime bytecode. |
| `contracts[].call` | `{ data, expectedResult }`: nonempty selector/calldata and an exact nonempty ABI-encoded return value, in complete 32-byte words. Choose a bounded read with a known result at the checkpoint. |
| `expectedLog` | Optional `{ address, transactionHash, logIndex, topics, data }`. The address must be among the selected contracts; log index is a decimal string. Use an independently recorded event at the supplied checkpoint. |

All hashes, addresses, calldata, return bytes, topics and event data use `0x` hexadecimal strings. Hashes and addresses have their usual fixed widths. Empty event data and an empty topics array are allowed. A known matching event is required for an overall `passed` report; accepting a log filter or returning an empty array cannot establish that evidence.

## Checks and limits

The probe verifies configured chain/genesis identity, pins one canonical checkpoint, checks runtime bytecode at that block number and compares exact call returns using EIP-1898 block-hash selection with `requireCanonical`. It requests logs with an EIP-234 block-hash filter and an address array, validates their ordering and block identity, and compares the supplied event witness. It also requires clear missing-block rejection for zero-hash call/log negative controls and rechecks the canonical checkpoint after the reads. Malformed, unrelated and ambiguous provider errors fail the checks. Conservative rejection classification may require investigation for a provider with different error wording.

The CLI has a 30-second overall deadline, at most 48 physical RPC requests and no retries. The library accepts an explicit overall deadline between one and 60 seconds. Existing per-request timeout and response-size bounds also apply. No write or signing methods are sent. The report excludes endpoint URLs, remote messages and error data.

## Reading the result

- `passed` means the selected witnesses and negative controls matched during this probe.
- `inconclusive` means the positive known log witness was not supplied. Available observations remain in the report.
- `failed` identifies a sanitized error code and the check that failed.

The CLI exits unsuccessfully for both `inconclusive` and `failed`. Every report includes `executionEnabled: false`, even when it passes. Do not use this result to flip public service flags.

The report does **not** verify contract safety, hash-based code selection, complete logs, orphan canonicality, gas estimation, wallet signing, transaction submission/receipts, finality, native precision, NFT readiness or AMM readiness. Contract code is selected by checkpoint **number**; the canonical recheck does not prove the provider implemented hash selection for that read. A nonconforming provider can still fabricate internally consistent responses. Official network sources, independently verified deployments, protocol compatibility, transaction rehearsals and operational checks remain separate requirements.
