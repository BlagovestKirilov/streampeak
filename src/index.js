/**
 * StreamPeak — Stremio Addon
 *
 * Fetches all streams from Torrentio, scores every stream across eight
 * dimensions (resolution, release type, HDR, audio, encoding, seeders, file
 * size sanity, release-group bonus), discards CAM/TS entries, buckets the
 * rest into 4K / 1080p / 720p / 480p, and returns the single
 * highest-scoring stream per bucket — up to four streams total.
 *
 * Also exposes a /debug/:type/:id endpoint that returns the full per-stream
 * score breakdown so you can inspect the selection logic without opening Stremio.
 */

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const MANIFEST = {
	id: "community.streampeak",
	version: "1.0.1",
	name: "StreamPeak",
	description:
		"Stop guessing which stream to pick. StreamPeak analyzes every available stream and surfaces only the best. Built by Blagovest Kirilov.",
	types: ["movie", "series"],
	catalogs: [],
	resources: ["stream"],
	idPrefixes: ["tt"],
	logo: "https://raw.githubusercontent.com/BlagovestKirilov/streampeak/master/assets/streampeak.png",
	stremioAddonsConfig: {
		issuer: "https://stremio-addons.net",
		signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..F8mYf_QjIQ2UrNQuUW5LEg.RdTsUe28jg_cvhCj1aHYxON696q46tnoFYPu6Zi1gxq4bs6bbTjVNU67mpgzpvUrTQ9onFVmvHIbYN4dXqFVuXbRgolmUPHPmPDY2Pc-Ko0hOWe9s64_sYtxRjQFuh59.Sq8z-U-w1j7td5eyZS4kBg",
	},
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TORRENTIO_DEFAULT = "https://torrentio.withoutthefuss.dpdns.org";
const TORRENTIO_FALLBACK = "https://torrentio.strem.fun";

/** Minimum seeder count — streams below this are discarded as unhealthy. */
const MIN_SEEDERS = 5;

/** Quality buckets — single source of truth for tier ordering. */
const QUALITY_TIERS = ["4k", "1080p", "720p", "480p"];

/** CORS headers required by Stremio */
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// Scoring tables
// ---------------------------------------------------------------------------

/**
 * RESOLUTION SCORE — most significant dimension.
 * Determines which quality bucket the stream lives in AND adds base points.
 */
const RESOLUTION_SCORES = {
	"4k": 1000,
	"1080p": 800,
	"720p": 600,
	"480p": 100,
};

/**
 * RELEASE TYPE SCORE — second most important.
 * CAM/TS entries receive -99999 so they are effectively discarded after
 * scoring (total score will be deeply negative and never win a bucket).
 * We still score them so the debug endpoint can show the discard reason.
 */
const RELEASE_TYPE = [
	{ re: /\bremux\b/i, score: 350, label: "REMUX" },
	{ re: /blu.?ray|bdrip|bdremux/i, score: 400, label: "BluRay" },
	{ re: /web.?dl/i, score: 300, label: "WEB-DL" },
	{ re: /webrip/i, score: 200, label: "WEBRip" },
	{ re: /\bhdtv\b/i, score: 100, label: "HDTV" },
	{ re: /dvdrip/i, score: 50, label: "DVDRip" },
	// CAM / TS — always discard
	{ re: /\bhdcam\b|\btelesync\b|\bpdvd\b/i, score: -99999, label: "HDCAM/TS" },
	{ re: /\bcam\b/i, score: -99999, label: "CAM" },
	{ re: /\bts(?:rip)?\b(?![-\w])/i, score: -99999, label: "TS" },
];

/**
 * HDR SCORE
 * DV+HDR dual-layer (plays on both DV and HDR displays) is the best.
 */
const HDR_TYPES = [
	{ re: /(?=.*(?:dolby.?vision|\bdovi\b))(?=.*\bhdr\b)/i, score: 170, label: "DV HDR" },
	{ re: /hdr10\+|hdr10plus/i, score: 150, label: "HDR10+" },
	{ re: /dolby.?vision|\bdovi\b/i, score: 120, label: "DV" },
	{ re: /\bhdr\b/i, score: 100, label: "HDR" },
];

/**
 * AUDIO SCORE
 */
const AUDIO_TYPES = [
	{ re: /atmos/i, score: 100, label: "Atmos" },
	{ re: /dts.?x\b/i, score: 90, label: "DTS-X" },
	{ re: /dts.?hd.?ma/i, score: 90, label: "DTS-HD MA" },
	{ re: /truehd/i, score: 80, label: "TrueHD" },
	{ re: /dts.?hd/i, score: 75, label: "DTS-HD" },
	{ re: /\bdts\b/i, score: 70, label: "DTS" },
	{ re: /dd\+|eac3|dolby.?digital.?plus/i, score: 60, label: "DD+" },
	{ re: /\bac3\b|dolby.?digital|\bdd\b/i, score: 40, label: "DD" },
	{ re: /\baac\b/i, score: 20, label: "AAC" },
];

/**
 * ENCODING SCORE
 */
const ENCODING_TYPES = [
	{ re: /x265|h\.?265|hevc/i, score: 50, label: "x265" },
	{ re: /\bav1\b/i, score: 45, label: "AV1" },
	{ re: /x264|h\.?264/i, score: 20, label: "x264" },
];

/**
 * LANGUAGE SCORE
 * Torrentio encodes language in the stream name field, e.g.
 * "🇬🇧 English", "🇷🇺 Russian", "Multi", "🇧🇬 Bulgarian" etc.
 * English / multi-language → small bonus.
 * Explicitly non-English → penalty (still shown if no better option exists).
 * No language tag detected → neutral (most pure-English releases omit it).
 */
const LANGUAGE_SCORE = [
	{ re: /\benglish\b|\beng\b|🇬🇧|🇺🇸|🇦🇺/iu, score: 100, label: "" },
	{ re: /\bmulti\b/i, score: 50, label: "" },
	// Non-English flag emoji block U+1F1E6–U+1F1FF covers all country flags.
	// We match any flag pair NOT already matched above as non-English.
	{ re: /[\u{1F1E6}-\u{1F1FF}]{2}/u, score: -200, label: "non-EN" },
];

/** Explicit non-English language words — checked via Set to avoid regex complexity limits. */
const NON_ENGLISH_LANGUAGES = new Set([
	"french", "spanish", "german", "italian", "portuguese", "russian",
	"hindi", "arabic", "turkish", "korean", "japanese", "chinese",
	"dutch", "polish", "swedish", "norwegian", "danish", "finnish",
	"romanian", "hungarian", "bulgarian", "greek", "hebrew", "thai",
	"vietnamese", "ukrainian", "czech", "slovak", "croatian", "serbian",
	"slovenian", "latvian", "lithuanian", "estonian", "persian",
	"indonesian", "malay",
]);

/**
 * KNOWN QUALITY RELEASE GROUPS — bonus points
 */
const QUALITY_GROUPS =
	/\b(SPARKS|FGT|ROVERS|GECKOS|DEFLATE|CMRG|NTb|FLUX|LAZY|TEPES|MZABI|TIGOLE)\b/i;

/**
 * SEEDER SCORE — logarithmic curve so seeders are a meaningful factor.
 *
 * 0 seeders → -99999 (discarded, same as CAM/TS).
 * Range: -200 (1-2 seeders) → ~0 (10 seeders) → 150 (500+).
 * The log curve ensures the jump from 17→229 is significant (~85 pts)
 * while 229→1000 adds diminishing returns (~33 pts).
 */
function seederScore(n) {
	if (n <= 0) return -99999;
	if (n < 3) return -200;
	return Math.min(Math.round(75 * Math.log10(n) - 60), 150);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Detects language preference score from a stream's name+title.
 * Returns { score, label } — label is empty string for English/Multi (no tag needed).
 */
function detectLanguage(text) {
	for (const { re, score, label } of LANGUAGE_SCORE) {
		if (re.test(text)) return { score, label };
	}
	const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
	if (words.some((w) => NON_ENGLISH_LANGUAGES.has(w))) {
		return { score: -200, label: "non-EN" };
	}
	return { score: 0, label: "" };
}

/**
 * Returns which quality bucket a stream belongs to ("4k" | "1080p" | "720p" |
 * "480p" | null).
 */
function detectQuality(text) {
	if (/2160p|\b4k\b|uhd/i.test(text)) return "4k";
	if (/1080p/i.test(text)) return "1080p";
	if (/720p/i.test(text)) return "720p";
	if (/480p|\bsd\b/i.test(text)) return "480p";
	return null;
}

/**
 * Extracts seeder count from a Torrentio title string.
 * Torrentio uses "👤 342"; some providers use "Seeds: 342".
 * Returns 0 when nothing is found.
 */
function extractSeeders(title) {
	const emojiMatch = /\u{1F464}\s*(\d+)/u.exec(title);
	if (emojiMatch) return Number.parseInt(emojiMatch[1], 10);

	const seedsMatch = /seeds?[:\s]+(\d+)/i.exec(title);
	if (seedsMatch) return Number.parseInt(seedsMatch[1], 10);

	return 0;
}

/**
 * Extracts file size from a Torrentio title string ("💾 18.5 GB" / "💾 2.3 MB").
 * Returns size in MB, or 0 if not found.
 */
function extractSizeMB(title) {
	// 💾 is U+1F4BE
	const match = /\u{1F4BE}\s*([\d.]+)\s*(MB|GB)/iu.exec(title);
	if (!match) return 0;

	const value = Number.parseFloat(match[1]);
	const unit = match[2].toUpperCase();
	return unit === "GB" ? value * 1024 : value;
}

// ---------------------------------------------------------------------------
// Size scoring
// ---------------------------------------------------------------------------

/**
 * SIZE PREFERENCE SCORING
 *
 * Ideal ranges (sweet spot = full bonus):
 *   4K:    5–25 GB  → +75
 *   1080p: 2–10 GB  → +75
 *   720p:  0.5–4 GB → +50
 *   480p:  any       → 0
 *
 * Too small (likely fake / sample):   hard penalty
 * Too large (will buffer):            escalating penalty, worse for remuxes
 * Unknown size (0):                   neutral (0)
 */
/**
 * Per-quality size tiers:
 * [ minMB, sweetMaxGB, acceptMaxGB, sweetPts, acceptPts, tooSmallPts, overRemux, overNormal ]
 */
const SIZE_TIERS = {
	"4k":    [4096,  25, 40, 75, 25, -500, -300, -100],
	"1080p": [ 500,  10, 20, 75, 25, -500, -300, -100],
	"720p":  [ 200,   4,  8, 50, 25, -200, -200,  -50],
};

function calcSizeScore(quality, sizeMB, isRemux = false) {
	if (sizeMB <= 0) return 0;
	const tier = SIZE_TIERS[quality];
	if (!tier) return 0; // 480p — no size preference

	const [minMB, sweetMaxGB, acceptMaxGB, sweetPts, acceptPts, tooSmallPts, overRemux, overNormal] = tier;
	const sizeGB = sizeMB / 1024;

	if (sizeMB < minMB) return tooSmallPts;
	if (sizeGB <= sweetMaxGB) return sweetPts;
	if (sizeGB <= acceptMaxGB) return acceptPts;
	return isRemux ? overRemux : overNormal;
}

// ---------------------------------------------------------------------------
// Core scoring engine
// ---------------------------------------------------------------------------

/**
 * Scores a single raw stream object across all dimensions.
 *
 * Returns a breakdown object:
 * {
 *   total: number,           // sum of all component scores
 *   quality: string|null,    // detected bucket ("4k" / "1080p" / "720p" / …)
 *   discarded: boolean,      // true when CAM/TS penalty applied
 *   discardReason: string,   // e.g. "CAM" (only set when discarded)
 *   breakdown: {             // individual score components
 *     resolution, releaseType, hdr, audio, encoding, seeders, sizeScore, groupBonus
 *   },
 *   labels: {                // human-readable detected values for stream naming
 *     releaseType, hdr, audio, encoding
 *   },
 *   seeders: number,
 *   sizeMB: number,
 * }
 */
/**
 * Finds the first matching entry in a scored list and returns { score, label }.
 * Returns { score: 0, label: fallbackLabel } when nothing matches.
 */
function detectFirst(list, text, fallbackLabel = "") {
	for (const { re, score, label } of list) {
		if (re.test(text)) return { score, label };
	}
	return { score: 0, label: fallbackLabel };
}

function scoreStream(stream) {
	const combined = `${stream.name ?? ""} ${stream.title ?? ""}`;
	const title = stream.title ?? "";

	const quality = detectQuality(combined);
	const resolutionPts = RESOLUTION_SCORES[quality] ?? 0;

	const releaseType = detectFirst(RELEASE_TYPE, combined, "Unknown");
	const discarded = releaseType.score <= -99999;
	const discardReason = discarded ? releaseType.label : "";

	const hdr      = detectFirst(HDR_TYPES,     combined);
	const audio    = detectFirst(AUDIO_TYPES,   combined);
	const encoding = detectFirst(ENCODING_TYPES, combined);

	const seeders    = extractSeeders(title);
	const seederPts  = seederScore(seeders);
	const isRemux    = /\bremux\b/i.test(combined);
	const sizeMB     = extractSizeMB(title);
	const sizeScore  = calcSizeScore(quality, sizeMB, isRemux);
	const groupBonus = QUALITY_GROUPS.test(combined) ? 50 : 0;
	const lang       = detectLanguage(combined);

	const total =
		resolutionPts + releaseType.score + hdr.score + audio.score +
		encoding.score + seederPts + sizeScore + groupBonus + lang.score;

	return {
		total,
		quality,
		discarded,
		discardReason,
		breakdown: {
			resolution: resolutionPts,
			releaseType: releaseType.score,
			hdr: hdr.score,
			audio: audio.score,
			encoding: encoding.score,
			seeders: seederPts,
			sizeScore,
			groupBonus,
			language: lang.score,
		},
		labels: {
			releaseType: releaseType.label,
			hdr: hdr.label,
			audio: audio.label,
			encoding: encoding.label,
			language: lang.label,
		},
		seeders,
		sizeMB,
	};
}

// ---------------------------------------------------------------------------
// Stream label builder
// ---------------------------------------------------------------------------

/**
 * Builds the human-readable stream name shown to the Stremio user.
 *
 * Format: "⚡ 4K HDR10+ | BluRay Atmos"
 * Omits sections for which no data was detected.
 */
function buildStreamName(quality) {
	const qualityStr = quality === "4k" ? "4K" : quality;
	return `⚡ ${qualityStr}`;
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the 40-char hex infoHash from a stream object.
 * Torrentio provides it either as stream.infoHash or inside the magnet URI.
 * Returns null if not found.
 */
function extractInfoHash(stream) {
	if (stream.infoHash) return stream.infoHash.toLowerCase();
	const url = stream.url ?? "";
	const match = url.match(/btih:([a-f0-9]{40})/i);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Deduplicates streams by infoHash — keeps only the entry with the highest
 * seeder count for each unique torrent. Streams without an extractable
 * infoHash are always kept (we can't dedup them).
 */
function deduplicateStreams(rawStreams) {
	const hashMap = new Map();
	const noHash = [];

	for (const stream of rawStreams) {
		const hash = extractInfoHash(stream);
		if (!hash) {
			noHash.push(stream);
			continue;
		}

		const title = stream.title ?? "";
		const seeders = extractSeeders(title);
		const existing = hashMap.get(hash);

		if (!existing || seeders > existing.seeders) {
			hashMap.set(hash, { stream, seeders });
		}
	}

	const deduped = Array.from(hashMap.values(), (e) => e.stream);
	return deduped.concat(noHash);
}

// ---------------------------------------------------------------------------
// Tracker enrichment
// ---------------------------------------------------------------------------

/** Well-known public trackers — appended to magnet links for faster peer discovery. */
const PUBLIC_TRACKERS = [
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.torrent.eu.org:451/announce",
	"udp://open.demonii.com:1337/announce",
	"udp://explodie.org:6969/announce",
	"udp://tracker.openbittorrent.com:6969/announce",
];

/**
 * Appends missing public tracker announces to a magnet URI.
 * Non-magnet URLs are returned unchanged.
 */
function enrichMagnet(url) {
	if (!url?.startsWith("magnet:")) return url;

	const existing = url.toLowerCase();
	const toAdd = PUBLIC_TRACKERS.filter(
		(tr) => !existing.includes(encodeURIComponent(tr).toLowerCase()) && !existing.includes(tr.toLowerCase()),
	);

	if (toAdd.length === 0) return url;
	return url + toAdd.map((tr) => `&tr=${encodeURIComponent(tr)}`).join("");
}

// ---------------------------------------------------------------------------
// Stream selection core
// ---------------------------------------------------------------------------

/**
 * Analyses a raw Torrentio streams array, scores every stream, discards
 * CAM/TS entries and low-seeder streams, deduplicates by infoHash,
 * buckets the rest into quality tiers, and returns the winning stream
 * per tier as enriched Stremio stream objects.
 *
 * Returns { streams, debugInfo } where debugInfo is used by /debug endpoint.
 */
/**
 * Enriches a winning stream with tracker sources for faster peer discovery.
 */
function enrichWinnerStream(stream) {
	if (stream.url) {
		return { ...stream, url: enrichMagnet(stream.url) };
	}
	if (stream.infoHash && !stream.sources) {
		return {
			...stream,
			sources: [
				`dht:${stream.infoHash}`,
				...PUBLIC_TRACKERS.map((tr) => `tracker:${tr}`),
			],
		};
	}
	return { ...stream };
}

/**
 * Returns the discard reason string for a stream that failed filtering.
 */
function discardReason(scored) {
	if (scored.discardReason) return scored.discardReason;
	if (scored.seeders < MIN_SEEDERS) return `<${MIN_SEEDERS} seeders`;
	return "score too low";
}

function analyseStreams(rawStreams) {
	const dedupedStreams = deduplicateStreams(rawStreams);
	const buckets = new Map(QUALITY_TIERS.map((q) => [q, null]));
	const discardedLog = [];

	for (const stream of dedupedStreams) {
		const scored = scoreStream(stream);

		if (scored.discarded || scored.seeders < MIN_SEEDERS) {
			discardedLog.push({
				name: stream.name ?? "",
				title: (stream.title ?? "").split("\n")[0],
				reason: discardReason(scored),
				score: scored.total,
			});
			continue;
		}

		if (!QUALITY_TIERS.includes(scored.quality)) continue;

		const current = buckets.get(scored.quality);
		if (!current || scored.total > current.scored.total) {
			buckets.set(scored.quality, { stream, scored });
		}
	}

	const streams = [];
	const winners = {};

	for (const quality of QUALITY_TIERS) {
		const entry = buckets.get(quality);
		if (!entry) continue;

		const name = buildStreamName(quality);
		const enriched = enrichWinnerStream({ ...entry.stream, name });
		streams.push(enriched);

		winners[`winner_${quality}`] = {
			name,
			score: entry.scored.total,
			breakdown: entry.scored.breakdown,
			labels: entry.scored.labels,
			seeders: entry.scored.seeders,
			sizeMB: entry.scored.sizeMB,
		};
	}

	return {
		streams,
		debugInfo: {
			...winners,
			discarded: discardedLog,
			total_streams_analyzed: rawStreams.length,
		},
	};
}

/** Convenience wrapper — returns only the streams array for normal requests. */
function selectBestStreams(rawStreams) {
	return analyseStreams(rawStreams).streams;
}

// ---------------------------------------------------------------------------
// Torrentio fetch
// ---------------------------------------------------------------------------

/**
 * Fetches streams from Torrentio for a given type + id.
 * Tries the primary instance first; on failure (5xx, timeout, non-JSON),
 * falls back to the secondary instance.
 * Returns an empty array only if both fail — the Worker must never crash.
 */
async function fetchTorrentioStreams(type, id, torrentioBase = TORRENTIO_DEFAULT) {
	const path = `/stream/${type}/${id}.json`;
	const bases = [torrentioBase];
	if (torrentioBase !== TORRENTIO_FALLBACK) bases.push(TORRENTIO_FALLBACK);

	for (const base of bases) {
		const url = `${base}${path}`;
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(8_000),
				cf: { cacheTtl: 28800, cacheEverything: true },
			});

			if (!response.ok) {
				console.error(`Torrentio returned ${response.status} for ${url}`);
				continue;
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (!contentType.includes("application/json")) {
				console.error(`Torrentio returned non-JSON content-type "${contentType}" for ${url}`);
				continue;
			}

			const data = await response.json();
			return Array.isArray(data.streams) ? data.streams : [];
		} catch (err) {
			console.error(`Failed to fetch from Torrentio (${base}): ${err.message}`);
		}
	}

	return [];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200, cacheSeconds = 0, pretty = false) {
	const headers = {
		...CORS_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
	};
	if (cacheSeconds > 0) {
		headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
	} else {
		headers["Cache-Control"] = "no-store";
	}
	const body = pretty
		? JSON.stringify(data, null, 2)
		: JSON.stringify(data);
	return new Response(body, { status, headers });
}

function notFound() {
	return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
}

/**
 * Builds a cacheable JSON response with SWR metadata headers.
 * - X-Cached-At: unix timestamp when this entry was created
 * - X-Soft-TTL: the "fresh" window in seconds; after this, background revalidation fires
 * - Cache-Control max-age: set to 4× soft TTL so CF cache keeps the entry around
 *   long enough for stale serving + revalidation
 */
function buildCachedResponse(streams) {
	// Adaptive soft TTL:
	// - 0 streams: 3h (Torrentio failed — avoid hammering with retries)
	// - < 2 streams: 10 min (new release)
	// - normal: 8h
	let softTtl;
	if (streams.length === 0) {
		softTtl = 10800;
	} else if (streams.length < 2) {
		softTtl = 600;
	} else {
		softTtl = 28800;
	}

	const headers = {
		...CORS_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": `public, max-age=${softTtl * 4}`,
		"X-Cached-At": String(Math.floor(Date.now() / 1000)),
		"X-Soft-TTL": String(softTtl),
	};

	return new Response(JSON.stringify({ streams }), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Handles:
 *   GET  /manifest.json
 *   GET  /stream/movie/:id.json
 *   GET  /stream/series/:id.json
 *   GET  /debug/movie/:id
 *   GET  /debug/series/:id
 *   OPTIONS *  (CORS pre-flight)
 *   GET  /  (redirect → /manifest.json)
 */
async function handleStreamRoute(request, ctx, type, id, torrentioBase) {
	if (!/^tt\d+(:\d+:\d+)?$/.test(id)) {
		return jsonResponse({ streams: [] }, 200, 60);
	}

	const cache = caches.default;
	const cacheKey = new Request(
		`${new URL(request.url).origin}/stream/${type}/${id}.json`,
	);
	const cached = await cache.match(cacheKey);

	if (cached) {
		const cachedAt = Number.parseInt(cached.headers.get("X-Cached-At") ?? "0", 10);
		const softTtl = Number.parseInt(cached.headers.get("X-Soft-TTL") ?? "28800", 10);
		const age = Math.floor(Date.now() / 1000) - cachedAt;

		if (age > softTtl && ctx) {
			ctx.waitUntil((async () => {
				const rawStreams = await fetchTorrentioStreams(type, id, torrentioBase);
				if (rawStreams.length === 0) return;
				const fresh = buildCachedResponse(selectBestStreams(rawStreams));
				await cache.put(cacheKey, fresh);
			})());
		}

		return new Response(cached.body, {
			status: cached.status,
			headers: { ...Object.fromEntries(cached.headers), ...CORS_HEADERS },
		});
	}

	const rawStreams = await fetchTorrentioStreams(type, id, torrentioBase);
	const response = buildCachedResponse(selectBestStreams(rawStreams));
	if (ctx && rawStreams.length > 0) ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function handleDebugRoute(searchParams, type, id, torrentioBase, debugKey) {
	if (debugKey && searchParams.get("key") !== debugKey) {
		return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
	}
	const rawStreams = await fetchTorrentioStreams(type, id, torrentioBase);
	const { debugInfo } = analyseStreams(rawStreams);
	return jsonResponse(debugInfo, 200, 0, true);
}

async function handleRequest(request, ctx, env = {}) {
	const { pathname, searchParams } = new URL(request.url);
	const torrentioBase = env.TORRENTIO_URL ?? TORRENTIO_DEFAULT;

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
	}

	if (pathname === "/manifest.json") {
		return jsonResponse(MANIFEST, 200, 86400);
	}

	const streamMatch = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(pathname);
	if (streamMatch) {
		const [, type, id] = streamMatch;
		return handleStreamRoute(request, ctx, type, decodeURIComponent(id), torrentioBase);
	}

	const debugMatch = /^\/debug\/(movie|series)\/([^/]+)$/.exec(pathname);
	if (debugMatch) {
		const [, type, id] = debugMatch;
		return handleDebugRoute(searchParams, type, decodeURIComponent(id), torrentioBase, env.DEBUG_KEY);
	}

	if (pathname === "/" || pathname === "") {
		return new Response(null, {
			status: 302,
			headers: { ...CORS_HEADERS, Location: "/manifest.json" },
		});
	}

	return notFound();
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
	async fetch(request, env, ctx) {
		return handleRequest(request, ctx, env);
	},
};

// ---------------------------------------------------------------------------
// Named exports for unit testing
// ---------------------------------------------------------------------------

export {
	calcSizeScore,
	deduplicateStreams,
	detectLanguage,
	detectQuality,
	enrichMagnet,
	extractInfoHash,
	extractSeeders,
	extractSizeMB,
	seederScore,
	scoreStream,
	buildStreamName,
	analyseStreams,
	selectBestStreams,
	fetchTorrentioStreams,
	handleRequest,
	MANIFEST,
};
