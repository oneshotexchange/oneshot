# Aptos protobuf provenance

The four files under `aptos/` are unmodified generated TypeScript sources from
[`aptos-labs/aptos-core@16808c72122fa780cda3de5447f7d5393dd29f72`](https://github.com/aptos-labs/aptos-core/tree/16808c72122fa780cda3de5447f7d5393dd29f72/protos/typescript/src/aptos), dated May 1, 2025:

- `indexer/v1/raw_data.ts`
- `indexer/v1/filter.ts`
- `transaction/v1/transaction.ts`
- `util/timestamp/timestamp.ts`

The repository license at this exact revision is Apache-2.0, retained in
`APTOS-LICENSE.txt`. Copyright belongs to the upstream contributors. The files
are not asserted to be authored by B20. Preserve this notice and upstream license.

This revision already provides `transactionFilter` and `processedRange`.
It is deliberately pinned instead of copying the current repository's
Innovation-Enabling Source Code License sources or relying on the published
`@aptos-labs/aptos-protos@1.1.5`, whose stream definitions omit these two fields.
Optional fields added by newer servers are skipped by protobuf decoding;
B20 consumes transaction versions, hashes, timestamps and JSON event data.

Dependencies used by generated code: `@grpc/grpc-js`, `protobufjs`, `long`.
No regeneration occurs during install/build. A source update requires reviewed
wire compatibility, provenance and license verification plus the stream tests.
