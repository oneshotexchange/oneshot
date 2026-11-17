# Phase 2: owner review

Started 17 November 2026. Review target: `codex/phase-one` at `bd848b8`, including the Base Sepolia milestone `a9f65cc`. Owner decisions are pending; automated checks and agent inspection do not count as owner approval.

## Open the review preview

[Local review preview](http://127.0.0.1:18390/)

This separate loopback preview uses sample collections, markets, balances, accounts and quotes. Its review controls can select a sample signed-in account, an account without a wallet, and unavailable/error responses. Signing is disabled. It neither deploys contracts nor connects to the hosted API. Account copies in the preview are temporary in-memory fixtures; real PostgreSQL persistence was checked separately. Browser drafts stay in this preview origin on the current device. Use sample terms, not credentials or valuable content.

The preview is available on this computer while its local process is running. Its configuration and logs are ignored under `.local/qa/phase-two-preview`; they are not public application screens or a deployment artifact. The last production builds and automated results are recorded in [BASE-SEPOLIA.md](BASE-SEPOLIA.md).

## Review sequence

| Area | Open | What the owner should check | Owner status |
| --- | --- | --- | --- |
| Overall experience | `/` and navigation | Branding, hierarchy, clarity, theme and mobile navigation. Can a creator or collector find the next task? | Pending |
| Token drafts | `/tokens/new` | Enter terms; save and resume a device draft; export/restore. Use the sample account without a wallet to save an account copy, copy it into the editor, review an update and archive it. Check preservation of current work and network/valuation labels. | Pending |
| Token discovery and terminal | `/tokens` and the sample market | Search/watchlist, exact amounts, fees, sampled chart history, separate pool/oneshot trades, holder scope, loading and retry messages. Synthetic quotes are for review only. | Pending |
| NFT creation and discovery | `/nfts/new`, `/nfts`, sample collection/item | Artwork form, mint schedules, royalties, supply, draft backup, asking prices versus sales totals and checkout availability. An unavailable transaction should give a useful next action. | Pending |
| Portfolio and activity | `/portfolio`, `/activity` | Wallet selection, balance precision, test-network scope and distinction between no activity and failed loads. | Pending |
| Account and settings | `/settings`, wallet dialog | Clear sign-in/link-wallet choices, customer preferences and no public infrastructure controls. Use the sample review accounts. | Pending |
| Mobile and failures | Narrow browser window; review controls | Navigation, readable amounts, button/field overflow; retry after error or unreadable responses; account switches preserve the open draft. | Pending |

Send feedback as `screen → change → reason`, or approve a named area with any notes. A useful first pass is home/navigation and token creation; the remaining areas can follow after those decisions.

## Reserved for a deployed test-network review

Real wallet sign-in and cross-device account persistence; Base chain/provider identity; deployed code and immutable contract terms; NFT create/open/mint/list/buy/cancel/claim; token launch/approve/buy/sell/claim; submitted-transaction recovery; live worker/reorg behavior and cost/performance checks. The sample preview cannot approve these. No Base deployment or current-bytecode Anvil replay has been verified in this checkout. See the release boundaries in [BASE-SEPOLIA.md](BASE-SEPOLIA.md).

## Decision log

| Date | Area | Owner decision | Follow-up |
| --- | --- | --- | --- |
| 2026-11-17 | Start Phase 2 | Owner requested review to begin. Product acceptance is pending. | Open the preview and collect the first screen-specific feedback. |

The broader Phase 1 backlog remains open. Starting Phase 2 reviews the completed milestone and does not mark the full marketplace, social trading platform or future Zero integration complete.
