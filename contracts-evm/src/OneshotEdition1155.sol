// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";
import {OneshotMetadata} from "./OneshotMetadata.sol";

/// @notice Multi-edition ERC-1155 collection where each edition's supply, schedule, pricing and metadata freeze on open().
/// @dev Native amounts are base units; assumes no particular native-asset decimals.
contract OneshotEdition1155 is ERC1155, ERC2981, ReentrancyGuard {
    uint256 public constant PLATFORM_FEE_BPS = 200;
    uint256 public constant MAX_BATCH = 50;
    bytes32 public constant ALLOWLIST_DOMAIN = keccak256("ONESHOT_EDITION1155_ALLOWLIST_V1");

    struct Stage {
        uint64 start;
        uint64 end;
        uint64 walletLimit;
        uint256 price;
    }

    struct EditionConfig {
        uint64 maxSupply;
        bytes32 allowlistRoot;
        bytes32 contentHash;
        string tokenURI;
        Stage allowlist;
        Stage publicMint;
    }

    struct EditionState {
        bool configured;
        bool opened;
        uint64 totalMinted;
        uint64 totalBurned;
    }

    address public immutable creator;
    address public immutable treasury;
    address public immutable factory;
    uint256 public immutable deploymentChainId;
    uint16 public immutable royaltyBps;

    string private _name;
    string private _symbol;
    string private _contractURI;

    uint256 public nextEditionId;
    uint256 public totalPending;

    mapping(uint256 => EditionConfig) private _configs;
    mapping(uint256 => EditionState) public editions;
    mapping(uint256 => mapping(address => uint256)) public allowlistMinted;
    mapping(uint256 => mapping(address => uint256)) public publicMinted;
    mapping(address => uint256) public pending;

    error UnsupportedChain();
    error OnlyCreator();
    error Frozen();
    error UnknownEdition();
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
    error NotAuthorized();
    error NothingToClaim();
    error PaymentFailed();

    event EditionConfigured(uint256 indexed editionId, bytes32 indexed termsHash);
    event EditionOpened(uint256 indexed editionId, bytes32 indexed termsHash, bytes32 indexed contentHash);
    event EditionMinted(
        uint256 indexed editionId,
        address indexed payer,
        address indexed recipient,
        uint256 quantity,
        uint256 totalPrice,
        uint256 platformFee,
        uint256 creatorProceeds,
        bool allowlistStage
    );
    event EditionBurned(uint256 indexed editionId, address indexed account, address indexed operator, uint256 quantity);
    event Claimed(address indexed account, address indexed recipient, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        address creator_,
        address treasury_,
        uint16 royaltyBps_,
        string memory contractURI_
    ) ERC1155("") {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedChain();
        if (
            creator_ == address(0) || treasury_ == address(0) || royaltyBps_ > 1000
                || !OneshotMetadata.valid(bytes(name_), 100) || !OneshotMetadata.valid(bytes(symbol_), 20)
                || !_validURI(contractURI_)
        ) {
            revert InvalidTerms();
        }
        creator = creator_;
        treasury = treasury_;
        factory = msg.sender;
        deploymentChainId = block.chainid;
        royaltyBps = royaltyBps_;
        _name = name_;
        _symbol = symbol_;
        _contractURI = contractURI_;
    }

    function createEdition(EditionConfig calldata config_) external returns (uint256 editionId) {
        if (block.chainid != deploymentChainId) revert UnsupportedChain();
        if (msg.sender != creator) revert OnlyCreator();
        _validateConfig(config_);
        editionId = ++nextEditionId;
        _configs[editionId] = config_;
        editions[editionId].configured = true;
        emit EditionConfigured(editionId, keccak256(abi.encode(config_)));
    }

    function configureEdition(uint256 editionId, EditionConfig calldata config_) external {
        if (block.chainid != deploymentChainId) revert UnsupportedChain();
        if (msg.sender != creator) revert OnlyCreator();
        EditionState storage state = editions[editionId];
        if (!state.configured) revert UnknownEdition();
        if (state.opened) revert Frozen();
        _validateConfig(config_);
        _configs[editionId] = config_;
        emit EditionConfigured(editionId, keccak256(abi.encode(config_)));
    }

    function openEdition(uint256 editionId) external {
        if (block.chainid != deploymentChainId) revert UnsupportedChain();
        if (msg.sender != creator) revert OnlyCreator();
        EditionState storage state = editions[editionId];
        if (!state.configured) revert UnknownEdition();
        if (state.opened) revert Frozen();
        EditionConfig storage cfg = _configs[editionId];
        uint256 firstStart = cfg.allowlistRoot == bytes32(0) ? cfg.publicMint.start : cfg.allowlist.start;
        if (block.timestamp > firstStart) revert InvalidTerms();
        state.opened = true;
        emit EditionOpened(editionId, keccak256(abi.encode(cfg)), cfg.contentHash);
    }

    function mint(
        uint256 editionId,
        uint256 quantity,
        address recipient,
        uint256 maximumTotalPrice,
        bytes32[] calldata proof
    ) external payable nonReentrant {
        if (block.chainid != deploymentChainId) revert UnsupportedChain();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (quantity == 0 || quantity > MAX_BATCH) revert InvalidQuantity();

        (uint256 price, bool allowlistStage) = _prepareMint(editionId, quantity, maximumTotalPrice, proof);
        _finalizeMint(editionId, recipient, quantity, price, allowlistStage);
    }

    function _prepareMint(
        uint256 editionId,
        uint256 quantity,
        uint256 maximumTotalPrice,
        bytes32[] calldata proof
    ) internal returns (uint256 price, bool allowlistStage) {
        EditionState storage state = editions[editionId];
        if (!state.opened) revert NotOpen();

        EditionConfig storage cfg = _configs[editionId];
        allowlistStage = cfg.allowlistRoot != bytes32(0) && block.timestamp >= cfg.allowlist.start
            && block.timestamp < cfg.allowlist.end;
        Stage storage stage = allowlistStage ? cfg.allowlist : cfg.publicMint;
        if (block.timestamp < stage.start || block.timestamp >= stage.end) revert NoActiveStage();
        if (
            allowlistStage
                && !MerkleProof.verifyCalldata(proof, cfg.allowlistRoot, allowlistLeaf(editionId, msg.sender))
        ) {
            revert InvalidProof();
        }

        uint256 count = allowlistStage ? allowlistMinted[editionId][msg.sender] : publicMinted[editionId][msg.sender];
        if (count + quantity > stage.walletLimit) revert WalletLimit();
        if (uint256(state.totalMinted) + quantity > cfg.maxSupply) revert SupplyLimit();

        price = stage.price * quantity;
        if (price > maximumTotalPrice) revert PriceLimit();
        if (msg.value != price) revert IncorrectPayment();

        state.totalMinted += uint64(quantity);
        if (allowlistStage) allowlistMinted[editionId][msg.sender] = count + quantity;
        else publicMinted[editionId][msg.sender] = count + quantity;
    }

    function _finalizeMint(
        uint256 editionId,
        address recipient,
        uint256 quantity,
        uint256 price,
        bool allowlistStage
    ) internal {
        uint256 platformFee = Math.mulDiv(price, PLATFORM_FEE_BPS, 10_000);
        uint256 creatorProceeds = price - platformFee;
        pending[treasury] += platformFee;
        pending[creator] += creatorProceeds;
        totalPending += price;

        _mint(recipient, editionId, quantity, "");
        emit EditionMinted(editionId, msg.sender, recipient, quantity, price, platformFee, creatorProceeds, allowlistStage);
    }

    function burn(address account, uint256 editionId, uint256 quantity) external {
        if (account != msg.sender && !isApprovedForAll(account, msg.sender)) revert NotAuthorized();
        if (quantity == 0) revert InvalidQuantity();
        if (!editions[editionId].configured) revert UnknownEdition();
        _burn(account, editionId, quantity);
        editions[editionId].totalBurned += uint64(quantity);
        emit EditionBurned(editionId, account, msg.sender, quantity);
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

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    function uri(uint256 editionId) public view override returns (string memory) {
        if (!editions[editionId].configured) revert UnknownEdition();
        return _configs[editionId].tokenURI;
    }

    function editionConfig(uint256 editionId) external view returns (EditionConfig memory) {
        if (!editions[editionId].configured) revert UnknownEdition();
        return _configs[editionId];
    }

    function circulatingSupply(uint256 editionId) external view returns (uint256) {
        EditionState storage state = editions[editionId];
        return uint256(state.totalMinted) - uint256(state.totalBurned);
    }

    function allowlistLeaf(uint256 editionId, address wallet) public view returns (bytes32) {
        return keccak256(
            bytes.concat(keccak256(abi.encode(ALLOWLIST_DOMAIN, block.chainid, address(this), editionId, wallet)))
        );
    }

    function royaltyInfo(uint256, uint256 salePrice)
        public
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        return (creator, Math.mulDiv(salePrice, royaltyBps, 10_000));
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _validateConfig(EditionConfig calldata config_) private pure {
        if (
            config_.maxSupply == 0 || config_.contentHash == bytes32(0) || !_validURI(config_.tokenURI)
                || !_validStage(config_.publicMint, config_.maxSupply)
        ) revert InvalidTerms();
        Stage calldata allowlist = config_.allowlist;
        if (config_.allowlistRoot == bytes32(0)) {
            if (allowlist.start != 0 || allowlist.end != 0 || allowlist.walletLimit != 0 || allowlist.price != 0) {
                revert InvalidTerms();
            }
        } else if (!_validStage(allowlist, config_.maxSupply) || allowlist.end > config_.publicMint.start) {
            revert InvalidTerms();
        }
    }

    function _validStage(Stage calldata stage, uint64 cap) private pure returns (bool) {
        return stage.start < stage.end && stage.walletLimit > 0 && stage.walletLimit <= cap;
    }

    function _validURI(string memory targetUri) private pure returns (bool) {
        bytes memory value = bytes(targetUri);
        uint256 length = value.length;
        if (length < 6 || length > 2048) return false;
        bool scheme = _startsWith(value, "ipfs://") || _startsWith(value, "ar://") || _startsWith(value, "https://");
        if (!scheme) return false;
        for (uint256 i; i < length; ++i) {
            if (uint8(value[i]) <= 32 || uint8(value[i]) == 127) return false;
        }
        return true;
    }

    function _startsWith(bytes memory value, bytes memory prefix) private pure returns (bool) {
        if (value.length <= prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (value[i] != prefix[i]) return false;
        }
        return true;
    }
}
