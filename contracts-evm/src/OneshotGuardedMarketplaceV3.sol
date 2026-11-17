// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotGuardedMarketplace} from "./OneshotGuardedMarketplace.sol";
import {OneshotNFTFactory} from "./OneshotNFTFactory.sol";
import {OneshotCollection} from "./OneshotCollection.sol";

/// @notice Additive testnet market: funded native offers and atomic listing purchases.
/// Offer funds are liabilities, never revenue until accepted. Existing v2 admission,
/// escrow exits and pull claims keep their original behavior and signing domain.
contract OneshotGuardedMarketplaceV3 is OneshotGuardedMarketplace {
    uint256 public constant MARKETPLACE_VERSION = 3;
    uint256 public constant MAX_BATCH_BUY = 20;
    uint256 public constant MAX_OFFER_QUANTITY = 20;
    uint256 public nextOfferId = 1;
    uint256 public totalOfferEscrow;
    mapping(address => uint256) public offerAcceptanceNonces;
    struct Offer {
        address collection;
        address bidder;
        address recipient;
        uint256 tokenId;
        uint256 unitPrice;
        uint256 remaining;
        uint256 expiry;
    }
    struct Settlement { uint256 price; uint256 fee; uint256 royalty; uint256 proceeds; }
    mapping(uint256 => Offer) public offers;
    bytes32 private constant OFFER_ACCEPTANCE_TYPEHASH = keccak256(
        "OfferAcceptancePermit(address seller,uint256 offerId,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)"
    );

    error CollectionNotOpen();
    error InvalidOfferQuantity();
    error InvalidOfferExpiry();
    error InactiveOffer();
    error OfferHasExpired();
    error OfferNotExpired();
    error NotBidder();
    error WrongOfferItem();
    error InvalidBatch();
    error DuplicateListing();
    error InsolventAccounting();

    event OfferCreated(uint256 indexed offerId, address indexed collection, address indexed bidder, uint256 tokenId, uint256 unitPrice, uint256 quantity, address recipient, uint256 expiry);
    event OfferCancelled(uint256 indexed offerId, address indexed bidder, uint256 quantity, uint256 refund);
    event OfferExpired(uint256 indexed offerId, address indexed bidder, address indexed caller, uint256 quantity, uint256 refund);
    event OfferAccepted(uint256 indexed offerId, address indexed collection, uint256 indexed tokenId, address seller, address bidder, address recipient, uint256 totalPrice, uint256 platformFee, uint256 royalty, uint256 sellerProceeds, uint256 replacedListingId);

    constructor(OneshotNFTFactory factory_, address authority_, bytes32 salt_)
        OneshotGuardedMarketplace(factory_, authority_, salt_) {}

    /// @notice tokenId zero selects any minted NFT in this collection. Otherwise
    /// the offer is for one exact item. The recipient and price never change.
    function createOffer(address collection, uint256 tokenId, uint256 unitPrice, uint256 quantity, address recipient, uint256 expiry)
        external payable nonReentrant returns (uint256 offerId)
    {
        _admission(); _openCollection(collection); _recipient(recipient);
        if (quantity == 0 || quantity > MAX_OFFER_QUANTITY || (tokenId != 0 && quantity != 1)) revert InvalidOfferQuantity();
        if (unitPrice == 0 || unitPrice > type(uint256).max / quantity) revert InvalidPrice();
        if (expiry <= block.timestamp) revert InvalidOfferExpiry();
        if (tokenId != 0) IERC721(collection).ownerOf(tokenId);
        uint256 reserved = unitPrice * quantity;
        if (msg.value != reserved) revert IncorrectPayment();
        offerId = nextOfferId++;
        offers[offerId] = Offer(collection, msg.sender, recipient, tokenId, unitPrice, quantity, expiry);
        totalOfferEscrow += reserved;
        _solvent();
        emit OfferCreated(offerId, collection, msg.sender, tokenId, unitPrice, quantity, recipient, expiry);
    }

    /// @notice A final-price permit applies the collection's current private policy.
    /// The seller may own the NFT directly or have it in this market's listing escrow.
    function acceptOffer(uint256 offerId, uint256 tokenId, uint256 nonce, bytes32 expectedPolicyCommitment, uint256 deadline, bytes calldata signature)
        external nonReentrant
    {
        _admission();
        Offer storage offer = offers[offerId];
        if (offer.remaining == 0) revert InactiveOffer();
        if (block.timestamp > offer.expiry) revert OfferHasExpired();
        if (tokenId == 0 || (offer.tokenId != 0 && offer.tokenId != tokenId)) revert WrongOfferItem();
        if (msg.sender == offer.bidder) revert SelfPurchase();
        _openCollection(offer.collection);
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (nonce != offerAcceptanceNonces[msg.sender]) revert InvalidNonce();
        if (expectedPolicyCommitment != policyCommitment[offer.collection]) revert PolicyChanged();
        _authorizeOffer(offerId, tokenId, nonce, expectedPolicyCommitment, deadline, signature);
        (address from, uint256 replaced) = _releaseSource(offer.collection, tokenId);
        offerAcceptanceNonces[msg.sender] = nonce + 1;
        offer.remaining--;
        totalOfferEscrow -= offer.unitPrice;
        Settlement memory sale = _credit(offer.collection, tokenId, offer.unitPrice, msg.sender);
        IERC721(offer.collection).safeTransferFrom(from, offer.recipient, tokenId);
        _solvent();
        _emitAccepted(offerId, tokenId, replaced, sale);
    }

    function _authorizeOffer(uint256 offerId, uint256 tokenId, uint256 nonce, bytes32 commitment, uint256 deadline, bytes calldata signature) private view {
        Offer storage offer = offers[offerId];
        bytes32 structHash = keccak256(abi.encode(OFFER_ACCEPTANCE_TYPEHASH, msg.sender, offerId, offer.collection, tokenId, offer.unitPrice, nonce, commitment, deadline, deploymentSalt));
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(_hashTypedDataV4(structHash), signature);
        if (error != ECDSA.RecoverError.NoError || signer != listingAuthority) revert InvalidAuthorization();
    }

    function _emitAccepted(uint256 offerId, uint256 tokenId, uint256 replaced, Settlement memory sale) private {
        Offer storage offer = offers[offerId];
        emit OfferAccepted(offerId, offer.collection, tokenId, msg.sender, offer.bidder, offer.recipient, sale.price, sale.fee, sale.royalty, sale.proceeds, replaced);
    }

    function _releaseSource(address collection, uint256 tokenId) private returns (address from, uint256 replaced) {
        replaced = activeListing[collection][tokenId];
        if (replaced == 0) {
            if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotOwner();
            return (msg.sender, 0);
        }
        Listing storage listing = listings[replaced];
        if (!listing.active || listing.seller != msg.sender || listing.collection != collection || listing.tokenId != tokenId
            || IERC721(collection).ownerOf(tokenId) != address(this)) revert NotSeller();
        listing.active = false;
        delete activeListing[collection][tokenId];
        return (address(this), replaced);
    }

    /// @notice Cancellation/expiry always returns every unused unit to the bidder's
    /// existing pull balance. Neither the authority nor policy can block an exit.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (offer.remaining == 0) revert InactiveOffer();
        if (offer.bidder != msg.sender) revert NotBidder();
        (uint256 quantity, uint256 refund) = _refund(offer);
        emit OfferCancelled(offerId, offer.bidder, quantity, refund);
    }

    function releaseExpiredOffer(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        if (offer.remaining == 0) revert InactiveOffer();
        if (block.timestamp <= offer.expiry) revert OfferNotExpired();
        (uint256 quantity, uint256 refund) = _refund(offer);
        emit OfferExpired(offerId, offer.bidder, msg.sender, quantity, refund);
    }

    function _refund(Offer storage offer) private returns (uint256 quantity, uint256 refund) {
        quantity = offer.remaining; refund = quantity * offer.unitPrice;
        offer.remaining = 0; totalOfferEscrow -= refund;
        pending[offer.bidder] += refund; totalPending += refund;
        _solvent();
    }

    /// @notice One exact total payment. Any stale item or rejecting receiver rolls
    /// back every sale, native liability and NFT transfer in this batch.
    function buyBatch(uint256[] calldata listingIds, uint256 maximumTotalPrice, address recipient) external payable nonReentrant {
        _recipient(recipient);
        if (listingIds.length == 0 || listingIds.length > MAX_BATCH_BUY) revert InvalidBatch();
        uint256 total;
        for (uint256 i; i < listingIds.length; i++) {
            for (uint256 j; j < i; j++) if (listingIds[i] == listingIds[j]) revert DuplicateListing();
            Listing storage listing = listings[listingIds[i]];
            if (!listing.active) revert InactiveListing();
            if (listing.seller == msg.sender) revert SelfPurchase();
            _openCollection(listing.collection);
            total += listing.price;
        }
        if (total > maximumTotalPrice) revert PriceLimit();
        if (msg.value != total) revert IncorrectPayment();
        for (uint256 i; i < listingIds.length; i++) {
            Listing storage listing = listings[listingIds[i]];
            Settlement memory sale = _credit(listing.collection, listing.tokenId, listing.price, listing.seller);
            listing.active = false; delete activeListing[listing.collection][listing.tokenId];
            IERC721(listing.collection).safeTransferFrom(address(this), recipient, listing.tokenId);
            emit Sold(listingIds[i], msg.sender, recipient, sale.price, sale.fee, sale.royalty, sale.proceeds);
        }
        _solvent();
    }

    function _credit(address collection, uint256 tokenId, uint256 price, address seller) private returns (Settlement memory sale) {
        (address royaltyRecipient, uint256 royalty) = OneshotCollection(collection).royaltyInfo(tokenId, price);
        uint256 fee = Math.mulDiv(price, PLATFORM_FEE_BPS, 10_000);
        if (royalty > price / 10 || (royalty != 0 && royaltyRecipient == address(0))) revert InvalidRoyalty();
        sale = Settlement(price, fee, royalty, price - fee - royalty);
        pending[treasury] += fee; pending[royaltyRecipient] += royalty; pending[seller] += sale.proceeds;
        totalPending += price;
    }

    function _openCollection(address collection) private view {
        if (!factory.isCollection(collection)) revert UnknownCollection();
        if (!OneshotCollection(collection).opened()) revert CollectionNotOpen();
    }
    function _admission() private view { if (block.chainid != deploymentChainId) revert UnsupportedTestChain(block.chainid); }
    function _recipient(address recipient) private view { if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient(); }
    function _solvent() private view { if (address(this).balance < totalPending + totalOfferEscrow) revert InsolventAccounting(); }
}
