// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotNFTTestBase, NFTCallbackWallet, NFTBadReceiver} from "./OneshotNFT.t.sol";
import {OneshotCollection} from "../src/OneshotCollection.sol";
import {OneshotGuardedMarketplace} from "../src/OneshotGuardedMarketplace.sol";

interface GuardedVm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

contract OneshotGuardedMarketplaceTest is OneshotNFTTestBase {
    GuardedVm internal constant signatures = GuardedVm(address(vm));
    uint256 internal constant AUTHORITY_KEY = 0x123456;
    bytes32 internal constant SALT = keccak256("local deployment identity");
    bytes32 internal constant LISTING_TYPEHASH = keccak256(
        "ListingPermit(address seller,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)"
    );
    bytes32 internal constant POLICY_TYPEHASH = keccak256(
        "PolicyPermit(address creator,address collection,bytes32 commitment,bytes32 expectedCommitment,uint256 deadline,bytes32 deploymentSalt)"
    );
    OneshotGuardedMarketplace internal market;
    address internal authority;

    struct Permit {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 totalPrice;
        uint256 nonce;
        bytes32 policyCommitment;
        uint256 deadline;
        bytes32 deploymentSalt;
    }

    function setUp() public override {
        super.setUp();
        vm.chainId(31337);
        authority = signatures.addr(AUTHORITY_KEY);
        market = new OneshotGuardedMarketplace(factory, authority, SALT);
        _configureOpen(_terms(10, 750, 0));
        vm.warp(100);
        vm.prank(ALICE);
        collection.mint(3, ALICE, 0, new bytes32[](0));
        vm.prank(ALICE);
        collection.setApprovalForAll(address(market), true);
    }

    function _domain(address target, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("OneshotGuardedMarketplace"), keccak256("1"), chainId, target
        ));
    }

    function _sign(bytes32 structHash, address target, uint256 chainId) internal returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domain(target, chainId), structHash));
        (uint8 v, bytes32 r, bytes32 s) = signatures.sign(AUTHORITY_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 tokenId, uint256 price) internal view returns (Permit memory) {
        return Permit(ALICE, address(collection), tokenId, price, market.listingNonces(ALICE),
            market.policyCommitment(address(collection)), 200, SALT);
    }

    function _listingSignature(Permit memory permit, address target, uint256 chainId) internal returns (bytes memory) {
        return _sign(keccak256(abi.encode(
            LISTING_TYPEHASH, permit.seller, permit.collection, permit.tokenId, permit.totalPrice, permit.nonce,
            permit.policyCommitment, permit.deadline, permit.deploymentSalt
        )), target, chainId);
    }

    function _submit(Permit memory permit, bytes memory signature) internal returns (uint256) {
        vm.prank(permit.seller);
        return market.listAuthorized(permit.collection, permit.tokenId, permit.totalPrice, permit.nonce,
            permit.policyCommitment, permit.deadline, signature);
    }

    function _list(uint256 tokenId, uint256 price) internal returns (uint256) {
        Permit memory permit = _permit(tokenId, price);
        return _submit(permit, _listingSignature(permit, address(market), 31337));
    }

    function _policySignature(address creator, address targetCollection, bytes32 commitment, bytes32 expected)
        internal returns (bytes memory)
    {
        return _sign(keccak256(abi.encode(
            POLICY_TYPEHASH, creator, targetCollection, commitment, expected, uint256(200), SALT
        )), address(market), 31337);
    }

    function _policy(bytes32 commitment, bytes32 expected) internal {
        bytes memory signature = _policySignature(CREATOR, address(collection), commitment, expected);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), commitment, expected, 200, signature);
    }

    function testRejectsDirectListingBypassAndMissingAuthorization() public {
        vm.prank(ALICE);
        (bool success,) = address(market).call(abi.encodeWithSignature("list(address,uint256,uint256)", address(collection), 1, 1));
        require(!success, "unguarded list available");
        Permit memory permit = _permit(1, 1);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(permit, "");
        _eq(collection.ownerOf(1), ALICE);
        _eq(market.listingNonces(ALICE), 0);
    }

    function testAuthorizedExactPriceEntersEscrowAndCannotReplayAfterCancel() public {
        Permit memory permit = _permit(1, 9 ether);
        bytes memory signature = _listingSignature(permit, address(market), 31337);
        _eq(_submit(permit, signature), 1);
        _eq(collection.ownerOf(1), address(market));
        _eq(market.listingNonces(ALICE), 1);
        (,,, uint256 price, bool active) = market.listings(1);
        _eq(price, 9 ether);
        require(active, "inactive");
        vm.prank(ALICE);
        market.cancel(1);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidNonce.selector);
        _submit(permit, signature);
        _eq(collection.ownerOf(1), ALICE);
    }

    function testCannotTamperPriceSellerTokenCollectionDeadlineOrSalt() public {
        Permit memory original = _permit(1, 9 ether);
        bytes memory signature = _listingSignature(original, address(market), 31337);
        Permit memory changed = _permit(1, 8 ether);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(changed, signature);
        changed = _permit(1, 9 ether); changed.seller = BOB;
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(changed, signature);
        changed = _permit(2, 9 ether);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(changed, signature);
        vm.prank(CREATOR);
        address second = factory.createCollection("second", "TWO");
        changed = _permit(1, 9 ether); changed.collection = second;
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(changed, signature);
        changed = _permit(1, 9 ether); changed.deadline = 201;
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(changed, signature);
        changed = _permit(1, 9 ether); changed.deploymentSalt = keccak256("wrong salt");
        signature = _listingSignature(changed, address(market), 31337);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(original, signature);
    }

    function testRejectsWrongNonceStaleCommitmentAndExpiredPermit() public {
        Permit memory permit = _permit(1, 9 ether);
        bytes memory signature = _listingSignature(permit, address(market), 31337);
        permit.nonce = 1;
        vm.expectRevert(OneshotGuardedMarketplace.InvalidNonce.selector);
        _submit(permit, signature);
        permit.nonce = 0;
        _policy(keccak256("policy 1 with private salt"), bytes32(0));
        vm.expectRevert(OneshotGuardedMarketplace.PolicyChanged.selector);
        _submit(permit, signature);
        permit = _permit(1, 9 ether);
        signature = _listingSignature(permit, address(market), 31337);
        vm.warp(201);
        vm.expectRevert(OneshotGuardedMarketplace.AuthorizationExpired.selector);
        _submit(permit, signature);
    }

    function testDomainRejectsOtherChainOtherMarketAndOtherDeploymentSalt() public {
        Permit memory permit = _permit(1, 9 ether);
        bytes memory signature = _listingSignature(permit, address(market), 1);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(permit, signature);
        OneshotGuardedMarketplace other = new OneshotGuardedMarketplace(factory, authority, SALT);
        signature = _listingSignature(permit, address(other), 31337);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        _submit(permit, signature);
        signature = _listingSignature(permit, address(market), 31337);
        vm.chainId(1);
        vm.expectRevert(OneshotGuardedMarketplace.LocalChainOnly.selector);
        _submit(permit, signature);
    }

    function testConstructorRequiresLocalChainNonzeroAuthorityAndSalt() public {
        vm.expectRevert(OneshotGuardedMarketplace.InvalidListingAuthority.selector);
        new OneshotGuardedMarketplace(factory, address(0), SALT);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidDeploymentSalt.selector);
        new OneshotGuardedMarketplace(factory, authority, bytes32(0));
        vm.chainId(1);
        vm.expectRevert(OneshotGuardedMarketplace.LocalChainOnly.selector);
        new OneshotGuardedMarketplace(factory, authority, SALT);
    }

    function testPolicyRequiresCreatorRegisteredCollectionAndAuthoritySignature() public {
        bytes32 commitment = keccak256("policy private salt");
        bytes memory signature = _policySignature(CREATOR, address(collection), commitment, bytes32(0));
        vm.expectRevert(OneshotGuardedMarketplace.OnlyCreator.selector);
        vm.prank(ALICE);
        market.setPolicyCommitment(address(collection), commitment, bytes32(0), 200, signature);
        vm.expectRevert(OneshotGuardedMarketplace.UnknownCollection.selector);
        vm.prank(CREATOR);
        market.setPolicyCommitment(BOB, commitment, bytes32(0), 200, signature);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), keccak256("different"), bytes32(0), 200, signature);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), commitment, bytes32(0), 200, signature);
        _eq(market.policyCommitment(address(collection)), commitment);
        vm.expectRevert(OneshotGuardedMarketplace.PolicyChanged.selector);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), commitment, bytes32(0), 200, signature);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidPolicyCommitment.selector);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), commitment, commitment, 200, signature);
    }

    function testRetiredCommitmentCannotReviveOldListingPermit() public {
        bytes32 a = keccak256("a salted");
        bytes32 b = keccak256("b salted");
        _policy(a, bytes32(0));
        Permit memory oldPermit = _permit(1, 9 ether);
        bytes memory oldSignature = _listingSignature(oldPermit, address(market), 31337);
        _policy(b, a);
        bytes memory bToA = _policySignature(CREATOR, address(collection), a, b);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidPolicyCommitment.selector);
        vm.prank(CREATOR);
        market.setPolicyCommitment(address(collection), a, b, 200, bToA);
        vm.expectRevert(OneshotGuardedMarketplace.PolicyChanged.selector);
        _submit(oldPermit, oldSignature);
    }

    function testPolicyChangeKeepsExistingOrderPriceAndExactSettlementClaims() public {
        _list(1, 9 ether);
        _policy(keccak256("new policy"), bytes32(0));
        (,,, uint256 price, bool active) = market.listings(1);
        _eq(price, 9 ether); require(active, "policy changed order");
        vm.deal(BOB, 9 ether);
        vm.prank(BOB);
        market.buy{value: 9 ether}(1, 9 ether, BOB);
        _eq(collection.ownerOf(1), BOB);
        _eq(market.pending(TREASURY), 0.18 ether);
        _eq(market.pending(CREATOR), 0.675 ether);
        _eq(market.pending(ALICE), 8.145 ether);
        _eq(market.totalPending(), 9 ether);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        market.claimTo(payable(ALICE));
        _eq(ALICE.balance - before, 8.145 ether);
        _eq(market.totalPending(), 0.855 ether);
    }

    function testCancelToAndClaimsNeverRequireFreshAuthorization() public {
        _list(1, 9 ether);
        _policy(keccak256("changed"), bytes32(0));
        vm.warp(10_000);
        vm.chainId(1);
        vm.prank(ALICE);
        market.cancelTo(1, BOB);
        _eq(collection.ownerOf(1), BOB);
        _eq(market.activeListing(address(collection), 1), 0);
    }

    function testRejectedEscrowReleaseRestoresListingAndBalances() public {
        _list(1, 9 ether);
        NFTBadReceiver receiver = new NFTBadReceiver();
        vm.deal(BOB, 9 ether);
        vm.expectRevert();
        vm.prank(BOB);
        market.buy{value: 9 ether}(1, 9 ether, address(receiver));
        (,,,, bool active) = market.listings(1);
        require(active, "failed sale removed listing");
        _eq(collection.ownerOf(1), address(market));
        _eq(market.totalPending(), 0);
        _eq(market.pending(ALICE), 0);
    }

    function testCallbackCannotReenterSettlement() public {
        _list(1, 9 ether);
        NFTCallbackWallet receiver = new NFTCallbackWallet();
        receiver.arm(address(market), abi.encodeCall(market.buy, (1, 9 ether, BOB)));
        vm.deal(BOB, 9 ether);
        vm.prank(BOB);
        market.buy{value: 9 ether}(1, 9 ether, address(receiver));
        require(!receiver.nestedCallSucceeded(), "reentry succeeded");
        require(receiver.failureSelector() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "wrong reentry failure");
        _eq(market.totalPending(), 9 ether);
    }
}
