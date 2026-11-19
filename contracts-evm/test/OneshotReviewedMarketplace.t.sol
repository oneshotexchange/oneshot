// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotNFTFactory} from "../src/OneshotNFTFactory.sol";
import {OneshotReviewedCollectionRegistry as Registry} from "../src/OneshotReviewedCollectionRegistry.sol";
import {OneshotReviewedMarketplace as Market} from "../src/OneshotReviewedMarketplace.sol";

interface ReviewedVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function deal(address, uint256) external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function addr(uint256) external returns (address);
    function etch(address, bytes calldata) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract ReviewedExternalNft is ERC721, IERC2981 {
    address public royaltyRecipient;
    uint256 public royaltyBps = 750;
    uint256 public quoteMode;
    constructor(address recipient) ERC721("External review fixture", "EXT") { royaltyRecipient = recipient; }
    function mint(address owner, uint256 id) external { _mint(owner, id); }
    function setRoyalty(address recipient, uint256 bps) external { royaltyRecipient = recipient; royaltyBps = bps; }
    function setQuoteMode(uint256 mode) external { quoteMode = mode; }
    function supportsInterface(bytes4 id) public view virtual override(ERC721, IERC165) returns (bool) {
        return id == type(IERC2981).interfaceId || super.supportsInterface(id);
    }
    function royaltyInfo(uint256, uint256 price) external view returns (address, uint256) {
        uint256 mode = quoteMode;
        if (mode == 1) revert("quote unavailable");
        if (mode == 2) assembly { mstore(0, 1) return(0, 32) }
        if (mode == 3) assembly { mstore(0, 1) mstore(32, 1) mstore(64, 1) return(0, 96) }
        if (mode == 4) assembly { mstore(0, shl(200, 1)) mstore(32, 0) return(0, 64) }
        if (mode == 5) assembly { return(0, 65536) }
        if (mode == 6) assembly { for {} 1 {} {} }
        return (royaltyRecipient, Math.mulDiv(price, royaltyBps, 10_000));
    }
}

// Neither ERC-721 alone nor an ERC-165 implementation claiming the forbidden
// 0xffffffff interface qualifies as reviewed ERC-721/ERC-2981.
contract ReviewedWithoutRoyalty is ERC721 {
    constructor() ERC721("No royalties", "NO") {}
}
contract ReviewedInterfaceLiar {
    function supportsInterface(bytes4) external pure returns (bool) { return true; }
}
contract ReviewedGasInterfaceNft is ReviewedExternalNft {
    uint256 public executionGasToConsume;
    constructor(address recipient, uint256 gasToConsume) ReviewedExternalNft(recipient) { executionGasToConsume = gasToConsume; }
    function supportsInterface(bytes4 id) public view override returns (bool) {
        uint256 budget = executionGasToConsume;
        assembly {
            let start := gas()
            for {} lt(sub(start, gas()), budget) {} {}
        }
        return super.supportsInterface(id);
    }
}
contract ReviewedCallerInterfaceNft is ReviewedExternalNft {
    address immutable allowedCaller;
    constructor(address recipient, address checker) ReviewedExternalNft(recipient) { allowedCaller = checker; }
    function supportsInterface(bytes4 id) public view override returns (bool) {
        return msg.sender == allowedCaller && super.supportsInterface(id);
    }
}
contract ReviewedWritingInterface {
    uint256 public probes;
    function supportsInterface(bytes4 id) external returns (bool) {
        probes++;
        return id == 0x01ffc9a7 || id == type(IERC721).interfaceId || id == type(IERC2981).interfaceId;
    }
}
contract Reviewed1271Authority is IERC1271 {
    bytes32 public allowed;
    function allow(bytes32 hash) external { allowed = hash; }
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return hash == allowed && keccak256(signature) == keccak256(hex"1234") ? IERC1271.isValidSignature.selector : bytes4(0);
    }
    function revoke(Registry registry, address collection, uint256 version) external { registry.revoke(collection, version); }
}
contract ReviewedWallet is IERC721Receiver {
    bool public rejectNative;
    bool public rejectNft;
    address public attackTarget;
    bytes public attackData;
    bool public nestedSucceeded;
    bytes4 public nestedFailure;
    function arm(address target, bytes memory data, bool nativeRejection, bool nftRejection) external {
        attackTarget = target; attackData = data; rejectNative = nativeRejection; rejectNft = nftRejection;
    }
    function execute(address target, bytes memory data, uint256 value) external returns (bytes memory result) {
        bool ok; (ok, result) = target.call{value: value}(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
    function _attempt() private {
        if (attackTarget != address(0)) {
            bytes memory result;
            (nestedSucceeded, result) = attackTarget.call(attackData);
            if (result.length >= 4) {
                bytes4 selector;
                assembly { selector := mload(add(result, 32)) }
                nestedFailure = selector;
            }
        }
    }
    function onERC721Received(address, address, uint256, bytes memory) external returns (bytes4) {
        _attempt(); return rejectNft ? bytes4(0) : IERC721Receiver.onERC721Received.selector;
    }
    receive() external payable { require(!rejectNative, "native rejected"); _attempt(); }
}
contract ReviewedForwardReceiver is IERC721Receiver {
    address immutable recipient;
    constructor(address recipient_) { recipient = recipient_; }
    function onERC721Received(address, address, uint256 id, bytes memory) external returns (bytes4) {
        IERC721(msg.sender).transferFrom(address(this), recipient, id);
        return IERC721Receiver.onERC721Received.selector;
    }
}

// Kept independent of the native collection fixtures: external IDs are sparse,
// zero is valid, and royalty behavior is explicitly mutable/adversarial.
abstract contract ReviewedTestBase {
    ReviewedVm constant vm = ReviewedVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY = 0x123456;
    address constant SELLER = address(0xa11ce);
    address constant BUYER = address(0xb0b);
    address constant TREASURY = address(0x777);
    address constant ROYALTY = address(0x999);
    bytes32 constant SALT = keccak256("reviewed market fixture");
    bytes32 constant DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant REVIEW = keccak256("ReviewPermit(address collection,bytes32 runtimeCodeHash,uint256 reviewVersion,uint256 deadline,bytes32 deploymentSalt)");
    OneshotNFTFactory factory;
    Registry registry;
    Market market;
    ReviewedExternalNft nft;
    address authority;
    function setUp() public virtual {
        vm.chainId(31337); vm.warp(100);
        authority = vm.addr(KEY);
        factory = new OneshotNFTFactory(TREASURY);
        registry = new Registry(factory, authority, SALT);
        market = new Market(registry, SALT);
        nft = new ReviewedExternalNft(ROYALTY);
        nft.mint(SELLER, 0); nft.mint(SELLER, 456789); nft.mint(SELLER, type(uint256).max);
        vm.deal(BUYER, 100 ether); vm.deal(SELLER, 100 ether);
    }
    function _sign(bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, digest); return abi.encodePacked(r, s, v);
    }
    function _digest(bytes32 body, string memory name, address target, uint256 chain) internal pure returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN, keccak256(bytes(name)), keccak256("1"), chain, target));
        return keccak256(abi.encodePacked("\x19\x01", domain, body));
    }
    function _admit(address collection, uint256 version) internal {
        bytes32 hash = collection.codehash;
        bytes memory sig = _sign(registry.reviewPermitHash(collection, hash, version, 1000));
        vm.prank(BUYER); registry.admitReviewed(collection, hash, version, 1000, sig);
    }
    function _intent(uint256 id, uint256 price) internal view returns (Market.ListingIntent memory) {
        (address recipient, uint256 amount) = nft.royaltyInfo(id, price);
        (,uint256 version,) = registry.reviews(address(nft));
        return Market.ListingIntent(SELLER,address(nft),id,price,recipient,amount,version,market.listingNonces(SELLER),1000,31337,address(market),SALT);
    }
    function _push(Market.ListingIntent memory intent) internal {
        vm.prank(intent.seller); nft.safeTransferFrom(intent.seller,address(market),intent.tokenId,abi.encode(intent));
    }
    function _list(uint256 id, uint256 price) internal returns (uint256 listingId) {
        Market.ListingIntent memory intent = _intent(id, price); listingId = market.nextListingId(); _push(intent);
    }
    function _active(uint256 id) internal view returns (bool active) { (,,,,,,,,active) = market.listings(id); }
    function _buy(uint256 listingId, uint256 price, address recipient) internal {
        vm.prank(BUYER); market.buy{value:price}(listingId,price,recipient);
    }
}

contract OneshotReviewedRegistryTest is ReviewedTestBase {
    function testCandidateCheckSharesLowGasAdmissionQualificationWithoutChangingReviewState() public {
        require(registry.checkCollection(address(nft)) == address(nft).codehash);
        (,uint256 version,bool active) = registry.reviews(address(nft)); require(version == 0 && !active);
        _admit(address(nft),1);
        require(registry.requireActiveReview(address(nft),1) == registry.checkCollection(address(nft)));
        address nativeCollection = factory.createCollection("Native", "NAT");
        vm.expectRevert(Registry.NativeCollectionExcluded.selector); registry.checkCollection(nativeCollection);
        vm.expectRevert(Registry.InvalidCollection.selector); registry.checkCollection(BUYER);
    }
    function testCandidateCheckAllowsValidHeavyProbesButRejectsMoreThanThirtyThousandExecutionGas() public {
        ReviewedGasInterfaceNft valid = new ReviewedGasInterfaceNft(ROYALTY,25_000);
        require(registry.checkCollection(address(valid)) == address(valid).codehash);
        _admit(address(valid),1);
        ReviewedGasInterfaceNft expensive = new ReviewedGasInterfaceNft(ROYALTY,35_000);
        require(expensive.supportsInterface{gas:100_000}(type(IERC721).interfaceId));
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.checkCollection(address(expensive));
        bytes32 hash = address(expensive).codehash;
        bytes memory sig = _sign(registry.reviewPermitHash(address(expensive),hash,1,1000));
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.admitReviewed(address(expensive),hash,1,1000,sig);
    }
    function testCandidateCheckUsesRegistryCallerRatherThanRpcOrTransactionSender() public {
        ReviewedCallerInterfaceNft onlyRegistry = new ReviewedCallerInterfaceNft(ROYALTY,address(registry));
        require(!onlyRegistry.supportsInterface(type(IERC721).interfaceId));
        vm.prank(BUYER); require(registry.checkCollection(address(onlyRegistry)) == address(onlyRegistry).codehash);
        _admit(address(onlyRegistry),1);
        ReviewedCallerInterfaceNft onlyDirect = new ReviewedCallerInterfaceNft(ROYALTY,address(this));
        require(onlyDirect.supportsInterface(type(IERC721).interfaceId));
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.checkCollection(address(onlyDirect));
        bytes32 hash = address(onlyDirect).codehash;
        bytes memory sig = _sign(registry.reviewPermitHash(address(onlyDirect),hash,1,1000));
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.admitReviewed(address(onlyDirect),hash,1,1000,sig);
    }
    function testCandidateCheckRejectsStateWritingInterfaceThatDirectEthCallCouldSimulate() public {
        ReviewedWritingInterface writes = new ReviewedWritingInterface();
        require(writes.supportsInterface(type(IERC721).interfaceId) && writes.probes() == 1);
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.checkCollection(address(writes));
        bytes32 hash = address(writes).codehash;
        bytes memory sig = _sign(registry.reviewPermitHash(address(writes),hash,1,1000));
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.admitReviewed(address(writes),hash,1,1000,sig);
        require(writes.probes() == 1);
        (,uint256 version,bool active) = registry.reviews(address(writes)); require(version == 0 && !active);
    }
    function testPermissionlessSubmissionEmitsExactReviewAndDomainDigest() public {
        bytes32 codeHash = address(nft).codehash;
        bytes32 digest = _digest(keccak256(abi.encode(REVIEW,address(nft),codeHash,uint256(1),uint256(1000),SALT)),"OneshotReviewedCollectionRegistry",address(registry),31337);
        require(digest == registry.reviewPermitHash(address(nft),codeHash,1,1000), "domain binding");
        vm.recordLogs(); _admit(address(nft),1);
        ReviewedVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(registry));
        require(logs[0].topics[0] == keccak256("ReviewAdmitted(address,uint256,bytes32,bytes32,uint256)"));
        require(logs[0].topics[1] == bytes32(uint256(uint160(address(nft)))) && logs[0].topics[2] == bytes32(uint256(1)));
        (bytes32 eventCodeHash,bytes32 permitHash,uint256 deadline) = abi.decode(logs[0].data,(bytes32,bytes32,uint256));
        require(eventCodeHash == codeHash && permitHash == digest && deadline == 1000);
        require(registry.requireActiveReview(address(nft),1) == codeHash);
        require(registry.REGISTRY_VERSION() == 1 && registry.ASSET_STANDARD() == type(IERC721).interfaceId);
        require(address(registry.oneshotFactory()) == address(factory) && registry.oneshotFactoryCodeHash() == address(factory).codehash);
        require(registry.reviewAuthority() == authority && registry.deploymentSalt() == SALT && registry.deploymentChainId() == 31337);
    }
    function testRejectsReplayWrongVersionExpiryAndRuntimeBeforeStateMutation() public {
        bytes32 hash = address(nft).codehash;
        bytes memory signature = _sign(registry.reviewPermitHash(address(nft),hash,1,1000));
        vm.expectRevert(Registry.InvalidReviewVersion.selector); registry.admitReviewed(address(nft),hash,2,1000,signature);
        vm.expectRevert(Registry.InvalidRuntimeCodeHash.selector); registry.admitReviewed(address(nft),keccak256("wrong"),1,1000,signature);
        vm.expectRevert(Registry.InvalidRuntimeCodeHash.selector); registry.admitReviewed(address(nft),0,1,1000,signature);
        vm.warp(1001); vm.expectRevert(Registry.ReviewExpired.selector); registry.admitReviewed(address(nft),hash,1,1000,signature);
        vm.warp(1000); registry.admitReviewed(address(nft),hash,1,1000,signature);
        vm.expectRevert(Registry.InvalidReviewVersion.selector); registry.admitReviewed(address(nft),hash,1,1000,signature);
        (,uint256 version,bool active) = registry.reviews(address(nft)); require(version == 1 && active);
    }
    function testSignedPermitBindsEveryFieldDomainAndDeploymentSalt() public {
        bytes32 hash = address(nft).codehash;
        bytes32 body = keccak256(abi.encode(REVIEW,address(nft),hash,uint256(1),uint256(1000),SALT));
        bytes memory sig = _sign(_digest(body,"OneshotReviewedCollectionRegistry",address(registry),84532));
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1000,sig);
        sig = _sign(_digest(body,"OneshotReviewedCollectionRegistry",address(market),31337));
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1000,sig);
        sig = _sign(_digest(keccak256(abi.encode(REVIEW,address(nft),hash,uint256(1),uint256(1000),keccak256("other"))),"OneshotReviewedCollectionRegistry",address(registry),31337));
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1000,sig);
        sig = _sign(registry.reviewPermitHash(address(nft),hash,1,1000));
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1001,sig);
        ReviewedExternalNft other = new ReviewedExternalNft(ROYALTY);
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(other),address(other).codehash,1,1000,sig);
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1000,hex"12");
        vm.expectRevert(Registry.InvalidAuthorization.selector); registry.admitReviewed(address(nft),hash,1,1000,new bytes(4097));
        (,uint256 version,bool active) = registry.reviews(address(nft)); require(version == 0 && !active);
    }
    function testCannotImportNativeFactoryCollectionsOrUnqualifiedInterfaces() public {
        address nativeCollection = factory.createCollection("Native", "NAT");
        vm.expectRevert(Registry.NativeCollectionExcluded.selector); registry.admitReviewed(nativeCollection,nativeCollection.codehash,1,1000,"");
        vm.expectRevert(Registry.InvalidCollection.selector); registry.admitReviewed(address(0),0,1,1000,"");
        vm.expectRevert(Registry.InvalidCollection.selector); registry.admitReviewed(BUYER,0,1,1000,"");
        ReviewedWithoutRoyalty noRoyalty = new ReviewedWithoutRoyalty();
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.admitReviewed(address(noRoyalty),address(noRoyalty).codehash,1,1000,"");
        ReviewedInterfaceLiar liar = new ReviewedInterfaceLiar();
        vm.expectRevert(Registry.UnsupportedCollection.selector); registry.admitReviewed(address(liar),address(liar).codehash,1,1000,"");
        require(factory.collectionCount() == 1);
    }
    function testAuthorityOnlyRevocationConsumesVersionAndInvalidatesPresignedAdmission() public {
        _admit(address(nft),1);
        bytes memory beforeRevocation = _sign(registry.reviewPermitHash(address(nft),address(nft).codehash,2,1000));
        vm.expectRevert(Registry.OnlyReviewAuthority.selector); registry.revoke(address(nft),1);
        vm.prank(authority); vm.expectRevert(Registry.InvalidReviewVersion.selector); registry.revoke(address(nft),2);
        vm.recordLogs(); vm.prank(authority); registry.revoke(address(nft),1);
        ReviewedVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[0] == keccak256("ReviewRevoked(address,uint256,uint256)"));
        require(logs[0].topics[2] == bytes32(uint256(1)) && logs[0].topics[3] == bytes32(uint256(2)));
        vm.expectRevert(Registry.InactiveReview.selector); registry.requireActiveReview(address(nft),1);
        vm.expectRevert(Registry.InvalidReviewVersion.selector); registry.admitReviewed(address(nft),address(nft).codehash,2,1000,beforeRevocation);
        _admit(address(nft),3); require(registry.requireActiveReview(address(nft),3) == address(nft).codehash);
        vm.prank(authority); vm.expectRevert(Registry.InvalidReviewVersion.selector); registry.revoke(address(nft),1);
    }
    function testCodeHashAndFactoryIdentityCheckedOnEachUse() public {
        _admit(address(nft),1);
        bytes memory original = address(nft).code;
        vm.etch(address(nft),hex"60006000fd");
        vm.expectRevert(Registry.RuntimeCodeChanged.selector); registry.requireActiveReview(address(nft),1);
        vm.etch(address(nft),original);
        require(registry.requireActiveReview(address(nft),1) == address(nft).codehash);
        vm.etch(address(factory),hex"60006000fd");
        vm.expectRevert(Registry.InvalidFactory.selector); registry.requireActiveReview(address(nft),1);
    }
    function testContractAuthority1271WithoutGivingItAssetControl() public {
        Reviewed1271Authority wallet = new Reviewed1271Authority();
        Registry other = new Registry(factory,address(wallet),SALT);
        bytes32 hash = address(nft).codehash;
        wallet.allow(other.reviewPermitHash(address(nft),hash,1,1000));
        vm.prank(BUYER); other.admitReviewed(address(nft),hash,1,1000,hex"1234");
        require(other.requireActiveReview(address(nft),1) == hash);
        wallet.revoke(other,address(nft),1);
        (,uint256 version,bool active) = other.reviews(address(nft)); require(version == 2 && !active && nft.ownerOf(0) == SELLER);
    }
    function testOnlyExplicitTestChainsAndValidConstructorTerms() public {
        vm.chainId(84532); Registry base = new Registry(factory,authority,SALT); Market baseMarket = new Market(base,SALT);
        require(base.deploymentChainId() == 84532 && baseMarket.deploymentChainId() == 84532);
        vm.expectRevert(abi.encodeWithSelector(Registry.UnsupportedTestChain.selector,84532)); registry.requireActiveReview(address(nft),0);
        vm.expectRevert(Market.InvalidRegistry.selector); new Market(registry,SALT);
        vm.chainId(1); vm.expectRevert(abi.encodeWithSelector(Registry.UnsupportedTestChain.selector,1)); new Registry(factory,authority,SALT);
        vm.expectRevert(abi.encodeWithSelector(Market.UnsupportedTestChain.selector,1)); new Market(registry,SALT);
        vm.chainId(31337);
        vm.expectRevert(Registry.InvalidAuthority.selector); new Registry(factory,address(0),SALT);
        vm.expectRevert(Registry.InvalidDeploymentSalt.selector); new Registry(factory,authority,0);
        vm.expectRevert(Registry.InvalidFactory.selector); new Registry(OneshotNFTFactory(address(0)),authority,SALT);
        vm.expectRevert(Market.InvalidDeploymentSalt.selector); new Market(registry,0);
    }
}

contract OneshotReviewedMarketplaceTest is ReviewedTestBase {
    function setUp() public override { super.setUp(); _admit(address(nft),1); }
    function testHolderPushZeroAndSparseIdsNeedNoApprovalAndEmitBoundIntent() public {
        require(!nft.isApprovedForAll(SELLER,address(market)) && nft.getApproved(0) == address(0));
        Market.ListingIntent memory intent = _intent(0,101);
        bytes32 typeHash = keccak256("ListingIntent(address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt)");
        bytes32 expected = _digest(keccak256(abi.encode(typeHash,SELLER,address(nft),uint256(0),uint256(101),ROYALTY,uint256(7),uint256(1),uint256(0),uint256(1000),uint256(31337),address(market),SALT)),"OneshotReviewedMarketplace",address(market),31337);
        require(abi.encode(intent).length == 384 && market.listingIntentHash(intent) == expected);
        vm.recordLogs(); _push(intent); ReviewedVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2 && logs[0].emitter == address(nft) && logs[1].emitter == address(market));
        require(logs[1].topics[0] == keccak256("Listed(uint256,address,uint256,address,uint256,address,uint256,uint256,bytes32,bytes32)"));
        (,uint256 price,address receiver,uint256 royalty,uint256 version,bytes32 runtimeHash,bytes32 eventIntent) = abi.decode(logs[1].data,(address,uint256,address,uint256,uint256,bytes32,bytes32));
        require(price == 101 && receiver == ROYALTY && royalty == 7 && version == 1 && runtimeHash == address(nft).codehash && eventIntent == expected);
        require(_list(456789,1 ether) == 2 && _list(type(uint256).max,1 ether) == 3);
        require(nft.ownerOf(0) == address(market) && market.listingNonces(SELLER) == 3 && market.activeListing(address(nft),0) == 1);
        require(market.MARKETPLACE_VERSION() == 4 && market.ASSET_STANDARD() == type(IERC721).interfaceId && market.PLATFORM_FEE_BPS() == 200);
    }
    function testBuyUsesExactInclusivePricePullBalancesAndChosenRecipient() public {
        uint256 id = _list(0,101); vm.recordLogs(); _buy(id,101,address(123));
        require(nft.ownerOf(0) == address(123) && !_active(id) && market.activeListing(address(nft),0) == 0);
        require(market.pending(TREASURY) == 2 && market.pending(ROYALTY) == 7 && market.pending(SELLER) == 92);
        require(market.totalPending() == 101 && address(market).balance == 101);
        ReviewedVm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2 && logs[1].topics[0] == keccak256("Sold(uint256,address,address,uint256,uint256,address,uint256,uint256)"));
        (uint256 price,uint256 fee,address receiver,uint256 royalty,uint256 proceeds) = abi.decode(logs[1].data,(uint256,uint256,address,uint256,uint256));
        require(price == 101 && fee == 2 && receiver == ROYALTY && royalty == 7 && proceeds == 92);
        vm.prank(SELLER); market.claimTo(payable(address(456))); require(address(456).balance == 92 && market.totalPending() == 9);
        vm.prank(ROYALTY); market.claimTo(payable(ROYALTY));
        vm.prank(TREASURY); market.claimTo(payable(TREASURY));
        require(market.totalPending() == 0 && address(market).balance == 0);
    }
    function testIntentCannotBeReusedAfterCancellationAndRelisting() public {
        Market.ListingIntent memory first = _intent(0,101); _push(first);
        vm.prank(SELLER); market.cancel(1);
        vm.expectRevert(Market.InvalidNonce.selector); _push(first);
        require(nft.ownerOf(0) == SELLER && market.nextListingId() == 2 && market.listingNonces(SELLER) == 1);
        require(_list(0,202) == 2 && market.activeListing(address(nft),0) == 2);
        vm.expectRevert(Market.InactiveListing.selector); _buy(1,101,BUYER);
        _buy(2,202,BUYER);
    }
    function testOnlyActualHolderMayInitiateListingEvenIfOperatorApproved() public {
        Market.ListingIntent memory intent = _intent(0,101);
        vm.prank(SELLER); nft.approve(BUYER,0);
        vm.prank(BUYER); vm.expectRevert(Market.InvalidIntent.selector); nft.safeTransferFrom(SELLER,address(market),0,abi.encode(intent));
        vm.expectRevert(Market.InvalidIntent.selector); market.onERC721Received(SELLER,SELLER,0,abi.encode(intent));
        vm.prank(SELLER); vm.expectRevert(Market.InvalidIntent.selector); nft.safeTransferFrom(SELLER,address(market),0);
        require(nft.ownerOf(0) == SELLER && market.listingNonces(SELLER) == 0 && market.nextListingId() == 1);
        _push(intent);
    }
    function testListingIntentBindsAllUserTermsAndDeployment() public {
        for (uint256 i; i < 12; i++) {
            Market.ListingIntent memory intent = _intent(0,101);
            if (i == 0) intent.seller = BUYER;
            if (i == 1) intent.collection = address(factory);
            if (i == 2) intent.tokenId = 456789;
            if (i == 3) intent.totalPrice = 0;
            if (i == 4) intent.royaltyRecipient = BUYER;
            if (i == 5) intent.royaltyAmount = 8;
            if (i == 6) intent.reviewVersion = 2;
            if (i == 7) intent.nonce = 1;
            if (i == 8) intent.deadline = 99;
            if (i == 9) intent.chainId = 84532;
            if (i == 10) intent.marketplace = address(registry);
            if (i == 11) intent.deploymentSalt = keccak256("other");
            // Transfer the actual item from its actual holder; the intent may be wrong.
            vm.prank(SELLER); vm.expectRevert(); nft.safeTransferFrom(SELLER,address(market),0,abi.encode(intent));
            require(nft.ownerOf(0) == SELLER && market.nextListingId() == 1 && market.listingNonces(SELLER) == 0);
        }
        Market.ListingIntent memory correct = _intent(0,101);
        vm.prank(SELLER); vm.expectRevert(Market.InvalidIntent.selector); nft.safeTransferFrom(SELLER,address(market),0,abi.encodePacked(abi.encode(correct),bytes32(0)));
        vm.warp(1000); _push(correct); // Deadline is inclusive, as in native permits.
    }
    function testInvalidQuotesRevertWholeDepositAndNeverSilentlyZeroRoyalty() public {
        Market.ListingIntent memory intent = _intent(0,101);
        for (uint256 mode = 1; mode <= 6; mode++) {
            nft.setQuoteMode(mode); vm.expectRevert(Market.InvalidRoyalty.selector); _push(intent);
            require(nft.ownerOf(0) == SELLER && market.listingNonces(SELLER) == 0 && market.nextListingId() == 1);
        }
        nft.setQuoteMode(0); nft.setRoyalty(ROYALTY,1001);
        intent.totalPrice = 10_000; intent.royaltyAmount = 1001;
        vm.expectRevert(Market.InvalidRoyalty.selector); _push(intent);
        nft.setRoyalty(address(0),1000); vm.expectRevert(Market.InvalidRoyalty.selector); _push(intent);
        nft.setRoyalty(address(market),1000); vm.expectRevert(Market.InvalidRoyalty.selector); _push(intent);
        nft.setRoyalty(address(0),0); intent = _intent(0,1); _push(intent); _buy(1,1,BUYER);
        require(market.pending(SELLER) == 1 && market.pending(address(0)) == 0 && market.totalPending() == 1);
    }
    function testChangedRoyaltyRecipientOrAmountBlocksBuyUntilSellerCancelsAndRelists() public {
        uint256 id = _list(0,10_000);
        nft.setRoyalty(ROYALTY,1000); vm.expectRevert(Market.RoyaltyChanged.selector); _buy(id,10_000,BUYER);
        nft.setRoyalty(BUYER,750); vm.expectRevert(Market.RoyaltyChanged.selector); _buy(id,10_000,BUYER);
        nft.setQuoteMode(1); vm.expectRevert(Market.InvalidRoyalty.selector); _buy(id,10_000,BUYER);
        require(_active(id) && nft.ownerOf(0) == address(market) && market.totalPending() == 0);
        vm.prank(SELLER); market.cancel(id); nft.setQuoteMode(0);
        uint256 replacement = _list(0,10_000); _buy(replacement,10_000,BUYER);
        require(market.pending(BUYER) == 750 && market.pending(SELLER) == 9050);
    }
    function testNewReviewVersionInvalidatesExistingListingEvenIfSameRuntime() public {
        uint256 id = _list(0,101); _admit(address(nft),2);
        vm.expectRevert(Registry.InvalidReviewVersion.selector); _buy(id,101,BUYER);
        vm.prank(SELLER); market.cancel(id);
        uint256 replacement = _list(0,101); _buy(replacement,101,BUYER);
        require(nft.ownerOf(0) == BUYER);
    }
    function testRevocationAndUnavailableProviderCannotBlockCancellationOrPriorProceeds() public {
        uint256 sold = _list(0,101); _buy(sold,101,BUYER); uint256 unsold = _list(456789,202);
        vm.prank(authority); registry.revoke(address(nft),1);
        vm.expectRevert(Registry.InactiveReview.selector); _buy(unsold,202,BUYER);
        nft.setQuoteMode(1); vm.etch(address(registry),hex"60006000fd"); vm.etch(address(factory),hex"60006000fd"); vm.chainId(1);
        vm.prank(SELLER); market.cancelTo(unsold,address(123));
        vm.prank(SELLER); market.claimTo(payable(SELLER));
        require(nft.ownerOf(456789) == address(123) && market.pending(SELLER) == 0 && market.totalPending() == 9);
    }
    function testRuntimeMutationBlocksExecutionButOriginalTokenStillCancelable() public {
        uint256 id = _list(0,101); bytes memory original = address(nft).code;
        vm.etch(address(nft),hex"60006000fd");
        vm.expectRevert(Registry.RuntimeCodeChanged.selector); _buy(id,101,BUYER);
        vm.etch(address(nft),original); vm.prank(SELLER); market.cancel(id);
        require(nft.ownerOf(0) == SELLER && market.totalPending() == 0);
    }
    function testExactPriceCapRecipientAndSelfPurchaseChecksPreserveCustody() public {
        uint256 id = _list(0,101);
        vm.prank(SELLER); vm.expectRevert(Market.SelfPurchase.selector); market.buy{value:101}(id,101,BUYER);
        vm.prank(BUYER); vm.expectRevert(Market.PriceLimit.selector); market.buy{value:101}(id,100,BUYER);
        vm.prank(BUYER); vm.expectRevert(Market.IncorrectPayment.selector); market.buy{value:100}(id,101,BUYER);
        vm.prank(BUYER); vm.expectRevert(Market.IncorrectPayment.selector); market.buy{value:102}(id,101,BUYER);
        vm.expectRevert(Market.InvalidRecipient.selector); _buy(id,101,address(0));
        vm.expectRevert(Market.InvalidRecipient.selector); _buy(id,101,address(market));
        vm.expectRevert(Market.NotSeller.selector); market.cancel(id);
        vm.prank(SELLER); vm.expectRevert(Market.InvalidRecipient.selector); market.cancelTo(id,address(market));
        vm.expectRevert(Market.NothingToClaim.selector); market.claimTo(payable(BUYER));
        require(_active(id) && nft.ownerOf(0) == address(market) && address(market).balance == 0);
    }
    function testRejectedNftRecipientRollsBackSaleAndCancellationAndCanBeRoutedElsewhere() public {
        uint256 id = _list(0,101); ReviewedWallet wallet = new ReviewedWallet(); wallet.arm(address(0),"",false,true);
        vm.expectRevert(); _buy(id,101,address(wallet));
        require(_active(id) && market.totalPending() == 0 && address(market).balance == 0);
        vm.prank(SELLER); vm.expectRevert(); market.cancelTo(id,address(wallet));
        require(_active(id) && nft.ownerOf(0) == address(market));
        vm.prank(SELLER); market.cancelTo(id,BUYER); require(nft.ownerOf(0) == BUYER);
    }
    function testRejectedNativeClaimPreservesBalanceAndCanChooseAnotherRecipient() public {
        _buy(_list(0,101),101,BUYER); ReviewedWallet rejecting = new ReviewedWallet(); rejecting.arm(address(0),"",true,false);
        vm.prank(SELLER); vm.expectRevert(Market.PaymentFailed.selector); market.claimTo(payable(address(rejecting)));
        require(market.pending(SELLER) == 92 && market.totalPending() == 101 && address(market).balance == 101);
        vm.prank(SELLER); market.claimTo(payable(BUYER)); require(market.pending(SELLER) == 0 && market.totalPending() == 9);
    }
    function testNftAndNativeCallbacksCannotReenterAccounting() public {
        uint256 id = _list(0,101); ReviewedWallet wallet = new ReviewedWallet();
        wallet.arm(address(market),abi.encodeCall(Market.buy,(id,uint256(101),BUYER)),false,false);
        _buy(id,101,address(wallet)); require(!wallet.nestedSucceeded() && wallet.nestedFailure() == bytes4(keccak256("ReentrancyGuardReentrantCall()")) && market.totalPending() == 101 && !_active(id));
        wallet.arm(address(market),abi.encodeCall(Market.claimTo,(payable(BUYER))),false,false);
        vm.prank(SELLER); market.claimTo(payable(address(wallet)));
        require(!wallet.nestedSucceeded() && wallet.nestedFailure() == bytes4(keccak256("ReentrancyGuardReentrantCall()")) && market.pending(SELLER) == 0 && market.totalPending() == 9);
    }
    function testReceiverMayForwardPurchasedNftWithoutInvalidatingSettlement() public {
        ReviewedForwardReceiver receiver = new ReviewedForwardReceiver(address(123));
        _buy(_list(0,101),101,address(receiver));
        require(nft.ownerOf(0) == address(123) && market.pending(SELLER) == 92 && market.totalPending() == 101);
    }
    function testContractHolderPushAndCancelToWithoutBlanketApproval() public {
        ReviewedWallet wallet = new ReviewedWallet();
        vm.prank(SELLER); nft.transferFrom(SELLER,address(wallet),0);
        Market.ListingIntent memory intent = _intent(0,101); intent.seller = address(wallet); intent.nonce = 0;
        wallet.execute(address(nft),abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)",address(wallet),address(market),uint256(0),abi.encode(intent)),0);
        require(nft.ownerOf(0) == address(market) && !nft.isApprovedForAll(address(wallet),address(market)));
        wallet.arm(address(0),"",false,true);
        vm.expectRevert(); wallet.execute(address(market),abi.encodeCall(Market.cancel,(uint256(1))),0);
        wallet.execute(address(market),abi.encodeCall(Market.cancelTo,(uint256(1),BUYER)),0);
        require(nft.ownerOf(0) == BUYER && !_active(1));
    }
    function testFuzzEveryNativeUnitAccountedAtInclusivePrice(uint96 amount,uint16 royaltyRate) public {
        uint256 price = uint256(amount) + 1;
        uint256 bps = uint256(royaltyRate) % 1001;
        nft.setRoyalty(ROYALTY,bps); vm.deal(BUYER,price);
        _buy(_list(0,price),price,BUYER);
        uint256 fee = Math.mulDiv(price,200,10_000); uint256 royalty = Math.mulDiv(price,bps,10_000);
        require(market.pending(TREASURY) == fee && market.pending(ROYALTY) == royalty && market.pending(SELLER) == price-fee-royalty);
        require(market.totalPending() == price && address(market).balance == price);
    }
}
