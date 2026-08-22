"""Built-in enrichment providers (Round 3 + Round 11).

Wave 1 shipped the two providers the legacy ``EnrichTool`` already had — AbuseIPDB +
VirusTotal — refactored behind the :class:`EnrichmentProvider` SPI with byte-identical
scoring. Wave 2 added ~14 more across IPs, domains, URLs, file hashes and emails.
Every provider is FAIL-OPEN, Redis-cached (by the dispatcher), per-provider
timed-out, and only fires when its ``EnrichmentConfig.use_*`` toggle is on AND (if
key-gated) its ``Secrets`` key is set. The quota-safe KEYLESS providers
(shodan_internetdb / ipinfo / urlhaus / threatfox / malwarebazaar / rdap +
Round 11's circl_hashlookup / dshield / onionoo) default ON; the keyless-but-
caveated ones (spamhaus / cymru_mhr need the host's own resolver; robtex / crt_sh
are slow) and every key-gated provider default OFF.

Round 11 adds 19 more providers: 7 keyless (CIRCL hashlookup, SANS ISC DShield,
Onionoo/Tor, Spamhaus ZEN/DBL, Team Cymru MHR, Robtex, crt.sh) and 12 key-gated
(CrowdSec CTI, Google Safe Browsing, IPQualityScore, ipdata, APIVoid, Maltiverse,
SecurityTrails, Criminal IP, Netlas, Hybrid Analysis, MetaDefender, EmailRep).
Score discipline (#3): verdict feeds (a Safe Browsing / MHR / Spamhaus listing, a
sandbox 'malicious') score 80-90; graded reputations (CrowdSec, IPQS fraud score,
detection ratios) map directly onto 0..100; CONTEXT providers (crt.sh, Robtex,
SecurityTrails, Netlas, Onionoo, DShield, CIRCL known-good) stay <= 40 with
``malicious=False`` so they can never alone cross the legacy ``max()`` >= 50 cut.

The registry imports :data:`BUILTIN_PROVIDERS` to discover them; third-party providers
register out-of-tree via the ``tlsoc.enrichers`` entry-point group.
"""

from __future__ import annotations

from ..base import EnrichmentProvider
from .abuseipdb import AbuseIPDBProvider
from .abusech import MalwareBazaarProvider, ThreatFoxProvider, URLhausProvider
from .apivoid import APIVoidProvider
from .binaryedge import BinaryEdgeProvider
from .censys import CensysProvider
from .circl_hashlookup import CirclHashlookupProvider
from .criminalip import CriminalIPProvider
from .crowdsec import CrowdSecProvider
from .crt_sh import CrtShProvider
from .cymru_mhr import CymruMHRProvider
from .dshield import DShieldProvider
from .emailrep import EmailRepProvider
from .google_safebrowsing import GoogleSafeBrowsingProvider
from .greynoise import GreyNoiseProvider
from .hibp import HIBPProvider
from .hybrid_analysis import HybridAnalysisProvider
from .ipdata import IPDataProvider
from .ipinfo import IPInfoProvider
from .ipqualityscore import IPQualityScoreProvider
from .maltiverse import MaltiverseProvider
from .metadefender import MetaDefenderProvider
from .netlas import NetlasProvider
from .onionoo import OnionooProvider
from .otx import OTXProvider
from .projecthoneypot import ProjectHoneypotProvider
from .pulsedive import PulsediveProvider
from .rdap import RDAPProvider
from .robtex import RobtexProvider
from .securitytrails import SecurityTrailsProvider
from .shodan import ShodanProvider
from .shodan_internetdb import ShodanInternetDBProvider
from .spamhaus import SpamhausProvider
from .spur import SpurProvider
from .urlscan import URLScanProvider
from .virustotal import VirusTotalProvider
from .xforce import XForceProvider

BUILTIN_PROVIDERS: list[type[EnrichmentProvider]] = [
    # IP reputation / exposure / context
    AbuseIPDBProvider,
    VirusTotalProvider,
    GreyNoiseProvider,
    ShodanInternetDBProvider,
    ShodanProvider,
    CensysProvider,
    BinaryEdgeProvider,
    IPInfoProvider,
    OTXProvider,
    PulsediveProvider,
    SpurProvider,
    XForceProvider,
    # multi-indicator / domain / url / hash / email
    URLhausProvider,
    ThreatFoxProvider,
    MalwareBazaarProvider,
    RDAPProvider,
    URLScanProvider,
    HIBPProvider,
    # Key-gated, default-OFF (use_honeypot + honeypot_access_key). Registered in Wave 2b.
    ProjectHoneypotProvider,
    # --- Round 11: keyless (quota-safe trio defaults ON) ---
    CirclHashlookupProvider,
    DShieldProvider,
    OnionooProvider,
    # --- Round 11: keyless but caveated (resolver/latency) — default OFF ---
    SpamhausProvider,
    CymruMHRProvider,
    RobtexProvider,
    CrtShProvider,
    # --- Round 11: key-gated, default OFF ---
    CrowdSecProvider,
    GoogleSafeBrowsingProvider,
    IPQualityScoreProvider,
    IPDataProvider,
    APIVoidProvider,
    MaltiverseProvider,
    SecurityTrailsProvider,
    CriminalIPProvider,
    NetlasProvider,
    HybridAnalysisProvider,
    MetaDefenderProvider,
    EmailRepProvider,
]

__all__ = [
    "BUILTIN_PROVIDERS",
    "AbuseIPDBProvider",
    "VirusTotalProvider",
    "GreyNoiseProvider",
    "ShodanInternetDBProvider",
    "ShodanProvider",
    "CensysProvider",
    "BinaryEdgeProvider",
    "IPInfoProvider",
    "OTXProvider",
    "PulsediveProvider",
    "SpurProvider",
    "XForceProvider",
    "URLhausProvider",
    "ThreatFoxProvider",
    "MalwareBazaarProvider",
    "RDAPProvider",
    "URLScanProvider",
    "HIBPProvider",
    "ProjectHoneypotProvider",
    "CirclHashlookupProvider",
    "DShieldProvider",
    "OnionooProvider",
    "SpamhausProvider",
    "CymruMHRProvider",
    "RobtexProvider",
    "CrtShProvider",
    "CrowdSecProvider",
    "GoogleSafeBrowsingProvider",
    "IPQualityScoreProvider",
    "IPDataProvider",
    "APIVoidProvider",
    "MaltiverseProvider",
    "SecurityTrailsProvider",
    "CriminalIPProvider",
    "NetlasProvider",
    "HybridAnalysisProvider",
    "MetaDefenderProvider",
    "EmailRepProvider",
]
