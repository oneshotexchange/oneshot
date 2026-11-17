// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OneshotNFTFactory} from "../src/OneshotNFTFactory.sol";
import {OneshotCollection} from "../src/OneshotCollection.sol";

interface MetadataVm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function expectRevert(bytes4) external;
    function getNonce(address) external view returns (uint64);
}

contract OneshotNFTMetadataTest {
    MetadataVm constant vm = MetadataVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    OneshotNFTFactory factory;
    OneshotCollection existing;

    function setUp() public {
        factory = new OneshotNFTFactory(address(0xB001));
        existing = OneshotCollection(factory.createCollection("Existing edition", "EX"));
    }

    function _reject(bytes memory invalid) private {
        _rejectPair(string(invalid), "GOOD"); _rejectPair("Good collection", string(invalid));
    }

    function _rejectPair(string memory name, string memory symbol) private {
        uint256 count = factory.collectionCount(); uint64 nonce = vm.getNonce(address(factory));
        require(nonce > 0 && nonce < 128);
        address future = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(factory), bytes1(uint8(nonce)))))));
        vm.recordLogs(); vm.expectRevert(OneshotCollection.InvalidTerms.selector);
        factory.createCollection(name, symbol);
        require(vm.getRecordedLogs().length == 0, "invalid collection emitted events");
        require(factory.collectionCount() == count && vm.getNonce(address(factory)) == nonce, "invalid collection changed registry");
        require(!factory.isCollection(future) && future.code.length == 0);
        require(factory.isCollection(address(existing)) && existing.totalMinted() == 0 && !existing.configured());
    }

    function testNftFactoryRejectsEveryAsciiControlAtomically() public {
        for (uint256 i; i < 33; i++) _reject(abi.encodePacked("Visible", bytes1(uint8(i == 32 ? 127 : i)), "text"));
    }

    function testNftFactoryRejectsEveryEcmaTrimOnlyWhitespaceAtomically() public {
        bytes[] memory spaces = new bytes[](20);
        spaces[0]=hex"20"; spaces[1]=hex"c2a0"; spaces[2]=hex"e19a80";
        spaces[3]=hex"e28080"; spaces[4]=hex"e28081"; spaces[5]=hex"e28082"; spaces[6]=hex"e28083";
        spaces[7]=hex"e28084"; spaces[8]=hex"e28085"; spaces[9]=hex"e28086"; spaces[10]=hex"e28087";
        spaces[11]=hex"e28088"; spaces[12]=hex"e28089"; spaces[13]=hex"e2808a"; spaces[14]=hex"e280a8";
        spaces[15]=hex"e280a9"; spaces[16]=hex"e280af"; spaces[17]=hex"e2819f"; spaces[18]=hex"e38080"; spaces[19]=hex"efbbbf";
        for (uint256 i; i < spaces.length; i++) _reject(abi.encodePacked(hex"20", spaces[i], hex"c2a0"));
    }

    function testNftFactoryRejectsMalformedUtf8Atomically() public {
        bytes[] memory invalid = new bytes[](22);
        invalid[0]=hex"80"; invalid[1]=hex"bf"; invalid[2]=hex"c0af"; invalid[3]=hex"c1bf";
        invalid[4]=hex"e08080"; invalid[5]=hex"e09fbf"; invalid[6]=hex"f0808080"; invalid[7]=hex"f08fbfbf";
        invalid[8]=hex"eda080"; invalid[9]=hex"edbfbf"; invalid[10]=hex"f4908080"; invalid[11]=hex"f5808080";
        invalid[12]=hex"fe"; invalid[13]=hex"ff"; invalid[14]=hex"c2"; invalid[15]=hex"e0a0"; invalid[16]=hex"f09080";
        invalid[17]=hex"c241"; invalid[18]=hex"e28241"; invalid[19]=hex"f09f41a9"; invalid[20]=hex"f89f92a980"; invalid[21]=hex"fc8080808080";
        for (uint256 i; i < invalid.length; i++) _reject(abi.encodePacked("Visible", invalid[i]));
    }

    function testNftFactoryRejectsInitialBomButPreservesEmbeddedAndTrailingBom() public {
        _reject(abi.encodePacked(hex"efbbbf", "Visible"));
        string memory text = string(abi.encodePacked("A", hex"efbbbf", "B", hex"efbbbf"));
        OneshotCollection created = OneshotCollection(factory.createCollection(text, text));
        require(keccak256(bytes(created.name())) == keccak256(bytes(text)) && keccak256(bytes(created.symbol())) == keccak256(bytes(text)));
    }

    function testNftFactoryAcceptsUnicodeEmojiAndExactByteBounds() public {
        string memory name = unicode"একশট সংগ্রহ 🚀"; string memory symbol = unicode"猫 🚀";
        OneshotCollection created = OneshotCollection(factory.createCollection(name, symbol));
        require(factory.isCollection(address(created)) && created.creator() == address(this));
        require(keccak256(bytes(created.name())) == keccak256(bytes(name)) && keccak256(bytes(created.symbol())) == keccak256(bytes(symbol)));
        bytes memory longestName = new bytes(100);
        for (uint256 i; i < longestName.length; i++) longestName[i] = bytes1("A");
        string memory longestSymbol = string(abi.encodePacked("ABCDEFGHIJKLMNOP", hex"f09f9a80"));
        created = OneshotCollection(factory.createCollection(string(longestName), longestSymbol));
        require(bytes(created.name()).length == 100 && bytes(created.symbol()).length == 20);
        _rejectPair(string(abi.encodePacked(longestName, "A")), "GOOD");
        _rejectPair("Good collection", string(abi.encodePacked(longestSymbol, "A")));
        _rejectPair("", "GOOD"); _rejectPair("Good collection", "");
        require(factory.collectionCount() == 3);
    }

    function testNftFactoryAcceptsValidUtf8ScalarBoundaries() public {
        bytes[] memory valid = new bytes[](7);
        valid[0]=hex"c280"; valid[1]=hex"e0a080"; valid[2]=hex"ed9fbf"; valid[3]=hex"ee8080";
        valid[4]=hex"efbfbf"; valid[5]=hex"f0908080"; valid[6]=hex"f48fbfbf";
        for (uint256 i; i < valid.length; i++) {
            string memory text = string(abi.encodePacked("A", valid[i]));
            OneshotCollection created = OneshotCollection(factory.createCollection(text, text));
            require(factory.isCollection(address(created)) && keccak256(bytes(created.name())) == keccak256(bytes(text)));
        }
    }
}
