// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotEdition1155} from "../src/OneshotEdition1155.sol";
import {OneshotEdition1155Factory} from "../src/OneshotEdition1155Factory.sol";

interface OneshotEdition1155Vm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

contract EditionRejectingWallet is IERC1155Receiver {
    function execute(address target, bytes calldata data, uint256 value) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }

    receive() external payable {
        revert("native rejected");
    }
}

contract EditionReentrantReceiver is IERC1155Receiver {
    OneshotEdition1155 public collection;
    bool public nestedMintSucceeded;

    function mint(OneshotEdition1155 target, uint256 editionId) external {
        collection = target;
        target.mint(editionId, 1, address(this), 0, new bytes32[](0));
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external returns (bytes4) {
        (nestedMintSucceeded,) = address(collection).call(
            abi.encodeCall(OneshotEdition1155.mint, (id, 1, address(this), 0, new bytes32[](0)))
        );
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }
}

contract OneshotEdition1155Test {
    OneshotEdition1155Vm private constant vm = OneshotEdition1155Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant TREASURY = address(0xAAA1);
    address private constant CREATOR = address(0xBBB2);
    address private constant BUYER = address(0xCCC3);
    address private constant OTHER = address(0xDDD4);

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _publicConfig(uint64 supply, uint256 price, bytes32 root, string memory uri_)
        private
        pure
        returns (OneshotEdition1155.EditionConfig memory)
    {
        return OneshotEdition1155.EditionConfig({
            maxSupply: supply,
            allowlistRoot: root,
            contentHash: keccak256("edition-content"),
            tokenURI: uri_,
            allowlist: root == bytes32(0)
                ? OneshotEdition1155.Stage({start: 0, end: 0, walletLimit: 0, price: 0})
                : OneshotEdition1155.Stage({start: 100, end: 200, walletLimit: 3, price: price / 2}),
            publicMint: OneshotEdition1155.Stage({start: 200, end: 500, walletLimit: supply, price: price})
        });
    }

    function _deployCollection() private returns (OneshotEdition1155Factory factory, OneshotEdition1155 collection) {
        factory = new OneshotEdition1155Factory(TREASURY);
        vm.prank(CREATOR);
        collection = OneshotEdition1155(factory.createCollection("Oneshot Editions", "ONE1155", 500, "https://oneshot.example/contract.json"));
    }

    function testChainPolicyRejectsBlockedChainsAndAcceptsSupportedOnes() public {
        vm.chainId(1);
        vm.expectRevert(OneshotEdition1155Factory.UnsupportedChain.selector);
        new OneshotEdition1155Factory(TREASURY);

        vm.chainId(8453);
        vm.expectRevert(OneshotEdition1155Factory.UnsupportedChain.selector);
        new OneshotEdition1155Factory(TREASURY);

        vm.chainId(543210);
        vm.expectRevert(OneshotEdition1155Factory.UnsupportedChain.selector);
        new OneshotEdition1155Factory(TREASURY);

        vm.chainId(33001);
        OneshotEdition1155Factory zeroFactory = new OneshotEdition1155Factory(TREASURY);
        vm.prank(CREATOR);
        address deployed = zeroFactory.createCollection("Zero Editions", "ZED", 250, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi");
        assert(zeroFactory.isCollection(deployed));

        vm.chainId(84532);
        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155Factory.UnsupportedChain.selector);
        zeroFactory.createCollection("Cross", "CROSS", 250, "https://oneshot.example/c.json");
        vm.chainId(31337);
    }

    function testRejectsMalformedMetadataAndInvalidUris() public {
        OneshotEdition1155Factory factory = new OneshotEdition1155Factory(TREASURY);
        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155.InvalidTerms.selector);
        factory.createCollection("\xEF\xBB\xBFBadName", "SYM", 500, "https://oneshot.example/c.json");

        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155.InvalidTerms.selector);
        factory.createCollection("ValidName", "BAD\nSYM", 500, "https://oneshot.example/c.json");

        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155.InvalidTerms.selector);
        factory.createCollection("ValidName", "SYM", 500, "http://insecure.example/c.json");

        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155.InvalidTerms.selector);
        factory.createCollection("ValidName", "SYM", 1001, "https://oneshot.example/c.json");
    }

    function testMultiEditionConfigOpenFreezeAndIndependentAccounting() public {
        vm.warp(50);
        (, OneshotEdition1155 collection) = _deployCollection();

        vm.prank(OTHER);
        vm.expectRevert(OneshotEdition1155.OnlyCreator.selector);
        collection.createEdition(_publicConfig(10, 1 ether, bytes32(0), "https://oneshot.example/1.json"));

        vm.prank(CREATOR);
        uint256 id1 = collection.createEdition(_publicConfig(10, 1 ether, bytes32(0), "https://oneshot.example/draft.json"));
        vm.prank(CREATOR);
        collection.configureEdition(id1, _publicConfig(12, 1 ether, bytes32(0), "https://oneshot.example/1.json"));

        vm.prank(CREATOR);
        uint256 id2 = collection.createEdition(_publicConfig(5, 2 ether, bytes32(0), "ipfs://edition-2-meta"));

        vm.prank(CREATOR);
        collection.openEdition(id1);

        vm.prank(CREATOR);
        vm.expectRevert(OneshotEdition1155.Frozen.selector);
        collection.configureEdition(id1, _publicConfig(20, 1 ether, bytes32(0), "https://oneshot.example/1.json"));

        assert(keccak256(bytes(collection.uri(id1))) == keccak256("https://oneshot.example/1.json"));
        assert(keccak256(bytes(collection.uri(id2))) == keccak256("ipfs://edition-2-meta"));
        assert(collection.supportsInterface(type(IERC2981).interfaceId));

        vm.warp(250);
        vm.deal(BUYER, 10 ether);
        vm.prank(BUYER);
        collection.mint{value: 2 ether}(id1, 2, BUYER, 2 ether, new bytes32[](0));
        assert(collection.balanceOf(BUYER, id1) == 2);
        assert(collection.balanceOf(BUYER, id2) == 0);
        assert(collection.circulatingSupply(id1) == 2);

        vm.prank(BUYER);
        vm.expectRevert(OneshotEdition1155.NotOpen.selector);
        collection.mint{value: 2 ether}(id2, 1, BUYER, 2 ether, new bytes32[](0));
    }

    function testEditionBoundAllowlistProofs() public {
        vm.warp(50);
        (, OneshotEdition1155 collection) = _deployCollection();

        bytes32 leaf1 = collection.allowlistLeaf(1, BUYER);
        bytes32 leafOther = collection.allowlistLeaf(1, OTHER);
        bytes32 root = _hashPair(leaf1, leafOther);

        vm.prank(CREATOR);
        uint256 id1 = collection.createEdition(_publicConfig(10, 1 ether, root, "https://oneshot.example/1.json"));
        vm.prank(CREATOR);
        uint256 id2 = collection.createEdition(_publicConfig(10, 1 ether, root, "https://oneshot.example/2.json"));
        vm.prank(CREATOR);
        collection.openEdition(id1);
        vm.prank(CREATOR);
        collection.openEdition(id2);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafOther;

        vm.warp(120);
        vm.deal(BUYER, 5 ether);
        vm.prank(BUYER);
        collection.mint{value: 1 ether}(id1, 2, BUYER, 1 ether, proof);
        assert(collection.balanceOf(BUYER, id1) == 2);

        // Edition 1 proof cannot replay on Edition 2.
        vm.prank(BUYER);
        vm.expectRevert(OneshotEdition1155.InvalidProof.selector);
        collection.mint{value: 0.5 ether}(id2, 1, BUYER, 0.5 ether, proof);

        // Exceeding allowlist walletLimit (3) reverts.
        vm.prank(BUYER);
        vm.expectRevert(OneshotEdition1155.WalletLimit.selector);
        collection.mint{value: 1 ether}(id1, 2, BUYER, 1 ether, proof);
    }

    function testBurnUpdatesCirculatingWithoutPermittingOverMint() public {
        vm.warp(50);
        (, OneshotEdition1155 collection) = _deployCollection();
        vm.prank(CREATOR);
        uint256 id = collection.createEdition(_publicConfig(3, 0, bytes32(0), "https://oneshot.example/1.json"));
        vm.prank(CREATOR);
        collection.openEdition(id);

        vm.warp(210);
        vm.prank(BUYER);
        collection.mint(id, 3, BUYER, 0, new bytes32[](0));
        assert(collection.circulatingSupply(id) == 3);

        vm.prank(OTHER);
        vm.expectRevert(OneshotEdition1155.NotAuthorized.selector);
        collection.burn(BUYER, id, 1);

        vm.prank(BUYER);
        collection.burn(BUYER, id, 2);
        assert(collection.balanceOf(BUYER, id) == 1);
        assert(collection.circulatingSupply(id) == 1);

        vm.prank(OTHER);
        vm.expectRevert(OneshotEdition1155.SupplyLimit.selector);
        collection.mint(id, 1, OTHER, 0, new bytes32[](0));
    }

    function testReentrantReceiverBlockedAndRejectingTreasuryCanRouteClaim() public {
        EditionRejectingWallet rejectingTreasury = new EditionRejectingWallet();
        OneshotEdition1155Factory factory = new OneshotEdition1155Factory(address(rejectingTreasury));
        vm.warp(50);
        vm.prank(CREATOR);
        OneshotEdition1155 collection = OneshotEdition1155(
            factory.createCollection("Editions", "ED", 400, "https://oneshot.example/c.json")
        );

        vm.prank(CREATOR);
        uint256 freeId = collection.createEdition(_publicConfig(10, 0, bytes32(0), "https://oneshot.example/f.json"));
        vm.prank(CREATOR);
        uint256 paidId = collection.createEdition(_publicConfig(10, 1 ether, bytes32(0), "https://oneshot.example/p.json"));
        vm.prank(CREATOR);
        collection.openEdition(freeId);
        vm.prank(CREATOR);
        collection.openEdition(paidId);

        vm.warp(220);
        EditionReentrantReceiver attacker = new EditionReentrantReceiver();
        attacker.mint(collection, freeId);
        assert(!attacker.nestedMintSucceeded());
        assert(collection.balanceOf(address(attacker), freeId) == 1);

        vm.deal(BUYER, 5 ether);
        vm.prank(BUYER);
        collection.mint{value: 2 ether}(paidId, 2, BUYER, 2 ether, new bytes32[](0));
        uint256 treasuryShare = collection.pending(address(rejectingTreasury));
        uint256 creatorShare = collection.pending(CREATOR);
        assert(treasuryShare == 0.04 ether);
        assert(creatorShare == 1.96 ether);

        // Direct claim to rejecting wallet fails without corrupting accounting, then routes cleanly to BUYER.
        vm.expectRevert(OneshotEdition1155.PaymentFailed.selector);
        rejectingTreasury.execute(address(collection), abi.encodeCall(OneshotEdition1155.claimTo, (payable(address(rejectingTreasury)))), 0);
        assert(collection.pending(address(rejectingTreasury)) == treasuryShare);

        uint256 beforeBuyer = BUYER.balance;
        rejectingTreasury.execute(address(collection), abi.encodeCall(OneshotEdition1155.claimTo, (payable(BUYER))), 0);
        assert(BUYER.balance == beforeBuyer + treasuryShare);
        assert(collection.pending(address(rejectingTreasury)) == 0);
        assert(collection.totalPending() == creatorShare);
    }

    function testFuzzMintConservation(uint96 rawPrice, uint8 rawQuantity) public {
        uint256 price = uint256(rawPrice);
        uint256 quantity = (uint256(rawQuantity) % 50) + 1;
        vm.warp(50);
        (, OneshotEdition1155 collection) = _deployCollection();
        vm.prank(CREATOR);
        uint256 id = collection.createEdition(_publicConfig(50, price, bytes32(0), "https://oneshot.example/1.json"));
        vm.prank(CREATOR);
        collection.openEdition(id);

        uint256 totalPrice = price * quantity;
        vm.warp(250);
        vm.deal(BUYER, totalPrice);
        vm.prank(BUYER);
        collection.mint{value: totalPrice}(id, quantity, BUYER, totalPrice, new bytes32[](0));

        assert(collection.pending(TREASURY) + collection.pending(CREATOR) == totalPrice);
        assert(collection.totalPending() == totalPrice);
        assert(address(collection).balance == totalPrice);
    }

    function testFuzzRoyaltyInfoFullUint256(uint256 salePrice, uint16 rawBps) public {
        uint16 bps = rawBps % 1001;
        OneshotEdition1155Factory factory = new OneshotEdition1155Factory(TREASURY);
        vm.prank(CREATOR);
        OneshotEdition1155 collection = OneshotEdition1155(
            factory.createCollection("Editions", "ED", bps, "https://oneshot.example/c.json")
        );
        (address receiver, uint256 royalty) = collection.royaltyInfo(1, salePrice);
        assert(receiver == CREATOR);
        assert(royalty == Math.mulDiv(salePrice, bps, 10_000));
    }
}
