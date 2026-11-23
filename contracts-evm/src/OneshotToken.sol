// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {OneshotMetadata} from "./OneshotMetadata.sol";
import {OneshotChainPolicy} from "./OneshotChainPolicy.sol";

interface IInitializablePlatformMarket {
    function initialize() external;
}

/// @notice Fixed-supply platform token (1B, 8 decimals) with atomic single-shot distribution:
/// 51% Airdrop, 25% One-Sided Locked v4 Liquidity ($960k FDV target), 10% Team (24m linear),
/// 9% Ecosystem & Rewards, 5% Treasury & CEX Reserve.
contract OneshotToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 8;
    uint256 public constant AIRDROP_ALLOCATION = 510_000_000 * 10 ** 8;
    uint256 public constant LIQUIDITY_ALLOCATION = 250_000_000 * 10 ** 8;
    uint256 public constant TEAM_ALLOCATION = 100_000_000 * 10 ** 8;
    uint256 public constant ECOSYSTEM_ALLOCATION = 90_000_000 * 10 ** 8;
    uint256 public constant TREASURY_ALLOCATION = 50_000_000 * 10 ** 8;

    address public immutable deployer;
    uint256 public immutable deploymentChainId;

    bool public distributed;
    /// @notice Satisfies IOneshotOracleMarketToken.market() for the immutable Uniswap v4 oracle hook.
    address public market;

    error UnsupportedChain(uint256 chainId);
    error InvalidMetadata();
    error OnlyDeployer();
    error AlreadyDistributed();
    error InvalidRecipient();

    event SupplyDistributed(
        address indexed airdropDistributor,
        address indexed liquidityMarket,
        address indexed teamVesting,
        address ecosystemRecipient,
        address treasuryRecipient
    );

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (!OneshotChainPolicy.isSupportedChain(block.chainid)) revert UnsupportedChain(block.chainid);
        if (!OneshotMetadata.valid(bytes(name_), 64) || !OneshotMetadata.valid(bytes(symbol_), 16)) {
            revert InvalidMetadata();
        }
        deployer = msg.sender;
        deploymentChainId = block.chainid;
        _mint(address(this), TOTAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @notice Transfers the entire 1B supply to the five locked/designated recipients once and initializes LP.
    function distributeOnce(
        address airdropDistributor,
        address liquidityMarket,
        address teamVesting,
        address ecosystemRecipient,
        address treasuryRecipient
    ) external {
        if (block.chainid != deploymentChainId) revert UnsupportedChain(block.chainid);
        if (msg.sender != deployer) revert OnlyDeployer();
        if (distributed) revert AlreadyDistributed();
        if (
            airdropDistributor == address(0) || liquidityMarket == address(0) || teamVesting == address(0)
                || ecosystemRecipient == address(0) || treasuryRecipient == address(0)
                || airdropDistributor == address(this) || liquidityMarket == address(this)
                || teamVesting == address(this) || ecosystemRecipient == address(this)
                || treasuryRecipient == address(this)
                || airdropDistributor.code.length == 0 || liquidityMarket.code.length == 0 || teamVesting.code.length == 0
                || airdropDistributor == liquidityMarket || airdropDistributor == teamVesting
                || liquidityMarket == teamVesting
                || ecosystemRecipient == liquidityMarket || treasuryRecipient == liquidityMarket
                || ecosystemRecipient == airdropDistributor || treasuryRecipient == airdropDistributor
                || ecosystemRecipient == teamVesting || treasuryRecipient == teamVesting
        ) {
            revert InvalidRecipient();
        }

        distributed = true;
        market = liquidityMarket;

        _transfer(address(this), airdropDistributor, AIRDROP_ALLOCATION);
        _transfer(address(this), liquidityMarket, LIQUIDITY_ALLOCATION);
        _transfer(address(this), teamVesting, TEAM_ALLOCATION);
        _transfer(address(this), ecosystemRecipient, ECOSYSTEM_ALLOCATION);
        _transfer(address(this), treasuryRecipient, TREASURY_ALLOCATION);

        IInitializablePlatformMarket(liquidityMarket).initialize();

        emit SupplyDistributed(
            airdropDistributor, liquidityMarket, teamVesting, ecosystemRecipient, treasuryRecipient
        );
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
