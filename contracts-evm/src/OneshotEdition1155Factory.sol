// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";
import {OneshotEdition1155} from "./OneshotEdition1155.sol";

/// @notice Permissionless registry for ERC-1155 multi-edition collections with shared chain & treasury policy.
contract OneshotEdition1155Factory {
    address public immutable treasury;
    uint256 public immutable deploymentChainId;
    mapping(address => bool) public isCollection;
    address[] public collections;

    error UnsupportedChain();
    error InvalidTreasury();

    event EditionCollectionCreated(
        address indexed collection, address indexed creator, string name, string symbol, uint16 royaltyBps
    );

    constructor(address treasury_) {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedChain();
        if (treasury_ == address(0)) revert InvalidTreasury();
        treasury = treasury_;
        deploymentChainId = block.chainid;
    }

    function createCollection(
        string calldata name,
        string calldata symbol,
        uint16 royaltyBps,
        string calldata contractURI
    ) external returns (address collection) {
        if (block.chainid != deploymentChainId) revert UnsupportedChain();
        collection = address(
            new OneshotEdition1155(name, symbol, msg.sender, treasury, royaltyBps, contractURI)
        );
        isCollection[collection] = true;
        collections.push(collection);
        emit EditionCollectionCreated(collection, msg.sender, name, symbol, royaltyBps);
    }

    function collectionCount() external view returns (uint256) {
        return collections.length;
    }
}
