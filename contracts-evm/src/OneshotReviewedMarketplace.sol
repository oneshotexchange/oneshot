// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotNFTFactory} from "./OneshotNFTFactory.sol";
import {OneshotReviewedCollectionRegistry} from "./OneshotReviewedCollectionRegistry.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice Whole-item, fixed-price external ERC-721 trading. No ERC-1155, offers,
/// upgrade, administrator withdrawal or token-rescue entrypoint exists.
/// @dev Only holder-initiated safe transfers with a complete listing intent are
/// accepted. Plain unsafe ERC-721 transfers cannot be intercepted or recovered.
contract OneshotReviewedMarketplace is IERC721Receiver, EIP712, ReentrancyGuard {
    uint256 public constant MARKETPLACE_VERSION = 4;
    bytes4 public constant ASSET_STANDARD = type(IERC721).interfaceId;
    uint256 public constant PLATFORM_FEE_BPS = 200;
    uint256 public constant MAX_LISTING_INTENT_BYTES = 384;
    uint256 public constant ROYALTY_QUOTE_GAS_LIMIT = 100_000;
    OneshotReviewedCollectionRegistry public immutable registry;
    OneshotNFTFactory public immutable oneshotFactory;
    address public immutable treasury;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentSalt;
    uint256 public nextListingId = 1;
    uint256 public totalPending;
    mapping(address => uint256) public listingNonces;
    struct ListingIntent {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 totalPrice;
        address royaltyRecipient;
        uint256 royaltyAmount;
        uint256 reviewVersion;
        uint256 nonce;
        uint256 deadline;
        uint256 chainId;
        address marketplace;
        bytes32 deploymentSalt;
    }
    struct Listing {
        address collection;
        address seller;
        uint256 tokenId;
        uint256 totalPrice;
        address royaltyRecipient;
        uint256 royaltyAmount;
        uint256 reviewVersion;
        bytes32 runtimeCodeHash;
        bool active;
    }
    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) public activeListing;
    mapping(address => uint256) public pending;
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "ListingIntent(address seller,address collection,uint256 tokenId,uint256 totalPrice,address royaltyRecipient,uint256 royaltyAmount,uint256 reviewVersion,uint256 nonce,uint256 deadline,uint256 chainId,address marketplace,bytes32 deploymentSalt)"
    );
    error UnsupportedTestChain(uint256 chainId);
    error InvalidRegistry();
    error InvalidDeploymentSalt();
    error InvalidIntent();
    error IntentExpired();
    error InvalidNonce();
    error NotOwner();
    error AlreadyListed();
    error InactiveListing();
    error SelfPurchase();
    error InvalidRecipient();
    error InvalidPrice();
    error PriceLimit();
    error IncorrectPayment();
    error InvalidRoyalty();
    error RoyaltyChanged();
    error NotSeller();
    error NothingToClaim();
    error PaymentFailed();
    event Listed(uint256 indexed listingId, address indexed collection, uint256 indexed tokenId, address seller, uint256 totalPrice, address royaltyRecipient, uint256 royaltyAmount, uint256 reviewVersion, bytes32 runtimeCodeHash, bytes32 intentHash);
    event Sold(uint256 indexed listingId, address indexed buyer, address indexed recipient, uint256 totalPrice, uint256 platformFee, address royaltyRecipient, uint256 royaltyAmount, uint256 sellerProceeds);
    event Cancelled(uint256 indexed listingId, address indexed seller, address indexed recipient);
    event Claimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(OneshotReviewedCollectionRegistry registry_, bytes32 salt_) EIP712("OneshotReviewedMarketplace", "1") {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedTestChain(block.chainid);
        if (address(registry_).code.length == 0 || registry_.REGISTRY_VERSION() != 1
            || registry_.ASSET_STANDARD() != type(IERC721).interfaceId || registry_.deploymentChainId() != block.chainid) revert InvalidRegistry();
        if (salt_ == bytes32(0)) revert InvalidDeploymentSalt();
        registry = registry_; oneshotFactory = registry_.oneshotFactory(); treasury = registry_.oneshotFactory().treasury();
        if (treasury == address(0)) revert InvalidRegistry();
        deploymentSalt = salt_; deploymentChainId = block.chainid;
    }

    function listingIntentHash(ListingIntent memory intent) public view returns (bytes32) {
        // The tuple is entirely static: ABI encoding is exactly its twelve fields.
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent)));
    }

    /// @notice The holder signs safeTransferFrom(holder,this,id,abi.encode(intent))
    /// on the reviewed NFT contract. No setApprovalForAll or extra signature is needed.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external nonReentrant returns (bytes4) {
        if (block.chainid != deploymentChainId) revert UnsupportedTestChain(block.chainid);
        if (data.length != MAX_LISTING_INTENT_BYTES || operator != from || from == address(0) || from == address(this)) revert InvalidIntent();
        ListingIntent memory intent = abi.decode(data, (ListingIntent));
        if (intent.seller != from || intent.collection != msg.sender || intent.tokenId != tokenId || intent.chainId != block.chainid
            || intent.marketplace != address(this) || intent.deploymentSalt != deploymentSalt) revert InvalidIntent();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.nonce != listingNonces[from]) revert InvalidNonce();
        if (intent.totalPrice == 0) revert InvalidPrice();
        if (activeListing[msg.sender][tokenId] != 0) revert AlreadyListed();
        bytes32 codeHash = registry.requireActiveReview(msg.sender, intent.reviewVersion);
        if (IERC721(msg.sender).ownerOf(tokenId) != address(this)) revert NotOwner();
        (address receiver, uint256 royalty) = _royalty(msg.sender, tokenId, intent.totalPrice);
        if (receiver != intent.royaltyRecipient || royalty != intent.royaltyAmount) revert RoyaltyChanged();
        uint256 listingId = nextListingId++;
        listingNonces[from] = intent.nonce + 1;
        listings[listingId] = Listing(msg.sender, from, tokenId, intent.totalPrice, receiver, royalty, intent.reviewVersion, codeHash, true);
        activeListing[msg.sender][tokenId] = listingId;
        emit Listed(listingId, msg.sender, tokenId, from, intent.totalPrice, receiver, royalty, intent.reviewVersion, codeHash, listingIntentHash(intent));
        return IERC721Receiver.onERC721Received.selector;
    }

    function buy(uint256 listingId, uint256 maximumTotalPrice, address recipient) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert InactiveListing();
        if (msg.sender == listing.seller) revert SelfPurchase();
        _recipient(recipient);
        if (listing.totalPrice > maximumTotalPrice) revert PriceLimit();
        if (msg.value != listing.totalPrice) revert IncorrectPayment();
        if (registry.requireActiveReview(listing.collection, listing.reviewVersion) != listing.runtimeCodeHash) revert InvalidRegistry();
        (address receiver, uint256 royalty) = _royalty(listing.collection, listing.tokenId, listing.totalPrice);
        if (receiver != listing.royaltyRecipient || royalty != listing.royaltyAmount) revert RoyaltyChanged();
        uint256 fee = Math.mulDiv(listing.totalPrice, PLATFORM_FEE_BPS, 10_000);
        uint256 sellerProceeds = listing.totalPrice - fee - royalty;
        listing.active = false; delete activeListing[listing.collection][listing.tokenId];
        pending[treasury] += fee; pending[receiver] += royalty; pending[listing.seller] += sellerProceeds; totalPending += listing.totalPrice;
        IERC721(listing.collection).safeTransferFrom(address(this), recipient, listing.tokenId);
        emit Sold(listingId, msg.sender, recipient, listing.totalPrice, fee, receiver, royalty, sellerProceeds);
    }

    function cancel(uint256 listingId) external nonReentrant { _cancel(listingId, msg.sender); }
    function cancelTo(uint256 listingId, address recipient) external nonReentrant { _cancel(listingId, recipient); }
    function _cancel(uint256 listingId, address recipient) private {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert InactiveListing();
        if (msg.sender != listing.seller) revert NotSeller();
        _recipient(recipient);
        listing.active = false; delete activeListing[listing.collection][listing.tokenId];
        IERC721(listing.collection).safeTransferFrom(address(this), recipient, listing.tokenId);
        emit Cancelled(listingId, msg.sender, recipient);
    }
    function claimTo(address payable recipient) external nonReentrant {
        _recipient(recipient); uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pending[msg.sender] = 0; totalPending -= amount;
        (bool success,) = recipient.call{value: amount}(""); if (!success) revert PaymentFailed();
        emit Claimed(msg.sender, recipient, amount);
    }

    /// @dev Bound both execution gas and copied return data. A failed, malformed,
    /// over-cap or unpayable quote is an error, never a silently zeroed royalty.
    function _royalty(address collection, uint256 tokenId, uint256 price) private view returns (address receiver, uint256 amount) {
        bytes memory input = abi.encodeCall(IERC2981.royaltyInfo, (tokenId, price));
        bool ok; uint256 size; uint256 receiverWord;
        assembly ("memory-safe") {
            let output := mload(0x40)
            ok := staticcall(100000, collection, add(input, 32), mload(input), output, 64)
            size := returndatasize()
            receiverWord := mload(output)
            amount := mload(add(output, 32))
        }
        if (!ok || size != 64 || receiverWord > type(uint160).max || amount > price / 10) revert InvalidRoyalty();
        receiver = address(uint160(receiverWord));
        if (amount != 0 && (receiver == address(0) || receiver == address(this))) revert InvalidRoyalty();
    }
    function _recipient(address recipient) private view { if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient(); }
}
