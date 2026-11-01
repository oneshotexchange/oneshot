// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {OneshotCollection} from "../src/OneshotCollection.sol";
import {OneshotNFTFactory} from "../src/OneshotNFTFactory.sol";
import {OneshotMarketplace} from "../src/OneshotMarketplace.sol";

interface OneshotNFTVm {
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

contract NFTRejectingWallet is IERC721Receiver {
    function execute(address target, bytes calldata data, uint256 value) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        revert("native rejected");
    }
}

contract NFTBadReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return bytes4(0);
    }
}

contract NFTNoReceiverWallet {
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call(data);
        if (!success) {
            assembly { revert(add(result, 32), mload(result)) }
        }
        return result;
    }
}

contract NFTReentrantReceiver is IERC721Receiver {
    OneshotCollection public collection;
    bool public nestedMintSucceeded;

    function mint(OneshotCollection target) external {
        collection = target;
        target.mint(1, address(this), 0, new bytes32[](0));
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        (nestedMintSucceeded,) =
            address(collection).call(abi.encodeCall(OneshotCollection.mint, (1, address(this), 0, new bytes32[](0))));
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract NFTCallbackWallet is IERC721Receiver {
    address public attackTarget;
    bytes public attackData;
    bool public nestedCallSucceeded;
    bytes4 public failureSelector;

    function arm(address target, bytes calldata data) external {
        attackTarget = target;
        attackData = data;
    }

    function execute(address target, bytes calldata data, uint256 value) external returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) assembly { revert(add(result, 32), mload(result)) }
        return result;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        _attempt();
        return IERC721Receiver.onERC721Received.selector;
    }

    function _attempt() private {
        if (attackTarget == address(0)) return;
        (bool success, bytes memory result) = attackTarget.call(attackData);
        nestedCallSucceeded = success;
        if (result.length >= 4) failureSelector = bytes4(result);
    }

    receive() external payable {
        _attempt();
    }
}

abstract contract OneshotNFTTestBase {
    OneshotNFTVm internal constant vm = OneshotNFTVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant CREATOR = address(0xC01);
    address internal constant TREASURY = address(0xFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    OneshotNFTFactory internal factory;
    OneshotCollection internal collection;

    function setUp() public virtual {
        vm.warp(10);
        factory = new OneshotNFTFactory(TREASURY);
        vm.prank(CREATOR);
        collection = OneshotCollection(factory.createCollection("oneshot edition", "ONE"));
    }

    function _terms(uint64 cap, uint16 royalty, uint256 price)
        internal
        pure
        returns (OneshotCollection.Terms memory draft)
    {
        draft.maxSupply = cap;
        draft.royaltyBps = royalty;
        draft.contentHash = keccak256("snapshot including referenced media");
        draft.metadataBaseURI = "ipfs://snapshot/";
        draft.collectionURI = "ipfs://snapshot/collection.json";
        draft.publicMint = OneshotCollection.Stage(100, 300, cap, price);
    }

    function _configureOpen(OneshotCollection.Terms memory draft) internal {
        vm.prank(CREATOR);
        collection.configure(draft);
        vm.prank(CREATOR);
        collection.open();
    }

    function _eq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint mismatch");
    }

    function _eq(address a, address b) internal pure {
        require(a == b, "address mismatch");
    }

    function _eq(bytes32 a, bytes32 b) internal pure {
        require(a == b, "bytes32 mismatch");
    }
}

contract OneshotNFTTest is OneshotNFTTestBase {
    function testRoyaltyInfoMaxUint256AndUnconfiguredZeroRoyalty() public {
        (address beforeReceiver, uint256 beforeRoyalty) = collection.royaltyInfo(1, type(uint256).max);
        _eq(beforeReceiver, CREATOR);
        _eq(beforeRoyalty, 0);
        _configureOpen(_terms(10, 1000, 0));
        (address receiver, uint256 royalty) = collection.royaltyInfo(1, type(uint256).max);
        _eq(receiver, CREATOR);
        _eq(royalty, type(uint256).max / 10);
        uint256 fee = type(uint256).max / 50;
        uint256 proceeds = type(uint256).max - fee - royalty;
        _eq(proceeds + fee + royalty, type(uint256).max);
        (, uint256 zeroPriceRoyalty) = collection.royaltyInfo(1, 0);
        _eq(zeroPriceRoyalty, 0);
    }

    function testFuzzRoyaltyInfoFullUint256(uint256 salePrice, uint16 rawRoyalty) public {
        uint16 bps = rawRoyalty % 1001;
        _configureOpen(_terms(10, bps, 0));
        (address receiver, uint256 royalty) = collection.royaltyInfo(1, salePrice);
        uint256 expected = (salePrice / 10_000) * bps + ((salePrice % 10_000) * bps) / 10_000;
        _eq(receiver, CREATOR);
        _eq(royalty, expected);
    }

    function testFactoryAndIrreversibleTerms() public {
        OneshotCollection.Terms memory draft = _terms(100, 1000, 1 ether);
        vm.prank(CREATOR);
        collection.configure(draft);
        vm.prank(BOB);
        vm.expectRevert(OneshotCollection.OnlyCreator.selector);
        collection.open();
        vm.prank(CREATOR);
        collection.open();
        bytes32 original = keccak256(abi.encode(collection.terms()));
        draft.maxSupply = 1;
        draft.contentHash = bytes32(uint256(2));
        draft.royaltyBps = 0;
        draft.metadataBaseURI = "ipfs://replacement/";
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.Frozen.selector);
        collection.configure(draft);
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.Frozen.selector);
        collection.open();
        _eq(original, keccak256(abi.encode(collection.terms())));
        (address receiver, uint256 royalty) = collection.royaltyInfo(1, 999);
        _eq(receiver, CREATOR);
        _eq(royalty, 99);
        require(factory.isCollection(address(collection)), "registry");
        _eq(factory.collectionCount(), 1);
    }

    function testFuzzPrimaryConservation(uint96 unitPrice, uint8 rawQuantity) public {
        uint256 quantity = uint256(rawQuantity) % 20 + 1;
        _configureOpen(_terms(100, 0, unitPrice));
        uint256 total = uint256(unitPrice) * quantity;
        vm.deal(ALICE, total);
        vm.warp(100);
        vm.prank(ALICE);
        collection.mint{value: total}(quantity, ALICE, total, new bytes32[](0));
        uint256 fee = total * 200 / 10_000;
        _eq(collection.pending(TREASURY), fee);
        _eq(collection.pending(CREATOR), total - fee);
        _eq(collection.totalPending(), total);
        _eq(address(collection).balance, total);
        _eq(collection.balanceOf(ALICE), quantity);
        _eq(keccak256(bytes(collection.tokenURI(1))), keccak256(bytes("ipfs://snapshot/1")));
        if (fee != 0) {
            vm.prank(TREASURY);
            collection.claimTo(payable(BOB));
        }
        if (total - fee != 0) {
            vm.prank(CREATOR);
            collection.claimTo(payable(BOB));
        }
        _eq(collection.totalPending(), 0);
        _eq(address(collection).balance, 0);
        _eq(BOB.balance, total);
    }

    function testPerPhaseWalletCountsAccumulateAndAllowlistEndsBeforePublic() public {
        OneshotCollection.Terms memory draft = _terms(10, 0, 0);
        draft.publicMint = OneshotCollection.Stage(200, 300, 3, 0);
        draft.allowlist = OneshotCollection.Stage(100, 200, 3, 0);
        draft.allowlistRoot = collection.allowlistLeaf(ALICE);
        _configureOpen(draft);
        vm.warp(100);
        vm.prank(ALICE);
        collection.mint(2, BOB, 0, new bytes32[](0));
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.WalletLimit.selector);
        collection.mint(2, ALICE, 0, new bytes32[](0));
        vm.prank(BOB);
        vm.expectRevert(OneshotCollection.InvalidProof.selector);
        collection.mint(1, BOB, 0, new bytes32[](0));
        vm.warp(200);
        vm.prank(ALICE);
        collection.mint(3, ALICE, 0, new bytes32[](0));
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.WalletLimit.selector);
        collection.mint(1, ALICE, 0, new bytes32[](0));
        _eq(collection.allowlistMinted(ALICE), 2);
        _eq(collection.publicMinted(ALICE), 3);
        vm.warp(300);
        vm.prank(BOB);
        vm.expectRevert(OneshotCollection.NoActiveStage.selector);
        collection.mint(1, BOB, 0, new bytes32[](0));
    }

    function testAllowlistProofBoundToCollectionAndChain() public {
        OneshotCollection.Terms memory draft = _terms(10, 0, 0);
        draft.allowlist = OneshotCollection.Stage(50, 100, 5, 0);
        draft.allowlistRoot = collection.allowlistLeaf(ALICE);
        _configureOpen(draft);
        vm.prank(CREATOR);
        OneshotCollection other = OneshotCollection(factory.createCollection("other", "TWO"));
        vm.prank(CREATOR);
        other.configure(draft);
        vm.prank(CREATOR);
        other.open();
        vm.warp(50);
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.InvalidProof.selector);
        other.mint(1, ALICE, 0, new bytes32[](0));
        vm.chainId(block.chainid + 1);
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.InvalidProof.selector);
        collection.mint(1, ALICE, 0, new bytes32[](0));
    }

    function testInvalidRecipientRollsBackWholeBatchAndLiabilities() public {
        _configureOpen(_terms(10, 0, 100));
        vm.deal(ALICE, 200);
        vm.warp(100);
        NFTBadReceiver bad = new NFTBadReceiver();
        vm.prank(ALICE);
        vm.expectRevert();
        collection.mint{value: 200}(2, address(bad), 200, new bytes32[](0));
        _eq(collection.totalMinted(), 0);
        _eq(collection.totalPending(), 0);
        _eq(collection.publicMinted(ALICE), 0);
        _eq(address(collection).balance, 0);
        _eq(ALICE.balance, 200);
    }

    function testMintCallbackCannotReenter() public {
        _configureOpen(_terms(10, 0, 0));
        vm.warp(100);
        NFTReentrantReceiver receiver = new NFTReentrantReceiver();
        receiver.mint(collection);
        require(!receiver.nestedMintSucceeded(), "reentered mint");
        _eq(collection.totalMinted(), 1);
    }

    function testRejectingTreasuryCannotBlockMintAndClaimCanBeRouted() public {
        NFTRejectingWallet receiver = new NFTRejectingWallet();
        OneshotNFTFactory otherFactory = new OneshotNFTFactory(address(receiver));
        vm.prank(CREATOR);
        collection = OneshotCollection(otherFactory.createCollection("claims", "CLM"));
        _configureOpen(_terms(10, 0, 10_000));
        vm.warp(100);
        vm.deal(ALICE, 10_000);
        vm.prank(ALICE);
        collection.mint{value: 10_000}(1, ALICE, 10_000, new bytes32[](0));
        _eq(collection.pending(address(receiver)), 200);
        vm.expectRevert(OneshotCollection.PaymentFailed.selector);
        receiver.execute(address(collection), abi.encodeCall(OneshotCollection.claimTo, (payable(receiver))), 0);
        _eq(collection.pending(address(receiver)), 200);
        _eq(collection.totalPending(), 10_000);
        receiver.execute(address(collection), abi.encodeCall(OneshotCollection.claimTo, (payable(BOB))), 0);
        _eq(BOB.balance, 200);
        _eq(collection.totalPending(), 9800);
    }

    function testCapsExactPaymentAndMaximumPrice() public {
        _configureOpen(_terms(2, 0, 100));
        vm.warp(100);
        vm.deal(ALICE, 1000);
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.PriceLimit.selector);
        collection.mint{value: 100}(1, ALICE, 99, new bytes32[](0));
        vm.prank(ALICE);
        vm.expectRevert(OneshotCollection.IncorrectPayment.selector);
        collection.mint{value: 101}(1, ALICE, 100, new bytes32[](0));
        vm.prank(ALICE);
        collection.mint{value: 200}(2, ALICE, 200, new bytes32[](0));
        vm.deal(BOB, 100);
        vm.prank(BOB);
        vm.expectRevert(OneshotCollection.SupplyLimit.selector);
        collection.mint{value: 100}(1, BOB, 100, new bytes32[](0));
    }

    function testInvalidDraftStagesAndMetadataAreRejected() public {
        OneshotCollection.Terms memory draft = _terms(10, 0, 0);
        draft.allowlist = OneshotCollection.Stage(50, 101, 2, 0);
        draft.allowlistRoot = bytes32(uint256(1));
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        collection.configure(draft);
        draft.allowlist.end = 100;
        draft.metadataBaseURI = "javascript:alert(1)/";
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        collection.configure(draft);
        draft.metadataBaseURI = "ipfs://snapshot-no-trailing-slash";
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        collection.configure(draft);
        draft.metadataBaseURI = "ipfs://snapshot/";
        draft.royaltyBps = 1001;
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        collection.configure(draft);
        draft.royaltyBps = 0;
        vm.prank(CREATOR);
        collection.configure(draft);
        vm.warp(51);
        vm.prank(CREATOR);
        vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        collection.open();
    }

    function testSortedMerkleProofForMultipleWallets() public {
        bytes32 aliceLeaf = collection.allowlistLeaf(ALICE);
        bytes32 bobLeaf = collection.allowlistLeaf(BOB);
        bytes32 root = aliceLeaf < bobLeaf
            ? keccak256(abi.encodePacked(aliceLeaf, bobLeaf))
            : keccak256(abi.encodePacked(bobLeaf, aliceLeaf));
        OneshotCollection.Terms memory draft = _terms(10, 0, 0);
        draft.allowlist = OneshotCollection.Stage(50, 100, 3, 0);
        draft.allowlistRoot = root;
        _configureOpen(draft);
        vm.warp(50);
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;
        vm.prank(ALICE);
        collection.mint(1, ALICE, 0, proof);
        proof[0] = aliceLeaf;
        vm.prank(BOB);
        collection.mint(1, BOB, 0, proof);
        _eq(collection.totalMinted(), 2);
    }

    function testCollectionClaimCallbackCannotWithdrawTwice() public {
        NFTCallbackWallet beneficiary = new NFTCallbackWallet();
        OneshotNFTFactory otherFactory = new OneshotNFTFactory(address(beneficiary));
        vm.prank(CREATOR);
        collection = OneshotCollection(otherFactory.createCollection("claims", "CLM"));
        _configureOpen(_terms(10, 0, 10_000));
        vm.warp(100);
        vm.deal(ALICE, 10_000);
        vm.prank(ALICE);
        collection.mint{value: 10_000}(1, ALICE, 10_000, new bytes32[](0));
        bytes memory claim = abi.encodeCall(OneshotCollection.claimTo, (payable(beneficiary)));
        beneficiary.arm(address(collection), claim);
        beneficiary.execute(address(collection), claim, 0);
        require(!beneficiary.nestedCallSucceeded(), "claim reentered");
        require(beneficiary.failureSelector() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "wrong rejection");
        _eq(address(beneficiary).balance, 200);
        _eq(collection.pending(address(beneficiary)), 0);
        _eq(collection.totalPending(), 9800);
    }
}

contract OneshotMarketplaceTest is OneshotNFTTestBase {
    OneshotMarketplace internal market;

    function setUp() public override {
        super.setUp();
        market = new OneshotMarketplace(factory);
    }

    function testFuzzResaleConservation(uint96 rawPrice, uint16 rawRoyalty) public {
        uint256 price = uint256(rawPrice) + 1;
        uint16 royaltyBps = rawRoyalty % 1001;
        _mintForAlice(royaltyBps);
        uint256 id = _list(price);
        vm.deal(BOB, price);
        vm.prank(BOB);
        market.buy{value: price}(id, price, BOB);
        uint256 fee = price * 200 / 10_000;
        uint256 royalty = price * royaltyBps / 10_000;
        _eq(market.pending(TREASURY), fee);
        _eq(market.pending(CREATOR), royalty);
        _eq(market.pending(ALICE), price - fee - royalty);
        _eq(market.totalPending(), price);
        _eq(address(market).balance, price);
        _eq(collection.ownerOf(1), BOB);
        vm.prank(BOB);
        vm.expectRevert(OneshotMarketplace.InactiveListing.selector);
        market.buy(id, price, BOB);
        _eq(market.totalPending(), price);
    }

    function testStaleListingCannotBuyRelistedToken() public {
        _mintForAlice(500);
        uint256 first = _list(1000);
        vm.prank(ALICE);
        market.cancel(first);
        _eq(collection.ownerOf(1), ALICE);
        uint256 second = _list(2000);
        require(second != first, "reused listing");
        vm.deal(BOB, 5000);
        vm.prank(BOB);
        vm.expectRevert(OneshotMarketplace.InactiveListing.selector);
        market.buy{value: 1000}(first, 1000, BOB);
        vm.prank(BOB);
        vm.expectRevert(OneshotMarketplace.PriceLimit.selector);
        market.buy{value: 2000}(second, 1999, BOB);
        vm.prank(BOB);
        market.buy{value: 2000}(second, 2000, BOB);
        _eq(collection.ownerOf(1), BOB);
    }

    function testUnregisteredLookalikeAndUnsolicitedSafeTransferRejected() public {
        OneshotCollection lookalike = new OneshotCollection("fake", "FAKE", CREATOR, TREASURY);
        vm.prank(ALICE);
        vm.expectRevert(OneshotMarketplace.UnknownCollection.selector);
        market.list(address(lookalike), 1, 100);
        _mintForAlice(0);
        vm.prank(ALICE);
        vm.expectRevert(OneshotMarketplace.UnexpectedTransfer.selector);
        collection.safeTransferFrom(ALICE, address(market), 1);
        _eq(collection.ownerOf(1), ALICE);
    }

    function testRejectingBuyerRollsBackListingAndProceeds() public {
        _mintForAlice(1000);
        uint256 id = _list(10_000);
        vm.deal(BOB, 10_000);
        NFTBadReceiver bad = new NFTBadReceiver();
        vm.prank(BOB);
        vm.expectRevert();
        market.buy{value: 10_000}(id, 10_000, address(bad));
        _eq(collection.ownerOf(1), address(market));
        _eq(market.totalPending(), 0);
        _eq(market.activeListing(address(collection), 1), id);
        vm.prank(BOB);
        market.buy{value: 10_000}(id, 10_000, BOB);
        _eq(collection.ownerOf(1), BOB);
    }

    function testOnlySellerCanCancelAndSellerCannotBuyOwnListing() public {
        _mintForAlice(0);
        uint256 id = _list(100);
        vm.prank(BOB);
        vm.expectRevert(OneshotMarketplace.NotSeller.selector);
        market.cancel(id);
        vm.prank(ALICE);
        vm.expectRevert(OneshotMarketplace.SelfPurchase.selector);
        market.buy(id, 100, ALICE);
        vm.prank(ALICE);
        market.cancel(id);
        vm.prank(ALICE);
        vm.expectRevert(OneshotMarketplace.InactiveListing.selector);
        market.cancel(id);
    }

    function testContractSellerRejectingNativePaymentCanClaimElsewhere() public {
        _mintForAlice(1000);
        NFTRejectingWallet seller = new NFTRejectingWallet();
        vm.prank(ALICE);
        collection.safeTransferFrom(ALICE, address(seller), 1);
        seller.execute(address(collection), abi.encodeCall(IERC721.approve, (address(market), 1)), 0);
        uint256 id = abi.decode(
            seller.execute(
                address(market), abi.encodeCall(OneshotMarketplace.list, (address(collection), 1, 10_000)), 0
            ),
            (uint256)
        );
        vm.deal(BOB, 10_000);
        vm.prank(BOB);
        market.buy{value: 10_000}(id, 10_000, BOB);
        _eq(market.pending(address(seller)), 8800);
        vm.expectRevert(OneshotMarketplace.PaymentFailed.selector);
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.claimTo, (payable(seller))), 0);
        _eq(market.pending(address(seller)), 8800);
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.claimTo, (payable(ALICE))), 0);
        _eq(ALICE.balance, 8800);
        _eq(market.totalPending(), 1200);
    }

    function testPurchaseReceiverCannotReenterSettlement() public {
        _mintForAlice(1000);
        uint256 id = _list(10_000);
        NFTCallbackWallet buyer = new NFTCallbackWallet();
        bytes memory buy = abi.encodeCall(OneshotMarketplace.buy, (id, 10_000, address(buyer)));
        buyer.arm(address(market), buy);
        vm.deal(address(buyer), 10_000);
        buyer.execute(address(market), buy, 10_000);
        require(!buyer.nestedCallSucceeded(), "buy reentered");
        require(buyer.failureSelector() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "wrong rejection");
        _eq(collection.ownerOf(1), address(buyer));
        _eq(market.totalPending(), 10_000);
        _eq(market.pending(ALICE), 8800);
    }

    function testMarketClaimCallbackCannotWithdrawTwice() public {
        _mintForAlice(1000);
        NFTCallbackWallet seller = new NFTCallbackWallet();
        vm.prank(ALICE);
        collection.safeTransferFrom(ALICE, address(seller), 1);
        seller.execute(address(collection), abi.encodeCall(IERC721.approve, (address(market), 1)), 0);
        uint256 id = abi.decode(
            seller.execute(
                address(market), abi.encodeCall(OneshotMarketplace.list, (address(collection), 1, 10_000)), 0
            ),
            (uint256)
        );
        vm.deal(BOB, 10_000);
        vm.prank(BOB);
        market.buy{value: 10_000}(id, 10_000, BOB);
        bytes memory claim = abi.encodeCall(OneshotMarketplace.claimTo, (payable(seller)));
        seller.arm(address(market), claim);
        seller.execute(address(market), claim, 0);
        require(!seller.nestedCallSucceeded(), "claim reentered");
        require(seller.failureSelector() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "wrong rejection");
        _eq(address(seller).balance, 8800);
        _eq(market.pending(address(seller)), 0);
        _eq(market.totalPending(), 1200);
    }

    function testNoReceiverContractSellerCanCancelToChosenRecipient() public {
        _mintForAlice(0);
        NFTNoReceiverWallet seller = new NFTNoReceiverWallet();
        // Existing ERC721 ownership does not imply ERC721Receiver support.
        vm.prank(ALICE);
        collection.transferFrom(ALICE, address(seller), 1);
        seller.execute(address(collection), abi.encodeCall(IERC721.approve, (address(market), 1)));
        uint256 id = abi.decode(
            seller.execute(address(market), abi.encodeCall(OneshotMarketplace.list, (address(collection), 1, 1000))),
            (uint256)
        );
        vm.expectRevert();
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.cancel, (id)));
        _eq(market.activeListing(address(collection), 1), id);
        _eq(collection.ownerOf(1), address(market));
        vm.prank(BOB);
        vm.expectRevert(OneshotMarketplace.NotSeller.selector);
        market.cancelTo(id, BOB);
        vm.expectRevert(OneshotMarketplace.InvalidRecipient.selector);
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.cancelTo, (id, address(0))));
        vm.expectRevert(OneshotMarketplace.InvalidRecipient.selector);
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.cancelTo, (id, address(market))));
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.cancelTo, (id, BOB)));
        _eq(collection.ownerOf(1), BOB);
        _eq(market.activeListing(address(collection), 1), 0);
        vm.expectRevert(OneshotMarketplace.InactiveListing.selector);
        seller.execute(address(market), abi.encodeCall(OneshotMarketplace.cancelTo, (id, BOB)));
    }

    function _mintForAlice(uint16 royaltyBps) private {
        _configureOpen(_terms(10, royaltyBps, 0));
        vm.warp(100);
        vm.prank(ALICE);
        collection.mint(1, ALICE, 0, new bytes32[](0));
    }

    function _list(uint256 price) private returns (uint256) {
        vm.prank(ALICE);
        collection.approve(address(market), 1);
        vm.prank(ALICE);
        return market.list(address(collection), 1, price);
    }
}
