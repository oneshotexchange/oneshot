// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotNFTFactory} from "./OneshotNFTFactory.sol";
import {OneshotCollection} from "./OneshotCollection.sol";

/// @notice Native-currency escrow sales for collections created by one immutable oneshot factory.
/// @dev No administrator, arbitrary call path, escrow rescue, fee setter or upgrade entry point.
contract OneshotMarketplace is IERC721Receiver, ReentrancyGuard {
    uint256 public constant PLATFORM_FEE_BPS = 200;
    OneshotNFTFactory public immutable factory;
    address public immutable treasury;
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

    constructor(OneshotNFTFactory factory_) {
        if (address(factory_).code.length == 0) revert InvalidFactory();
        factory = factory_;
        treasury = factory_.treasury();
        if (treasury == address(0)) revert InvalidFactory();
    }

    /// @notice The seller approves this contract, then the NFT enters escrow atomically.
    function list(address collection, uint256 tokenId, uint256 totalPrice)
        external
        nonReentrant
        returns (uint256 listingId)
    {
        if (!factory.isCollection(collection)) revert UnknownCollection();
        if (totalPrice == 0) revert InvalidPrice();
        if (activeListing[collection][tokenId] != 0) revert AlreadyListed();
        if (IERC721(collection).ownerOf(tokenId) != msg.sender) revert NotOwner();
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

    /// @dev Accept only the safe transfer initiated by list(); unsolicited safe deposits revert.
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
