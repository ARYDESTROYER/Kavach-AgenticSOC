"""Characters that READ as a letter of a chat role word, or as a colon.

Data for the role-marker refusal in ``chat_starter_text.ref_value`` (SPEC-chat §3.15
and §10.2 "Role-marker refusal"): a starter reference that opens like ``SYSTEM:`` in
any script is refused, never rewritten. Nothing here is used to change a value.

Derived once from the Unicode ``confusables.txt`` of UTS #39 (Unicode Security
Mechanisms, version 18.0.0, file dated 2026-08-06, SHA-256
6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92) and vendored here so
the check needs no new dependency. Unicode data is © Unicode, Inc. and used under the
Unicode License (https://www.unicode.org/terms_of_use.html).

The derivation kept a confusable source when its UTS #39 prototype reads as one of the
letters of ``system``, ``assistant``, ``user``, ``developer``, ``tool`` and ``human``
(a d e h i l m n o p r s t u v y) or as ``:``:

* a single ASCII prototype among those letters, or ``:``;
* ``rn`` and U+028D LATIN SMALL LETTER TURNED W (the prototypes of the small and
  small-capital m look-alikes), read as ``m``;
* a ``LATIN LETTER SMALL CAPITAL`` or ``MODIFIER LETTER SMALL CAPITAL`` of one of those
  letters (the small capitals are listed themselves too);
* an ASCII multi-letter prototype that occurs inside a role word (``oo``, ``lo``,
  ``ls``).

The ASCII sources UTS #39 maps (``I``, ``1`` and ``|`` to ``l``; ``0`` to ``o``) are
kept, because the skeleton is built only for a value that is not all ASCII and an ASCII
letter inside it reads the same as elsewhere. A source that the check's own folding
(NFKC with format characters and combining marks dropped, then accents stripped)
already turns into the same reading is left out, which drops the fullwidth and
mathematical letters.

Readings are lower case except two that must stay apart: ``l`` is the I/l glyph (UTS
#39 gives a capital I and a small l one prototype, so it reads as either) and ``L`` is a
capital L (it reads as an l but never as an i).
"""
from __future__ import annotations

#: reading -> the characters that read as it (UTS #39 confusables, see the docstring).
CONFUSABLE_READINGS: dict[str, str] = {
    "a": (
        "\u0251\u0391\u03b1\u0410\u0430\u13aa\u15c5\u1d00\u237a\ua4ee\uab64\uab7a"
        "\U000102a0\U00016f40\U0001ccd6\U0001df5a\U0001df6a"
    ),
    "d": (
        "\u0501\u13a0\u13e7\u146f\u15de\u15ea\u1d05\ua4d2\ua4d3\uab70\U0001018b"
        "\U0001ccd9"
    ),
    "e": (
        "\u0395\u0415\u0435\u04bd\u13ac\u1d07\u212e\u22ff\u2d39\ua4f0\ua5cb\uab32"
        "\uab7c\U00010286\U000118a6\U000118ae\U0001ccda\U0001df81"
    ),
    "h": (
        "\u029c\u0397\u041d\u043d\u04ba\u04bb\u0570\u10b9\u13bb\u13c2\u157c\u2c8e"
        "\u2c8f\ua4e7\uab8b\U000102cf\U0001ccdd"
    ),
    "i": (
        "\u00a1\u0131\u0269\u026a\u03b9\u0456\u0582\u13a5\u2373\u2c93\ua647\uab75"
        "\U000118c3"
    ),
    "L": (
        "\u029f\u13de\u14aa\u2cd0\u2cd1\ua4e1\uabae\U0001041b\U00010443\U00010526"
        "\U000118a3\U000118b2\U00016f16\U0001cce1\U0001d22a"
    ),
    "l": (
        "1I|\u0196\u01c0\u0399\u0406\u04c0\u04cf\u05c0\u05d5\u05df\u0627\u0661"
        "\u06f1\u07ca\u0964\u104a\u16c1\u16d0\u21bf\u2223\u23fd\u2502\u2503\u2c92"
        "\u2d4a\u2d4f\ua4f2\ua56f\ua781\ua7ae\ua7fe\ua830\ua8ce\uaa5d\U0001028a"
        "\U00010309\U00010320\U0001050e\U00010926\U00010c3e\U00010ca5\U00010cfa"
        "\U00011047\U000110c0\U00011141\U000111c5\U000113d4\U0001144b\U000115c5"
        "\U00011641\U00011c41\U00011dda\U00011de1\U00016d63\U00016eaa\U00016f28"
        "\U0001ccde\U0001ccf1\U0001d100\U0001d377\U0001e141\U0001e8c7\U0001ed01"
    ),
    "m": (
        "\u028d\u039c\u03fa\u041c\u043c\u0560\u13b7\u15f0\u16d6\u1d0d\u2c98\u2c99"
        "\ua4df\uab87\U000102b0\U00010311\U00010c21\U00011700\U000118e3\U0001cce2"
    ),
    "n": "\u0274\u039d\u0578\u057c\u2c9a\u2c9b\ua4e0\U00010513\U00011abe\U0001cce3",
    "o": (
        "0\u039f\u03bf\u03c3\u03ed\u041e\u043e\u0555\u0585\u05e1\u0647\u0665"
        "\u06be\u06c1\u06d5\u06f5\u07c0\u07cb\u0840\u0966\u09e6\u0a66\u0ae6\u0b20"
        "\u0b66\u0be6\u0c02\u0c66\u0c82\u0ce6\u0d02\u0d20\u0d66\u0d82\u0e50\u0ed0"
        "\u101d\u1040\u10ff\u110b\u11bc\u12d0\u17e0\u1a45\u1a80\u1a90\u1bea\u1c82"
        "\u1cbf\u1d0f\u1d11\u2c9e\u2c9f\u2d54\u3007\ua4f3\uab3d\U00010292"
        "\U000102ab\U0001030f\U00010404\U0001042c\U000104c2\U000104ea\U00010516"
        "\U0001092c\U00010c17\U00010d07\U00011124\U00011302\U000114d0\U000118b5"
        "\U000118c8\U000118d7\U000118e0\U00011de0\U00016ae9\U0001cce4\U0001ccf0"
        "\U0001e140\U0001e2f0"
    ),
    "p": (
        "\u00fe\u01bf\u03a1\u03c1\u03f8\u0420\u0440\u13e2\u146d\u1d18\u1d29\u2374"
        "\u2ca2\u2ca3\u2cce\u2ccf\ua4d1\uabb2\U00010295\U0001cce5"
    ),
    "r": (
        "\u01a6\u024c\u0280\u0433\u13a1\u13d2\u1587\u1d26\u2c85\ua4e3\uab47\uab48"
        "\uab71\uab81\uaba2\U000104b4\U00016a19\U00016f35\U0001cce7\U0001d216"
    ),
    "s": (
        "\u01bd\u0405\u0455\u054f\u0d1f\u10bd\u10fd\u13d5\u13da\u1cbd\ua4e2\ua576"
        "\ua731\uabaa\U00010296\U00010420\U00010448\U000118c1\U00016ad6\U00016f3a"
        "\U0001cce8"
    ),
    "t": (
        "\u03a4\u03c4\u0422\u0442\u07e0\u13a2\u1d1b\u22a4\u27d9\u2ca6\u2ca7\u3112"
        "\u4e05\ua4d4\ua50b\ua68d\uab72\U00010297\U000102b1\U00010315\U000118bc"
        "\U00016f0a\U0001cce9\U0001d373\U0001f768"
    ),
    "u": (
        "\u028b\u03c5\u054d\u057d\u1200\u144c\u1d1c\u222a\u22c3\ua4f4\ua79f\uab4e"
        "\uab52\U000104ce\U000104f6\U000118b8\U000118d8\U00016f42\U0001ccea"
    ),
    "v": (
        "\u03bd\u0474\u0475\u05d8\u0667\u06f7\u13d9\u142f\u1d20\u2228\u22c1\u2d38"
        "\ua4e6\ua6df\uaba9\U0001051d\U00010c1f\U00011706\U000118a0\U000118c0"
        "\U00016f08\U0001cceb\U0001cefc\U0001d20d\U0001e145"
    ),
    "y": (
        "\u0263\u028f\u03a5\u03b3\u0423\u0443\u04ae\u04af\u07cc\u10e7\u13a9\u13bd"
        "\u1d8c\u1eff\u2ca8\u2ca9\u311a\u4e2b\ua4ec\uab5a\U000102b2\U00010c20"
        "\U000118a4\U000118c4\U000118dc\U00016f43\U0001ccee\U0001e04f"
    ),
    "lo": "\u042e",
    "ls": "\u02aa",
    "oo": "\u1147\u11ee\u221e\ua698\ua699\ua74e\ua74f",
    ":": (
        "\u02d0\u02f8\u0589\u05c3\u0703\u0704\u0831\u0903\u0a83\u1361\u1393\u16ec"
        "\u1803\u1809\u205a\u2236\ua4fd\ua789\U0001015b\U00010af5\U00011002"
        "\U00011082\U00011182\U0001123a\U000115be\U000116ac\U00011838\U00011dd9"
        "\U0001d108"
    ),
}

#: Look-alikes the confusables data does not map to these readings, kept from the
#: hand-written table this one replaced: Greek small epsilon (e), Cyrillic capital Komi
#: De (D) and the Ethiopic colon.
EXTRA_READINGS: dict[str, str] = {
    "e": "ε",
    "d": "Ԁ",
    ":": "፥",
}
