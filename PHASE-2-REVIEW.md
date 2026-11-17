# Phase 2: owner review

Started 17 November 2026. Review target: `codex/phase-one` at `bd848b8`, including the Base Sepolia milestone `a9f65cc`. The owner said home/navigation and token creation look good and authorized final agent judgment for those two screens. Both are accepted for this milestone's preview UI review. Other owner decisions and real-account/transaction acceptance remain pending; automated checks and agent inspection alone do not establish those approvals.

The subsequent [NFT V3 build](NFT-MARKETPLACE-V3.md) adds item/collection offers, refund balances and atomic cart checkout. Agent inspection passed on desktop/mobile, including exact review amounts, wallet changes, error recovery and the related public pages. Owner acceptance of these new NFT screens remains pending. Its separate signing-disabled [sample NFT preview](http://127.0.0.1:19393/nfts/0x0000000000000000000000000000000000000004?deployment=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd) is available while its local process runs; it has no real accounts, funds or deployment evidence. Earlier home/token approval does not extend to live NFT settlement.

## Open the review preview

[Local review preview](http://127.0.0.1:18390/)

This separate loopback preview uses sample collections, markets, balances, accounts and quotes. Its review controls can select a sample signed-in account, an account without a wallet, and unavailable/error responses. Signing is disabled. It neither deploys contracts nor connects to the hosted API. Account copies in the preview are temporary in-memory fixtures; real PostgreSQL persistence was checked separately. Browser drafts stay in this preview origin on the current device. Use sample terms, not credentials or valuable content.

The preview is available on this computer while its local process is running. Its configuration and logs are ignored under `.local/qa/phase-two-preview`; they are not public application screens or a deployment artifact. The last production builds and automated results are recorded in [BASE-SEPOLIA.md](BASE-SEPOLIA.md).

## Review sequence

| Area | Open | What the owner should check | Acceptance status |
| --- | --- | --- | --- |
| Overall experience | `/` and navigation | Branding, hierarchy, clarity, theme and mobile navigation. Can a creator or collector find the next task? | Preview UI approved: owner feedback and delegated agent judgment |
| Token drafts | `/tokens/new` | Enter terms; save and resume a device draft; export/restore. Use the sample account without a wallet to save an account copy, copy it into the editor, review an update and archive it. Check preservation of current work and network/valuation labels. | Preview UI approved: owner feedback and delegated agent judgment. Real account acceptance remains pending |
| Token discovery and terminal | `/tokens` and the sample market | Search/watchlist, exact amounts, fees, sampled chart history, separate pool/oneshot trades, holder scope, loading and retry messages. Synthetic quotes are for review only. | Pending |
| NFT creation and discovery | `/nfts/new`, `/nfts`, sample collection/item | Artwork form, mint schedules, royalties, supply, draft backup, asking prices versus sales totals and checkout availability. An unavailable transaction should give a useful next action. | Pending |
| Portfolio and activity | `/portfolio`, `/activity` | Wallet selection, balance precision, test-network scope and distinction between no activity and failed loads. | Pending |
| Account and settings | `/settings`, wallet dialog | Clear sign-in/link-wallet choices, customer preferences and no public infrastructure controls. Use the sample review accounts. | Pending |
| Mobile and failures | Narrow browser window; review controls | Navigation, readable amounts, button/field overflow; retry after error or unreadable responses; account switches preserve the open draft. | Pending |

Send further feedback as `screen → change → reason`, or approve a named area with any notes. Home/navigation and token creation no longer require another approval for this unchanged preview milestone. The remaining areas can be reviewed next.

## Agent inspection after the first approval

On 17 November, the remaining sample-preview screens were checked without changing product code:

- NFT discovery, collection details and creation: test-network/draft labels, exact asking price and resale totals, unavailable-checkout retry, royalties and metadata locking. The creation page was also inspected at 390 × 844.
- Token discovery and the sample terminal: exact supply/valuation text, separate pool and oneshot volume, sampled chart history, unknown external traders and separate trade-quote guidance.
- Portfolio: public wallet lookup, the exact `90071992.54740993` sample token balance, checkpoint scope and explicit lack of native cash values or P&L. Settings were inspected for customer-facing scope and availability guidance.
- Wallet dialog: network/account identity, linking and sign-out controls, and the statement that connecting does not send a transaction. This used a sample wallet and did not exercise real Privy sign-in.

No new blocking UI issue was observed in this pass. These are agent inspection results, not owner approval of the remaining screens or evidence of live settlement. Earlier failure-state and draft-preservation checks remain recorded in [BASE-SEPOLIA.md](BASE-SEPOLIA.md). The approval screenshot is saved in ignored `.local/qa/phase-two-preview/approved-home.jpg`.

## Reserved for a deployed test-network review

Real wallet sign-in and cross-device account persistence; Base chain/provider identity; deployed code and immutable contract terms; NFT create/open/mint/list/buy/cancel/claim; token launch/approve/buy/sell/claim; submitted-transaction recovery; live worker/reorg behavior and cost/performance checks. The sample preview cannot approve these. No Base deployment or current-bytecode Anvil replay has been verified in this checkout. See the release boundaries in [BASE-SEPOLIA.md](BASE-SEPOLIA.md).

## Decision log

| Date | Area | Owner decision | Follow-up |
| --- | --- | --- | --- |
| 2026-11-17 | Start Phase 2 | Owner requested review to begin. Product acceptance is pending. | Open the preview and collect the first screen-specific feedback. |
| 2026-11-17 | Home/navigation and token creation | Owner said the screens look good and delegated approval if the agent judged them good enough. Agent approves the two preview interfaces for this milestone, supported by the recorded draft/UI checks. | Preserve this accepted baseline; continue the remaining screen review. Actual account, Base transaction and release acceptance remain pending. |

The broader Phase 1 backlog remains open. Starting Phase 2 reviews the completed milestone and does not mark the full marketplace, social trading platform or future Zero integration complete.
