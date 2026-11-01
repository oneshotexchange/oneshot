// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OneshotLocalOnly} from "./OneshotLocalOnly.sol";

/// @notice Local ERC-20 foundation: 1 billion tokens, 8 decimals, constructor-only issuance.
/// @dev Registered foundations construct this token themselves, allocating all issuance
/// to their immutable lock. No mint role, owner, transfer tax, or privileged burn exists.
/// Standalone deployment is not a registered foundation or a successful token launch.
contract OneshotFixedSupplyToken is ERC20, OneshotLocalOnly {
    error InvalidTokenMetadata();

    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** 8;
    address public immutable initialAllocationCustody;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (
            bytes(name_).length == 0 || bytes(name_).length > 64 || bytes(symbol_).length == 0
                || bytes(symbol_).length > 16
        ) {
            revert InvalidTokenMetadata();
        }
        initialAllocationCustody = msg.sender;
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @notice A holder may destroy only its own tokens, reducing current supply.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
