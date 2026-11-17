// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Bounded ABI-string admission shared by permissionless NFT/token issuance.
/// Checks Unicode scalar encoding, application text rules and decoder compatibility.
library OneshotMetadata {
    function valid(bytes memory text, uint256 maximum) internal pure returns (bool) {
        if (text.length == 0 || text.length > maximum) return false;
        bool hasContent;
        uint256 offset;
        while (offset < text.length) {
            uint256 start = offset;
            uint256 first = uint8(text[offset++]);
            uint256 codepoint;
            uint256 continuation;
            uint256 minimum;
            if (first < 0x80) codepoint = first;
            else if (first >= 0xc2 && first <= 0xdf) { codepoint = first & 0x1f; continuation = 1; minimum = 0x80; }
            else if (first >= 0xe0 && first <= 0xef) { codepoint = first & 0x0f; continuation = 2; minimum = 0x800; }
            else if (first >= 0xf0 && first <= 0xf4) { codepoint = first & 0x07; continuation = 3; minimum = 0x10000; }
            else return false;
            if (offset + continuation > text.length) return false;
            for (uint256 i; i < continuation; i++) {
                uint256 next = uint8(text[offset++]);
                if (next < 0x80 || next > 0xbf) return false;
                codepoint = (codepoint << 6) | (next & 0x3f);
            }
            if (codepoint < minimum || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)
                || codepoint <= 0x1f || codepoint == 0x7f) return false;
            // The application's UTF-8 decoder consumes an initial BOM. Reject it
            // so re-encoding decoded contract strings reproduces the exact ABI.
            if (start == 0 && codepoint == 0xfeff) return false;
            if (!_trimWhitespace(codepoint)) hasContent = true;
        }
        return hasContent;
    }

    /// @dev ECMAScript trim whitespace. ASCII control whitespace is already
    /// rejected above; non-English text and other valid scalars remain allowed.
    function _trimWhitespace(uint256 codepoint) private pure returns (bool) {
        return codepoint == 0x20 || codepoint == 0xa0 || codepoint == 0x1680
            || (codepoint >= 0x2000 && codepoint <= 0x200a) || codepoint == 0x2028 || codepoint == 0x2029
            || codepoint == 0x202f || codepoint == 0x205f || codepoint == 0x3000 || codepoint == 0xfeff;
    }
}
