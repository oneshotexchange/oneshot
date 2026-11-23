// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OneshotMetadata} from "./OneshotMetadata.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice New market issuance, separate from the permanently locked local allocation experiment.
contract OneshotMarketToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** 8;
    address public immutable market;
    error UnsupportedTestChain(uint256 chainId);
    error InvalidMetadata();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedTestChain(block.chainid);
        if (!OneshotMetadata.valid(bytes(name_), 64) || !OneshotMetadata.valid(bytes(symbol_), 16)) revert InvalidMetadata();
        market = msg.sender;
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) { return 8; }
    function burn(uint256 amount) external { _burn(msg.sender, amount); }

}
