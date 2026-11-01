// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotFixedSupplyToken} from "./OneshotFixedSupplyToken.sol";
import {OneshotLaunchPolicy} from "./OneshotLaunchPolicy.sol";
import {OneshotLocalOnly} from "./OneshotLocalOnly.sol";

/// @notice LOCAL ONLY: an immutable initial-allocation demonstrator, not launch liquidity.
/// @dev All tokens stay permanently locked here. There is intentionally no token approval,
/// transfer, rescue, arbitrary call, owner, upgrade, or later adapter-binding path.
/// Do not use this allocation lock for a real market: a verified AMM-specific custody
/// implementation must be reviewed and deployed separately before real issuance.
contract OneshotTokenFoundation is OneshotLocalOnly {
    OneshotFixedSupplyToken public immutable token;
    OneshotLaunchPolicy public immutable policy;

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address platformRecipient_,
        uint16 executionFeeBps_,
        OneshotLaunchPolicy.DestinationMode destinationMode_,
        uint256 openingValuationNative_
    ) {
        policy = new OneshotLaunchPolicy(
            creator_, platformRecipient_, executionFeeBps_, destinationMode_, openingValuationNative_
        );
        token = new OneshotFixedSupplyToken(name_, symbol_);
    }

    function isMarketLaunch() external pure returns (bool) {
        return false;
    }

    function liquidityAdapter() external pure returns (address) {
        return address(0);
    }
}
