# Local CommonJS decoder compatibility package

This private package carries the unchanged decoding algorithm from the official `decode-uri-component` **0.5.1** release. The pinned Privy dependency graph includes CommonJS `query-string` 7.1.3, which expects `require('decode-uri-component')` to return a callable function. Upstream is an ES module. The local version is **0.5.1+oneshot.cjs.1**; it is not an official upstream release and must not be published.

Upstream 0.5.1 fixes the quadratic distinct-percent-run replacements reported in [GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f). Its single-pass replacement never rescans newly decoded output. The earlier recursive-decoder fix is retained. This update preserves the CommonJS consumer contract rather than downgrading Privy or replacing query-string with an unrelated major release.

## Source and compatibility delta

Sources retrieved on **17 November 2026**:

- [Official v0.5.1 index.js](https://github.com/SamVerschueren/decode-uri-component/blob/v0.5.1/index.js)
- [Official v0.5.1 license](https://github.com/SamVerschueren/decode-uri-component/blob/v0.5.1/license)
- [Official v0.5.1 test vectors](https://github.com/SamVerschueren/decode-uri-component/blob/v0.5.1/test.js)

The complete adaptation is the export declaration and filename. No decoding algorithm or dependency is added:

```diff
-export default function decodeUriComponent(encodedURI) {
+module.exports = function decodeUriComponent(encodedURI) {
```

SHA-256 hashes refer to the exact UTF-8 bytes with original LF newlines:

| Artifact | SHA-256 |
| --- | --- |
| Upstream index.js | `6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0` |
| Local index.cjs | `e82696ecdf0ee2c25bd90169cc7915e552d2ccb82a5006c55bc17aecdb55b919` |
| Unmodified MIT LICENSE | `ed7a9a0f74e43951b2520efe1a4349cb9ed5f3dff0b0f268e2e51a4d38df7ea4` |
| Upstream test.js reference | `acb81f2173ef208c173465fa98f054923c1ca78b7aa09e1493ee5936b963acba` |

The original Sam Verschueren copyright and MIT notice remain unchanged in LICENSE.

## Verification and behavior

`packages/evm/test/decoder-compat.test.ts` verifies the callable CommonJS export, source hash after reversing only the export adaptation, valid/malformed UTF-8 and percent vectors, argument types, and the installed query-string 7.1.3 consumer. It includes isolated child-process deadlines for long malformed runs and 30,000 distinct percent runs; a blocked decoder cannot hang the test worker.

Literal `+` remains literal in this decoder. Query-string converts query plus signs to spaces before decoding, preserving normal query behavior. Encoded comma-array values and fragment parsing retain the upstream documented literal-plus behavior. Each call decodes one level only, including a malformed tail: `%25C2%zz` remains `%C2%zz`.

The root file dependency and `$decode-uri-component` override activate this package. Verify the installed dependency tree after lockfile reification, then run the compatibility tests, complete app tests and production builds. Preserve the local adapter until the supported wallet SDK graph supplies a compatible upstream module. An npm audit alone does not establish application reachability or a complete security assessment.
