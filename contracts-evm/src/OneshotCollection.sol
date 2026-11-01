// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice A draft collection whose issuance and content commitments freeze permanently at open.
/// @dev Native amounts are base units; this contract assumes no particular native-asset decimals.
contract OneshotCollection is ERC721, ERC2981, ReentrancyGuard {
    uint256 public constant PLATFORM_FEE_BPS = 200;
    uint256 public constant MAX_BATCH = 20;
    bytes32 public constant ALLOWLIST_DOMAIN = keccak256("ONESHOT_ALLOWLIST_V1");

    struct Stage {
        uint64 start;
        uint64 end;
        uint64 walletLimit;
        uint256 price;
    }

    struct Terms {
        uint64 maxSupply;
        uint16 royaltyBps;
        bytes32 allowlistRoot;
        bytes32 contentHash;
        string metadataBaseURI;
        string collectionURI;
        Stage allowlist;
        Stage publicMint;
    }

    address public immutable creator;
    address public immutable treasury;
    address public immutable factory;
    bool public configured;
    bool public opened;
    uint256 public totalMinted;
    uint256 public totalPending;
    Terms private _terms;
    mapping(address => uint256) public allowlistMinted;
    mapping(address => uint256) public publicMinted;
    mapping(address => uint256) public pending;

    error OnlyCreator();
    error Frozen();
    error InvalidTerms();
    error NotOpen();
    error NoActiveStage();
    error InvalidProof();
    error InvalidQuantity();
    error WalletLimit();
    error SupplyLimit();
    error PriceLimit();
    error IncorrectPayment();
    error InvalidRecipient();
    error NothingToClaim();
    error PaymentFailed();

    event TermsConfigured(bytes32 indexed termsHash);
    event CollectionOpened(bytes32 indexed termsHash, bytes32 indexed contentHash);
    event Minted(
        address indexed payer,
        address indexed recipient,
        uint256 firstTokenId,
        uint256 quantity,
        uint256 totalPrice,
        uint256 platformFee,
        uint256 creatorProceeds,
        bool allowlistStage
    );
    event Claimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(string memory name_, string memory symbol_, address creator_, address treasury_)
        ERC721(name_, symbol_)
    {
        if (
            creator_ == address(0) || treasury_ == address(0) || bytes(name_).length == 0 || bytes(name_).length > 100
                || bytes(symbol_).length == 0 || bytes(symbol_).length > 20
        ) {
            revert InvalidTerms();
        }
        creator = creator_;
        treasury = treasury_;
        factory = msg.sender;
    }

    /// @notice Replace all draft terms atomically. URI/content-hash validation and snapshotting
    /// happen before this call; the contract freezes the supplied commitment, not content availability.
    function configure(Terms calldata terms_) external {
        if (msg.sender != creator) revert OnlyCreator();
        if (opened) revert Frozen();
        if (
            terms_.maxSupply == 0 || terms_.royaltyBps > 1000 || terms_.contentHash == bytes32(0)
                || !_validURI(terms_.metadataBaseURI, true) || !_validURI(terms_.collectionURI, false)
                || !_validStage(terms_.publicMint, terms_.maxSupply)
        ) revert InvalidTerms();
        Stage calldata allowlist = terms_.allowlist;
        if (terms_.allowlistRoot == bytes32(0)) {
            if (allowlist.start != 0 || allowlist.end != 0 || allowlist.walletLimit != 0 || allowlist.price != 0) {
                revert InvalidTerms();
            }
        } else if (!_validStage(allowlist, terms_.maxSupply) || allowlist.end > terms_.publicMint.start) {
            revert InvalidTerms();
        }
        _terms = terms_;
        configured = true;
        emit TermsConfigured(keccak256(abi.encode(terms_)));
    }

    function open() external {
        if (msg.sender != creator) revert OnlyCreator();
        if (opened) revert Frozen();
        if (!configured) revert InvalidTerms();
        uint256 firstStart = _terms.allowlistRoot == bytes32(0) ? _terms.publicMint.start : _terms.allowlist.start;
        if (block.timestamp > firstStart) revert InvalidTerms();
        opened = true;
        emit CollectionOpened(keccak256(abi.encode(_terms)), _terms.contentHash);
    }

    /// @notice Limits accumulate per payer and per phase; changing the recipient cannot bypass them.
    /// Exact payment avoids forcing native refunds through potentially rejecting contract wallets.
    function mint(uint256 quantity, address recipient, uint256 maximumTotalPrice, bytes32[] calldata proof)
        external
        payable
        nonReentrant
    {
        if (!opened) revert NotOpen();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (quantity == 0 || quantity > MAX_BATCH) revert InvalidQuantity();
        bool allowlistStage = _terms.allowlistRoot != bytes32(0) && block.timestamp >= _terms.allowlist.start
            && block.timestamp < _terms.allowlist.end;
        Stage storage stage = allowlistStage ? _terms.allowlist : _terms.publicMint;
        if (block.timestamp < stage.start || block.timestamp >= stage.end) revert NoActiveStage();
        if (allowlistStage && !MerkleProof.verifyCalldata(proof, _terms.allowlistRoot, allowlistLeaf(msg.sender))) {
            revert InvalidProof();
        }
        uint256 count = allowlistStage ? allowlistMinted[msg.sender] : publicMinted[msg.sender];
        if (count + quantity > stage.walletLimit) revert WalletLimit();
        if (totalMinted + quantity > _terms.maxSupply) revert SupplyLimit();
        uint256 price = stage.price * quantity;
        if (price > maximumTotalPrice) revert PriceLimit();
        if (msg.value != price) revert IncorrectPayment();

        // Commit batch counters and liabilities before invoking any ERC721 receiver callback.
        uint256 firstTokenId = totalMinted + 1;
        totalMinted += quantity;
        if (allowlistStage) allowlistMinted[msg.sender] = count + quantity;
        else publicMinted[msg.sender] = count + quantity;
        uint256 platformFee = Math.mulDiv(price, PLATFORM_FEE_BPS, 10_000);
        uint256 creatorProceeds = price - platformFee;
        pending[treasury] += platformFee;
        pending[creator] += creatorProceeds;
        totalPending += price;
        for (uint256 i; i < quantity; ++i) {
            _safeMint(recipient, firstTokenId + i);
        }
        emit Minted(msg.sender, recipient, firstTokenId, quantity, price, platformFee, creatorProceeds, allowlistStage);
    }

    /// @notice A beneficiary may route its claim to a wallet that can receive native currency.
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

    /// @dev Double hashing matches OpenZeppelin StandardMerkleTree's leaf convention.
    function allowlistLeaf(address wallet) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(ALLOWLIST_DOMAIN, block.chainid, address(this), wallet))));
    }

    function terms() external view returns (Terms memory) {
        return _terms;
    }

    function contractURI() external view returns (string memory) {
        return _terms.collectionURI;
    }

    /// @notice ERC2981 discovery with overflow-safe arithmetic over the full uint256 price domain.
    /// @dev The creator and configured fraction have no mutation path after open().
    function royaltyInfo(uint256, uint256 salePrice)
        public
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        return (creator, Math.mulDiv(salePrice, _terms.royaltyBps, 10_000));
    }

    function _baseURI() internal view override returns (string memory) {
        return _terms.metadataBaseURI;
    }

    function _validStage(Stage calldata stage, uint64 cap) private pure returns (bool) {
        return stage.start < stage.end && stage.walletLimit > 0 && stage.walletLimit <= cap;
    }

    function _validURI(string calldata uri, bool isBase) private pure returns (bool) {
        bytes calldata value = bytes(uri);
        uint256 length = value.length;
        if (length < 6 || length > 2048 || (isBase && value[length - 1] != bytes1("/"))) return false;
        bool scheme = (length > 7 && keccak256(value[:7]) == keccak256("ipfs://"))
            || (length > 5 && keccak256(value[:5]) == keccak256("ar://"))
            || (length > 8 && keccak256(value[:8]) == keccak256("https://"));
        if (!scheme) return false;
        for (uint256 i; i < length; ++i) {
            if (uint8(value[i]) <= 32 || uint8(value[i]) == 127) return false;
        }
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
