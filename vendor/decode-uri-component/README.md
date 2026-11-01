# Local CommonJS decoder compatibility package

This private package carries the **unchanged decoding algorithm** from the official
`decode-uri-component` **0.5.0** release. It exists because oneshot's pinned Privy
dependency tree includes CommonJS `query-string` 7.1.3, which expects
`require('decode-uri-component')` to return a callable function. Upstream 0.5.0 is
an ES module. The local version is **0.5.0+oneshot.cjs.1**; it is not an official
upstream release and must not be published.

Upstream 0.5.0 replaces the recursive fallback decoder implicated in
[GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).
The [upstream release](https://github.com/SamVerschueren/decode-uri-component/releases/tag/v0.5.0)
and MIT license permit this local adaptation. The original copyright and license
are reproduced verbatim in `LICENSE`.

## Exact source and compatibility delta

Sources retrieved on **22 October 2026**:

- [Official v0.5.0 index.js](https://raw.githubusercontent.com/SamVerschueren/decode-uri-component/v0.5.0/index.js)
- [Official v0.5.0 license](https://raw.githubusercontent.com/SamVerschueren/decode-uri-component/v0.5.0/license)
- [Official v0.5.0 test vectors](https://raw.githubusercontent.com/SamVerschueren/decode-uri-component/v0.5.0/test.js)

The entire source change is this export declaration, with the file renamed to
`index.cjs`. There are no dependency additions or algorithm changes:

```diff
-export default function decodeUriComponent(encodedURI) {
+module.exports = function decodeUriComponent(encodedURI) {
```

The local package manifest selects CommonJS and this entry point. SHA-256 hashes
refer to the exact UTF-8 bytes, including original LF newlines:

| Artifact | SHA-256 |
| --- | --- |
| Upstream `index.js` | `9401353df38f8010ad7035fe8d666bce6a4902bc1cff809afc4ab23fa2e0bdaa` |
| Local `index.cjs` | `684ba79779327ba789733a3a563050370a928a57eb7dd33d19b346f43b32cbb7` |
| Unmodified MIT `LICENSE` | `ed7a9a0f74e43951b2520efe1a4349cb9ed5f3dff0b0f268e2e51a4d38df7ea4` |
| Upstream `test.js` used for vectors | `7379b41fa223c4dec2c1459b8a1ee43c713eca16d28b16e19c36fb046bceab8c` |

## Behavior and verification

`packages/evm/test/decoder-compat.test.ts` verifies the callable CommonJS export,
the source hash after reversing only the export adaptation, upstream valid and
malformed UTF-8/percent vectors, invalid argument types, and long malformed runs
in a child process with a deadline. It also evaluates the installed `query-string`
7.1.3 CommonJS module with this decoder supplied through a test-local `require`;
the test does not alter dependency resolution or the global module cache.

Literal `+` is preserved by upstream 0.5.0. In contrast, 0.2.2 converted it to a
space. `query-string` 7.1.3 already converts literal `+` to spaces in query fields
before decoding, so ordinary query parsing retains that behavior. Parser paths
that decode a value twice, such as an encoded comma-separated array, now preserve
a newly decoded literal `+` on the second pass instead of changing it to a space.
Its optional
`parseFragmentIdentifier` path directly invokes the decoder; a literal `+` in a
fragment now remains `+`, following upstream 0.5.0. This behavior is documented and
tested rather than changed through an additional compatibility shim. Malformed
byte sequences follow the upstream 0.5.0 output, including its percent-separator
regression fix.

Dependency override and lockfile activation are separate integration steps. This
directory alone does not prove that every installed decoder resolves here. After
activation, inspect the installed tree, rerun the compatibility tests and build,
and inspect a fresh audit. Remove the local package once the supported Privy
dependency graph supplies a compatible upstream fix. Do not replace `query-string`
with an unrelated major release merely to change audit output.

Activation was verified on 22 October 2026: the root `$decode-uri-component`
override resolves the installed CommonJS consumer to this directory, all 86
compatibility checks pass and the resolved dependency graph's fresh npm audit
reports zero advisories. This is dated verification, not a promise about future
advisories; repeat these checks after dependency changes.
