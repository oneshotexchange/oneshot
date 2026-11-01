// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotCollection} from "./OneshotCollection.sol";

/// @notice Permissionless registry with no owner, collection removal, upgrades or treasury changes.
contract OneshotNFTFactory {
    address public immutable treasury;
    mapping(address => bool) public isCollection;
    address[] public collections;
    error InvalidTreasury();
    event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol);

    constructor(address treasury_) {
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
    }

    function createCollection(string calldata name, string calldata symbol) external returns (address collection) {
        collection = address(new OneshotCollection(name, symbol, msg.sender, treasury));
        isCollection[collection] = true;
        collections.push(collection);
        emit CollectionCreated(collection, msg.sender, name, symbol);
    }

    function collectionCount() external view returns (uint256) {
        return collections.length;
    }
}
