// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotLaunchPolicy} from "./OneshotLaunchPolicy.sol";
import {OneshotLocalOnly} from "./OneshotLocalOnly.sol";
import {OneshotTokenFoundation} from "./OneshotTokenFoundation.sol";

/// @notice Local-only allocation/economics experiments. No pool or trade is created.
/// @dev Nonpayable construction and creation require no initial native quote principal.
/// There is no DEX adapter, fee collection, fee withdrawal, or market-launch event.
contract OneshotTokenFoundationFactory is OneshotLocalOnly {
    error InvalidPlatformRecipient();

    address public immutable platformRecipient;
    mapping(address foundation => bool registered) public isFoundation;

    event TokenFoundationCreated(
        address indexed foundation,
        address indexed token,
        address indexed creator,
        address policy,
        uint256 openingValuationNative
    );

    constructor(address platformRecipient_) {
        if (platformRecipient_ == address(0)) revert InvalidPlatformRecipient();
        platformRecipient = platformRecipient_;
    }

    function createFoundation(
        string calldata name_,
        string calldata symbol_,
        uint16 executionFeeBps_,
        OneshotLaunchPolicy.DestinationMode destinationMode_,
        uint256 openingValuationNative_
    ) external returns (OneshotTokenFoundation foundation) {
        foundation = new OneshotTokenFoundation(
            name_, symbol_, msg.sender, platformRecipient, executionFeeBps_, destinationMode_, openingValuationNative_
        );
        isFoundation[address(foundation)] = true;
        emit TokenFoundationCreated(
            address(foundation),
            address(foundation.token()),
            msg.sender,
            address(foundation.policy()),
            openingValuationNative_
        );
    }
}
