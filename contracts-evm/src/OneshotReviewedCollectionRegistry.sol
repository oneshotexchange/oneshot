// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OneshotNFTFactory} from "./OneshotNFTFactory.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

/// @notice Authority-reviewed external ERC-721 admission. No token, fund, fee or
/// marketplace ownership is granted to the authority. Anyone may submit its permit.
/// @dev extcodehash identifies runtime code, not a proxy's current implementation
/// or immutable behavior. Admission is a review record, never a proxy-safety claim.
contract OneshotReviewedCollectionRegistry is EIP712, ReentrancyGuard {
    using ERC165Checker for address;
    uint256 public constant REGISTRY_VERSION = 1;
    bytes4 public constant ASSET_STANDARD = type(IERC721).interfaceId;
    uint256 public constant MAX_SIGNATURE_BYTES = 4096;
    OneshotNFTFactory public immutable oneshotFactory;
    bytes32 public immutable oneshotFactoryCodeHash;
    address public immutable reviewAuthority;
    bytes32 public immutable deploymentSalt;
    uint256 public immutable deploymentChainId;
    struct Review { bytes32 runtimeCodeHash; uint256 version; bool active; }
    mapping(address => Review) public reviews;
    bytes32 private constant REVIEW_TYPEHASH = keccak256(
        "ReviewPermit(address collection,bytes32 runtimeCodeHash,uint256 reviewVersion,uint256 deadline,bytes32 deploymentSalt)"
    );
    error UnsupportedTestChain(uint256 chainId);
    error InvalidFactory();
    error InvalidAuthority();
    error InvalidDeploymentSalt();
    error InvalidCollection();
    error NativeCollectionExcluded();
    error UnsupportedCollection();
    error InvalidRuntimeCodeHash();
    error RuntimeCodeChanged();
    error InvalidReviewVersion();
    error ReviewExpired();
    error InvalidAuthorization();
    error OnlyReviewAuthority();
    error InactiveReview();
    event ReviewAdmitted(address indexed collection, uint256 indexed version, bytes32 runtimeCodeHash, bytes32 permitHash, uint256 deadline);
    event ReviewRevoked(address indexed collection, uint256 indexed previousVersion, uint256 indexed version);

    constructor(OneshotNFTFactory factory_, address authority_, bytes32 salt_)
        EIP712("OneshotReviewedCollectionRegistry", "1")
    {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedTestChain(block.chainid);
        if (address(factory_).code.length == 0 || factory_.treasury() == address(0)) revert InvalidFactory();
        if (authority_ == address(0)) revert InvalidAuthority();
        if (salt_ == bytes32(0)) revert InvalidDeploymentSalt();
        oneshotFactory = factory_; oneshotFactoryCodeHash = address(factory_).codehash;
        reviewAuthority = authority_; deploymentSalt = salt_; deploymentChainId = block.chainid;
    }

    function reviewPermitHash(address collection, bytes32 runtimeCodeHash, uint256 reviewVersion, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVIEW_TYPEHASH, collection, runtimeCodeHash, reviewVersion, deadline, deploymentSalt)));
    }

    /// @notice Preliminary compatibility proof, using the same registry caller
    /// and bounded STATICCALL probes as admission. This does not approve/admit
    /// the collection, sample royalties, or establish its creator or proxy safety.
    function checkCollection(address collection) external view returns (bytes32 runtimeCodeHash) {
        _chain(); _external(collection); _requireSupportedCollection(collection);
        return collection.codehash;
    }

    function admitReviewed(address collection, bytes32 runtimeCodeHash, uint256 reviewVersion, uint256 deadline, bytes calldata signature) external nonReentrant {
        _chain(); _external(collection);
        if (block.timestamp > deadline) revert ReviewExpired();
        Review storage previous = reviews[collection];
        if (previous.version == type(uint256).max || reviewVersion != previous.version + 1) revert InvalidReviewVersion();
        if (runtimeCodeHash == bytes32(0) || collection.codehash != runtimeCodeHash) revert InvalidRuntimeCodeHash();
        _requireSupportedCollection(collection);
        bytes32 digest = reviewPermitHash(collection, runtimeCodeHash, reviewVersion, deadline);
        if (signature.length == 0 || signature.length > MAX_SIGNATURE_BYTES
            || !SignatureChecker.isValidSignatureNow(reviewAuthority, digest, signature)) revert InvalidAuthorization();
        reviews[collection] = Review(runtimeCodeHash, reviewVersion, true);
        emit ReviewAdmitted(collection, reviewVersion, runtimeCodeHash, digest, deadline);
    }

    /// @notice Revocation also consumes the next version, invalidating every
    /// pre-revocation permit for that version. It never transfers assets/funds.
    function revoke(address collection, uint256 expectedVersion) external nonReentrant {
        _chain();
        if (msg.sender != reviewAuthority) revert OnlyReviewAuthority();
        Review storage review = reviews[collection];
        if (!review.active) revert InactiveReview();
        if (review.version != expectedVersion || review.version == type(uint256).max) revert InvalidReviewVersion();
        uint256 next = review.version + 1;
        review.version = next; review.active = false;
        emit ReviewRevoked(collection, expectedVersion, next);
    }

    function requireActiveReview(address collection, uint256 expectedVersion) external view returns (bytes32 runtimeCodeHash) {
        _chain(); _external(collection);
        Review storage review = reviews[collection];
        if (!review.active) revert InactiveReview();
        if (review.version != expectedVersion) revert InvalidReviewVersion();
        if (collection.codehash != review.runtimeCodeHash) revert RuntimeCodeChanged();
        return review.runtimeCodeHash;
    }

    function _external(address collection) private view {
        if (address(oneshotFactory).codehash != oneshotFactoryCodeHash) revert InvalidFactory();
        if (collection == address(0) || collection == address(this) || collection.code.length == 0) revert InvalidCollection();
        if (oneshotFactory.isCollection(collection)) revert NativeCollectionExcluded();
    }
    function _requireSupportedCollection(address collection) private view {
        if (!collection.supportsERC165() || !collection.supportsInterface(type(IERC721).interfaceId)
            || !collection.supportsInterface(type(IERC2981).interfaceId)) revert UnsupportedCollection();
    }
    function _chain() private view { if (block.chainid != deploymentChainId) revert UnsupportedTestChain(block.chainid); }
}
