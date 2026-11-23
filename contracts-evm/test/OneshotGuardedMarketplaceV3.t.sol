// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {OneshotNFTTestBase, NFTBadReceiver, NFTCallbackWallet, NFTRejectingWallet} from "./OneshotNFT.t.sol";
import {OneshotCollection} from "../src/OneshotCollection.sol";
import {OneshotGuardedMarketplace} from "../src/OneshotGuardedMarketplace.sol";
import {OneshotGuardedMarketplaceV3} from "../src/OneshotGuardedMarketplaceV3.sol";

interface V3Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert(bytes calldata) external;
}
contract V3RejectSecond is IERC721Receiver {
    uint256 public received;
    function onERC721Received(address,address,uint256,bytes calldata) external returns (bytes4) {
        received++; return received == 1 ? IERC721Receiver.onERC721Received.selector : bytes4(0);
    }
}
contract V3ForwardReceiver is IERC721Receiver {
    address immutable recipient;
    constructor(address recipient_) { recipient = recipient_; }
    function onERC721Received(address,address,uint256 tokenId,bytes calldata) external returns (bytes4) {
        IERC721(msg.sender).transferFrom(address(this), recipient, tokenId); return IERC721Receiver.onERC721Received.selector;
    }
}

contract OneshotGuardedMarketplaceV3Test is OneshotNFTTestBase {
    V3Vm constant signatures = V3Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY = 0x123456;
    bytes32 constant SALT = keccak256("v3 local deployment");
    bytes32 constant ACCEPT = keccak256("OfferAcceptancePermit(address seller,uint256 offerId,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)");
    bytes32 constant LIST = keccak256("ListingPermit(address seller,address collection,uint256 tokenId,uint256 totalPrice,uint256 nonce,bytes32 policyCommitment,uint256 deadline,bytes32 deploymentSalt)");
    bytes32 constant POLICY = keccak256("PolicyPermit(address creator,address collection,bytes32 commitment,bytes32 expectedCommitment,uint256 deadline,bytes32 deploymentSalt)");
    OneshotGuardedMarketplaceV3 market;
    function setUp() public override {
        super.setUp(); vm.chainId(31337);
        market = new OneshotGuardedMarketplaceV3(factory, signatures.addr(KEY), SALT);
        _configureOpen(_terms(40, 750, 0)); vm.warp(100);
        vm.prank(ALICE); collection.mint(20, ALICE, 0, new bytes32[](0));
        vm.prank(ALICE); collection.setApprovalForAll(address(market), true);
        vm.deal(BOB, 100 ether); vm.deal(ALICE, 100 ether);
    }
    function _sign(bytes32 message, address target, uint256 chain) private returns (bytes memory) {
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("OneshotGuardedMarketplace"), keccak256("1"), chain, target));
        (uint8 v,bytes32 r,bytes32 s) = signatures.sign(KEY, keccak256(abi.encodePacked("\x19\x01", domain, message)));
        return abi.encodePacked(r,s,v);
    }
    function _offer(uint256 tokenId,uint256 price,uint256 quantity,address recipient) private returns (uint256) {
        vm.prank(BOB); return market.createOffer{value:price*quantity}(address(collection),tokenId,price,quantity,recipient,1000);
    }
    function _acceptHash(uint256 id,uint256 tokenId,uint256 price,uint256 nonce,bytes32 commitment,uint256 deadline,address seller,bytes32 salt) private view returns (bytes32) {
        return keccak256(abi.encode(ACCEPT,seller,id,address(collection),tokenId,price,nonce,commitment,deadline,salt));
    }
    function _accept(uint256 id,uint256 tokenId,uint256 price) private {
        _acceptExpected(id,tokenId,price,false,bytes4(0));
    }
    function _acceptReverts(uint256 id,uint256 tokenId,uint256 price,bytes4 expected) private {
        _acceptExpected(id,tokenId,price,true,expected);
    }
    function _acceptExpected(uint256 id,uint256 tokenId,uint256 price,bool failure,bytes4 expected) private {
        uint256 nonce = market.offerAcceptanceNonces(ALICE); bytes32 commitment = market.policyCommitment(address(collection));
        bytes memory sig = _sign(_acceptHash(id,tokenId,price,nonce,commitment,1000,ALICE,SALT),address(market),31337);
        if(failure){if(expected==bytes4(0))vm.expectRevert();else vm.expectRevert(expected);}
        vm.prank(ALICE); market.acceptOffer(id,tokenId,nonce,commitment,1000,sig);
    }
    function _list(OneshotCollection target,uint256 tokenId,uint256 price) private returns (uint256) {
        uint256 nonce = market.listingNonces(ALICE); bytes32 commitment = market.policyCommitment(address(target));
        bytes memory sig = _sign(keccak256(abi.encode(LIST,ALICE,address(target),tokenId,price,nonce,commitment,uint256(1000),SALT)),address(market),31337);
        vm.prank(ALICE); return market.listAuthorized(address(target),tokenId,price,nonce,commitment,1000,sig);
    }
    function _remaining(uint256 id) private view returns (uint256 remaining) { (,,,,,remaining,) = market.offers(id); }
    function _active(uint256 id) private view returns (bool active) { (,,,,active)=market.listings(id); }

    function testVersionAndOriginalListingDomainRemainAvailable() public {
        require(market.MARKETPLACE_VERSION()==3 && market.MAX_BATCH_BUY()==20 && market.MAX_OFFER_QUANTITY()==20);
        uint256 listing = _list(collection,1,101);
        require(collection.ownerOf(1)==address(market) && market.listingNonces(ALICE)==1 && market.offerAcceptanceNonces(ALICE)==0);
        vm.prank(BOB); market.buy{value:101}(listing,101,BOB);
        require(collection.ownerOf(1)==BOB && market.pending(TREASURY)==2 && market.pending(CREATOR)==7 && market.pending(ALICE)==92);
    }
    function testItemOfferUsesExactReservedFundsAndFullRoyaltySettlement() public {
        uint256 id=_offer(1,101,1,BOB);
        require(market.totalOfferEscrow()==101 && market.totalPending()==0 && _remaining(id)==1);
        _accept(id,1,101);
        require(collection.ownerOf(1)==BOB && market.totalOfferEscrow()==0 && market.totalPending()==101 && _remaining(id)==0);
        require(market.pending(TREASURY)==2 && market.pending(CREATOR)==7 && market.pending(ALICE)==92);
        require(market.offerAcceptanceNonces(ALICE)==1 && market.listingNonces(ALICE)==0);
        vm.prank(ALICE); market.claimTo(payable(ALICE)); require(market.totalPending()==9 && address(market).balance==9);
    }
    function testPartialCollectionOfferFillAndCancellationPreserveEveryReservedUnit() public {
        uint256 id=_offer(0,101,3,BOB); _accept(id,1,101); _accept(id,2,101);
        require(_remaining(id)==1 && market.totalOfferEscrow()==101 && market.totalPending()==202);
        vm.prank(BOB); market.cancelOffer(id);
        require(_remaining(id)==0 && market.totalOfferEscrow()==0 && market.pending(BOB)==101 && market.totalPending()==303);
        vm.prank(BOB); market.claimTo(payable(BOB)); require(address(market).balance==202);
        _acceptReverts(id,3,101,OneshotGuardedMarketplaceV3.InactiveOffer.selector);
    }
    function testListedOfferAcceptanceClosesOriginalAskWithoutSellingAtAskPrice() public {
        uint256 listing=_list(collection,1,1000); uint256 id=_offer(1,101,1,BOB); _accept(id,1,101);
        require(!_active(listing) && market.activeListing(address(collection),1)==0 && collection.ownerOf(1)==BOB);
        require(market.totalPending()==101 && market.pending(ALICE)==92);
        vm.prank(BOB); vm.expectRevert(OneshotGuardedMarketplace.InactiveListing.selector); market.buy{value:1000}(listing,1000,BOB);
    }
    function testExpiryBoundaryPermissionlessRefundAndUnsupportedChainExits() public {
        uint256 id=_offer(0,101,2,BOB); vm.warp(1000);
        vm.expectRevert(OneshotGuardedMarketplaceV3.OfferNotExpired.selector); market.releaseExpiredOffer(id);
        _accept(id,1,101); vm.warp(1001);
        _acceptReverts(id,2,101,OneshotGuardedMarketplaceV3.OfferHasExpired.selector);
        vm.chainId(1); market.releaseExpiredOffer(id);
        require(market.pending(BOB)==101 && market.totalOfferEscrow()==0);
        vm.prank(BOB); market.claimTo(payable(BOB)); require(market.pending(BOB)==0);
        signatures.expectRevert(abi.encodeWithSelector(OneshotGuardedMarketplace.UnsupportedTestChain.selector,1)); _offer(0,1,1,BOB);
    }
    function testCreationRejectsUnopenedUnknownMissingItemBadQuantityPaymentRecipientAndExpiry() public {
        OneshotCollection draft=OneshotCollection(factory.createCollection("Draft","D"));
        vm.expectRevert(OneshotGuardedMarketplaceV3.CollectionNotOpen.selector); market.createOffer(address(draft),0,1,1,BOB,1000);
        vm.expectRevert(OneshotGuardedMarketplace.UnknownCollection.selector); market.createOffer(address(1234),0,1,1,BOB,1000);
        vm.expectRevert(); _offer(1000,1,1,BOB);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidOfferQuantity.selector); _offer(1,1,2,BOB);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidOfferQuantity.selector); _offer(0,1,21,BOB);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidOfferQuantity.selector); _offer(0,1,0,BOB);
        vm.expectRevert(OneshotGuardedMarketplace.InvalidRecipient.selector); _offer(0,1,1,address(market));
        vm.expectRevert(OneshotGuardedMarketplace.InvalidRecipient.selector); _offer(0,1,1,address(0));
        vm.expectRevert(OneshotGuardedMarketplace.InvalidPrice.selector); _offer(0,0,1,BOB);
        vm.expectRevert(OneshotGuardedMarketplace.IncorrectPayment.selector); market.createOffer(address(collection),0,1,1,BOB,1000);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidOfferExpiry.selector); market.createOffer(address(collection),0,1,1,BOB,100);
        require(market.nextOfferId()==1 && market.totalOfferEscrow()==0 && market.totalPending()==0);
    }
    function testAcceptanceRequiresOwnerExactItemNonSelfTradeAndFreshAuthority() public {
        uint256 id=_offer(1,101,1,BOB);
        _acceptReverts(id,2,101,OneshotGuardedMarketplaceV3.WrongOfferItem.selector);
        vm.prank(BOB); vm.expectRevert(OneshotGuardedMarketplace.SelfPurchase.selector); market.acceptOffer(id,1,0,0,1000,"");
        vm.prank(ALICE); vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector); market.acceptOffer(id,1,0,0,1000,"");
        bytes memory notOwner=_sign(_acceptHash(id,1,101,0,0,1000,CREATOR,SALT),address(market),31337);
        vm.prank(CREATOR); vm.expectRevert(OneshotGuardedMarketplace.NotOwner.selector); market.acceptOffer(id,1,0,0,1000,notOwner);
        vm.prank(ALICE); collection.approve(address(0),1); // Existing blanket approval still permits acceptance.
        require(market.totalOfferEscrow()==101 && market.totalPending()==0);
    }
    function testAcceptanceRejectsTamperedOfferTokenPriceSellerSaltChainAndMarket() public {
        uint256 id=_offer(0,101,2,BOB); uint256 second=_offer(0,101,1,BOB);
        bytes memory original=_sign(_acceptHash(id,1,101,0,0,1000,ALICE,SALT),address(market),31337);
        vm.prank(ALICE); vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector); market.acceptOffer(second,1,0,0,1000,original);
        vm.prank(ALICE); vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector); market.acceptOffer(id,2,0,0,1000,original);
        bytes32[3] memory wrong=[_acceptHash(id,1,102,0,0,1000,ALICE,SALT),_acceptHash(id,1,101,0,0,1000,BOB,SALT),_acceptHash(id,1,101,0,0,1000,ALICE,keccak256("wrong"))];
        for(uint256 i;i<wrong.length;i++){bytes memory sig=_sign(wrong[i],address(market),31337);vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);market.acceptOffer(id,1,0,0,1000,sig);}
        bytes memory badChain=_sign(_acceptHash(id,1,101,0,0,1000,ALICE,SALT),address(market),84532);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);market.acceptOffer(id,1,0,0,1000,badChain);
        bytes memory badMarket=_sign(_acceptHash(id,1,101,0,0,1000,ALICE,SALT),address(collection),31337);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.InvalidAuthorization.selector);market.acceptOffer(id,1,0,0,1000,badMarket);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.InvalidNonce.selector);market.acceptOffer(id,1,1,0,1000,original);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.AuthorizationExpired.selector);market.acceptOffer(id,1,0,0,99,original);
        _accept(id,1,101);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.InvalidNonce.selector);market.acceptOffer(id,2,0,0,1000,original);
        require(_remaining(id)==1 && market.totalOfferEscrow()==202);
    }
    function testPolicyChangeInvalidatesAcceptanceButCannotBlockRefund() public {
        uint256 id=_offer(1,101,1,BOB);bytes memory old=_sign(_acceptHash(id,1,101,0,0,1000,ALICE,SALT),address(market),31337);
        bytes32 commitment=keccak256("private salted commitment");bytes memory policy=_sign(keccak256(abi.encode(POLICY,CREATOR,address(collection),commitment,bytes32(0),uint256(1000),SALT)),address(market),31337);
        vm.prank(CREATOR);market.setPolicyCommitment(address(collection),commitment,0,1000,policy);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.PolicyChanged.selector);market.acceptOffer(id,1,0,0,1000,old);
        vm.prank(BOB);market.cancelOffer(id);require(market.pending(BOB)==101 && collection.ownerOf(1)==ALICE);
    }
    function testRejectedReceiverRollsBackOfferListingNonceAndLiabilities() public {
        uint256 listing=_list(collection,1,1000);NFTBadReceiver bad=new NFTBadReceiver();uint256 id=_offer(1,101,1,address(bad));
        _acceptReverts(id,1,101,bytes4(0));
        require(_active(listing)&&market.activeListing(address(collection),1)==listing&&collection.ownerOf(1)==address(market));
        require(_remaining(id)==1&&market.totalOfferEscrow()==101&&market.totalPending()==0&&market.offerAcceptanceNonces(ALICE)==0);
    }
    function testReceiverCallbackCannotReenterAndMayForwardBoughtNft() public {
        NFTCallbackWallet callback=new NFTCallbackWallet();uint256 id=_offer(1,101,1,address(callback));
        callback.arm(address(market),abi.encodeCall(market.releaseExpiredOffer,(id)));_accept(id,1,101);require(!callback.nestedCallSucceeded());
        V3ForwardReceiver forwarder=new V3ForwardReceiver(BOB);id=_offer(2,101,1,address(forwarder));_accept(id,2,101);require(collection.ownerOf(2)==BOB);
    }
    function testRejectingBidderCanCancelAndRouteRefundClaimWithoutAuthority() public {
        NFTRejectingWallet bidder=new NFTRejectingWallet();vm.deal(address(bidder),101);
        bidder.execute(address(market),abi.encodeCall(market.createOffer,(address(collection),uint256(1),uint256(101),uint256(1),address(bidder),uint256(1000))),101);
        bidder.execute(address(market),abi.encodeCall(market.cancelOffer,(uint256(1))),0);
        vm.expectRevert(OneshotGuardedMarketplace.PaymentFailed.selector);bidder.execute(address(market),abi.encodeCall(market.claimTo,(payable(address(bidder)))),0);
        require(market.pending(address(bidder))==101);bidder.execute(address(market),abi.encodeCall(market.claimTo,(payable(BOB))),0);require(market.totalPending()==0);
    }
    function _ids(uint256 a,uint256 b) private pure returns(uint256[] memory ids){ids=new uint256[](2);ids[0]=a;ids[1]=b;}
    function testBatchAcrossCollectionsPreservesPerItemRoundingAndReservedOffers() public {
        vm.prank(CREATOR);OneshotCollection second=OneshotCollection(factory.createCollection("Second","TWO"));
        vm.prank(CREATOR);second.configure(_terms(40,1000,0));vm.prank(CREATOR);second.open();
        vm.prank(ALICE);second.mint(1,ALICE,0,new bytes32[](0));vm.prank(ALICE);second.setApprovalForAll(address(market),true);
        uint256 one=_list(collection,1,101);uint256 two=_list(second,1,99);_offer(0,17,2,BOB);
        vm.prank(BOB);market.buyBatch{value:200}(_ids(two,one),200,BOB);
        require(collection.ownerOf(1)==BOB&&second.ownerOf(1)==BOB&&!_active(one)&&!_active(two));
        require(market.pending(TREASURY)==3&&market.pending(CREATOR)==16&&market.pending(ALICE)==181);
        require(market.totalPending()==200&&market.totalOfferEscrow()==34&&address(market).balance==234);
        vm.prank(ALICE);market.claimTo(payable(ALICE));require(address(market).balance==53&&market.totalOfferEscrow()==34);
    }
    function testBatchDuplicatesStaleSelfPurchaseCapsAndPaymentRejectAtomically() public {
        uint256 one=_list(collection,1,101);uint256 two=_list(collection,2,99);uint256[] memory ids=_ids(one,two);
        vm.prank(BOB);vm.expectRevert(OneshotGuardedMarketplaceV3.DuplicateListing.selector);market.buyBatch{value:202}(_ids(one,one),202,BOB);
        vm.prank(BOB);vm.expectRevert(OneshotGuardedMarketplace.InactiveListing.selector);market.buyBatch{value:200}(_ids(one,999),200,BOB);
        vm.prank(ALICE);vm.expectRevert(OneshotGuardedMarketplace.SelfPurchase.selector);market.buyBatch{value:200}(ids,200,BOB);
        vm.prank(BOB);vm.expectRevert(OneshotGuardedMarketplace.PriceLimit.selector);market.buyBatch{value:200}(ids,199,BOB);
        vm.prank(BOB);vm.expectRevert(OneshotGuardedMarketplace.IncorrectPayment.selector);market.buyBatch{value:201}(ids,200,BOB);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidBatch.selector);market.buyBatch(new uint256[](0),0,BOB);
        vm.expectRevert(OneshotGuardedMarketplaceV3.InvalidBatch.selector);market.buyBatch(new uint256[](21),0,BOB);
        require(_active(one)&&_active(two)&&market.totalPending()==0&&collection.ownerOf(1)==address(market));
    }
    function testBatchReceiverRejectingSecondRollsBackFirstSaleAndReceiverState() public {
        uint256 one=_list(collection,1,101);uint256 two=_list(collection,2,99);V3RejectSecond recipient=new V3RejectSecond();
        vm.prank(BOB);vm.expectRevert();market.buyBatch{value:200}(_ids(one,two),200,address(recipient));
        require(recipient.received()==0&&_active(one)&&_active(two)&&market.totalPending()==0);
        require(collection.ownerOf(1)==address(market)&&collection.ownerOf(2)==address(market));
    }
    function testMaximumBatchBuysTwentyListings() public {
        uint256[] memory ids=new uint256[](20);for(uint256 i;i<20;i++)ids[i]=_list(collection,i+1,101);
        vm.prank(BOB);market.buyBatch{value:2020}(ids,2020,BOB);
        for(uint256 i;i<20;i++)require(collection.ownerOf(i+1)==BOB&&!_active(ids[i]));
        require(market.pending(TREASURY)==40&&market.pending(CREATOR)==140&&market.pending(ALICE)==1840);
    }
    function testFuzzOfferFillAndRefundConserveAllNativeUnits(uint96 seed,uint8 countSeed) public {
        uint256 price=uint256(seed)+1;uint256 count=uint256(countSeed)%20+1;vm.deal(BOB,price*count);
        uint256 id=_offer(0,price,count,BOB);_accept(id,1,price);vm.prank(BOB);if(count>1)market.cancelOffer(id);
        require(market.totalOfferEscrow()==0&&market.totalPending()==price*count&&address(market).balance==price*count);
        require(market.pending(BOB)==price*(count-1));
        require(market.pending(TREASURY)==price*2/100&&market.pending(CREATOR)==price*750/10000);
    }
    function testSupportedTestChainGateAndRuntimeLimit() public {
        require(address(market).code.length<=24576&&type(OneshotGuardedMarketplaceV3).creationCode.length<49152);
        vm.chainId(8453);vm.expectRevert();new OneshotGuardedMarketplaceV3(factory,signatures.addr(KEY),SALT);
        vm.chainId(543210);signatures.expectRevert(abi.encodeWithSelector(OneshotGuardedMarketplace.UnsupportedTestChain.selector,543210));new OneshotGuardedMarketplaceV3(factory,signatures.addr(KEY),SALT);
        vm.chainId(33001);
        OneshotGuardedMarketplaceV3 zeroMarket=new OneshotGuardedMarketplaceV3(factory,signatures.addr(KEY),SALT);
        require(zeroMarket.deploymentChainId()==33001);
    }
}
