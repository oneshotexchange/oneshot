// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotNFTFactory} from "./OneshotNFTFactory.sol";
import {OneshotCollection} from "./OneshotCollection.sol";

/// @notice Local-only escrow marketplace requiring a server-authorized price for every new listing.
/// @dev Authorization controls admission only. Settlement, seller exits and claims never depend on it.
contract OneshotGuardedMarketplace is IERC721Receiver, ReentrancyGuard, EIP712 {
    uint256 public constant PLATFORM_FEE_BPS = 200;
    OneshotNFTFactory public immutable factory;
    address public immutable treasury;
    address public immutable listingAuthority;
    bytes32 public immutable deploymentSalt;
    mapping(address => uint256) public listingNonces;
    mapping(address => bytes32) public policyCommitment;
    mapping(bytes32 => bool) private _usedPolicyPermits;
    mapping(address => mapping(bytes32 => bool)) private _usedPolicyCommitments;
    bytes32 private constant LISTING_PERMIT_TYPEHASH = keccak256(
        "ListingPermit(address seller,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)"
    );
    bytes32 private constant POLICY_PERMIT_TYPEHASH = keccak256(
        "PolicyPermit(address creator,address collection,bytes32 commitment,bytes32 expectedCommitment,uint256 deadline,bytes32 deploymentSalt)"
    );
    uint256 public nextListingId = 1;
    uint256 public totalPending;

    struct Listing {
        address collection;
        address seller;
        uint256 tokenId;
        uint256 price;
        bool active;
    }
    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) public activeListing;
    mapping(address => uint256) public pending;
    address private _expectedCollection;
    address private _expectedSeller;
    uint256 private _expectedTokenId;

    error InvalidFactory();
    error UnknownCollection();
    error InvalidPrice();
    error NotOwner();
    error AlreadyListed();
    error InactiveListing();
    error NotSeller();
    error SelfPurchase();
    error PriceLimit();
    error IncorrectPayment();
    error InvalidRecipient();
    error UnexpectedTransfer();
    error InvalidRoyalty();
    error NothingToClaim();
    error PaymentFailed();
    error LocalChainOnly();
    error InvalidListingAuthority();
    error InvalidDeploymentSalt();
    error AuthorizationExpired();
    error InvalidAuthorization();
    error InvalidNonce();
    error PolicyChanged();
    error InvalidPolicyCommitment();
    error OnlyCreator();
    error PolicyAuthorizationUsed();

    event Listed(
        uint256 indexed listingId,
        address indexed collection,
        uint256 indexed tokenId,
        address seller,
        uint256 totalPrice
    );
    event Cancelled(uint256 indexed listingId, address indexed seller, address indexed recipient);
    event Sold(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed recipient,
        uint256 totalPrice,
        uint256 platformFee,
        uint256 royalty,
        uint256 sellerProceeds
    );
    event Claimed(address indexed account, address indexed recipient, uint256 amount);
    event PolicyCommitted(address indexed collection, bytes32 indexed previousCommitment, bytes32 indexed commitment);

    constructor(OneshotNFTFactory factory_, address listingAuthority_, bytes32 deploymentSalt_)
        EIP712("OneshotGuardedMarketplace", "1")
    {
        if (block.chainid != 31337) revert LocalChainOnly();
        if (listingAuthority_ == address(0)) revert InvalidListingAuthority();
        if (deploymentSalt_ == bytes32(0)) revert InvalidDeploymentSalt();
        if (address(factory_).code.length == 0) revert InvalidFactory();
        factory = factory_;
        treasury = factory_.treasury();
        if (treasury == address(0)) revert InvalidFactory();
        listingAuthority = listingAuthority_;
        deploymentSalt = deploymentSalt_;
    }

    /// @notice The seller approves the exact authorized final price before the NFT enters escrow.
    /// @dev There is no unguarded listing entry point. The authority keeps policy inputs offchain.
    function listAuthorized(
        address collection,
        uint256 tokenId,
        uint256 totalPrice,
        uint256 nonce,
        bytes32 expectedPolicyCommitment,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant returns (uint256 listingId) {
        if (block.chainid != 31337) revert LocalChainOnly();
        if (!factory.isCollection(collection)) revert UnknownCollection();
        if (totalPrice == 0) revert InvalidPrice();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (nonce != listingNonces[msg.sender]) revert InvalidNonce();
        if (expectedPolicyCommitment != policyCommitment[collection]) revert PolicyChanged();
        _authorize(keccak256(abi.encode(
            LISTING_PERMIT_TYPEHASH, msg.sender, collection, tokenId, totalPrice, nonce,
            expectedPolicyCommitment, deadline, deploymentSalt
        )), signature);
        if (activeListing[collection][tokenId] != 0) revert AlreadyListed();
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotOwner();
        listingNonces[msg.sender] = nonce + 1;
        listingId = nextListingId++;
        listings[listingId] = Listing(collection, msg.sender, tokenId, totalPrice, true);
        activeListing[collection][tokenId] = listingId;
        _expectedCollection = collection;
        _expectedSeller = msg.sender;
        _expectedTokenId = tokenId;
        IERC721(collection).safeTransferFrom(msg.sender, address(this), tokenId);
        delete _expectedCollection;
        delete _expectedSeller;
        delete _expectedTokenId;
        emit Listed(listingId, collection, tokenId, msg.sender, totalPrice);
    }

    /// @notice Commit a privately reviewed policy for this creator's future listings.
    /// @dev Existing escrow orders retain their approved prices. Hashes and final prices are public.
    function setPolicyCommitment(
        address collection,
        bytes32 newCommitment,
        bytes32 expectedCommitment,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        if (block.chainid != 31337) revert LocalChainOnly();
        if (!factory.isCollection(collection)) revert UnknownCollection();
        if (OneshotCollection(collection).creator() != msg.sender) revert OnlyCreator();
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (newCommitment == bytes32(0) || newCommitment == expectedCommitment) revert InvalidPolicyCommitment();
        if (policyCommitment[collection] != expectedCommitment) revert PolicyChanged();
        if (_usedPolicyCommitments[collection][newCommitment]) revert InvalidPolicyCommitment();
        bytes32 structHash = keccak256(abi.encode(
            POLICY_PERMIT_TYPEHASH, msg.sender, collection, newCommitment, expectedCommitment, deadline, deploymentSalt
        ));
        if (_usedPolicyPermits[structHash]) revert PolicyAuthorizationUsed();
        _authorize(structHash, signature);
        _usedPolicyPermits[structHash] = true;
        // Every policy revision has a fresh salted commitment, so a retired policy cannot revive old listing permits.
        _usedPolicyCommitments[collection][newCommitment] = true;
        policyCommitment[collection] = newCommitment;
        emit PolicyCommitted(collection, expectedCommitment, newCommitment);
    }

    function _authorize(bytes32 structHash, bytes calldata signature) private view {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        if (error != ECDSA.RecoverError.NoError || signer != listingAuthority) revert InvalidAuthorization();
    }

    function buy(uint256 listingId, uint256 maximumTotalPrice, address recipient) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert InactiveListing();
        if (msg.sender == listing.seller) revert SelfPurchase();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 price = listing.price;
        if (price > maximumTotalPrice) revert PriceLimit();
        if (msg.value != price) revert IncorrectPayment();
        (address royaltyRecipient, uint256 royalty) =
            OneshotCollection(listing.collection).royaltyInfo(listing.tokenId, price);
        uint256 fee = Math.mulDiv(price, PLATFORM_FEE_BPS, 10_000);
        if (royalty > price / 10 || (royalty != 0 && royaltyRecipient == address(0))) revert InvalidRoyalty();
        uint256 sellerProceeds = price - fee - royalty;
        listing.active = false;
        delete activeListing[listing.collection][listing.tokenId];
        pending[treasury] += fee;
        pending[royaltyRecipient] += royalty;
        pending[listing.seller] += sellerProceeds;
        totalPending += price;
        IERC721(listing.collection).safeTransferFrom(address(this), recipient, listing.tokenId);
        emit Sold(listingId, msg.sender, recipient, price, fee, royalty, sellerProceeds);
    }

    /// @notice Only the seller can cancel, and escrow is returned to that seller.
    function cancel(uint256 listingId) external nonReentrant {
        _cancel(listingId, msg.sender);
    }

    /// @notice Contract sellers without an ERC721 receiver can recover to a compatible recipient.
    function cancelTo(uint256 listingId, address recipient) external nonReentrant {
        _cancel(listingId, recipient);
    }

    function _cancel(uint256 listingId, address recipient) private {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert InactiveListing();
        if (msg.sender != listing.seller) revert NotSeller();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        listing.active = false;
        delete activeListing[listing.collection][listing.tokenId];
        IERC721(listing.collection).safeTransferFrom(address(this), recipient, listing.tokenId);
        emit Cancelled(listingId, msg.sender, recipient);
    }

    function claimTo(address payable recipient) external nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pending[msg.sender] = 0;
        totalPending -= amount;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert PaymentFailed();
        emit Claimed(msg.sender, recipient, amount);
    }

    /// @dev Accept only the safe transfer initiated by listAuthorized(); unsolicited safe deposits revert.
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (
            msg.sender != _expectedCollection || operator != address(this) || from != _expectedSeller
                || tokenId != _expectedTokenId
        ) revert UnexpectedTransfer();
        return IERC721Receiver.onERC721Received.selector;
    }
}
