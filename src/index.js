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
	version: "1.0.0",
	name: "StreamPeak",
	description:
		"Stop guessing which stream to pick. StreamPeak analyzes every available stream and surfaces only the best 4K, 1080p, 720p, and 480p options — scored by quality, audio, and reliability. Built by Blagovest Kirilov.",
	types: ["movie", "series"],
	catalogs: [],
	resources: ["stream"],
	idPrefixes: ["tt"],
	logo: "https://raw.githubusercontent.com/BlagovestKirilov/streampeak/master/assets/streampeak.png",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TORRENTIO_BASE = "https://torrentio.strem.fun";

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
 */
const HDR_TYPES = [
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
	{ re: /dts.?hd/i, score: 70, label: "DTS-HD" },
	{ re: /\bdts\b/i, score: 70, label: "DTS" },
	{ re: /dd\+|eac3|dolby.?digital.?plus/i, score: 60, label: "DD+" },
	{ re: /\bac3\b|dolby.?digital|\bdd\b/i, score: 40, label: "DD" },
	{ re: /\baac\b/i, score: 20, label: "AAC" },
];

/**
 * ENCODING SCORE
 */
const ENCODING_TYPES = [
	{ re: /x265|h\.?265|hevc/i, score: 30, label: "x265" },
	{ re: /\bav1\b/i, score: 25, label: "AV1" },
	{ re: /x264|h\.?264/i, score: 10, label: "x264" },
];

/**
 * KNOWN QUALITY RELEASE GROUPS — bonus points
 */
const QUALITY_GROUPS =
	/\b(YTS|YIFY|SPARKS|FGT|ROVERS|GECKOS|DEFLATE|CMRG|NTb|FLUX|LAZY|TEPES|MZABI|TIGOLE)\b/i;

/**
 * SEEDER SCORE — logarithmic curve so seeders are a meaningful factor.
 *
 * Range: -500 (dead) → -200 (nearly dead) → ~0 (10 seeders) → 150 (500+).
 * The log curve ensures the jump from 17→229 is significant (~85 pts)
 * while 229→1000 adds diminishing returns (~33 pts).
 */
function seederScore(n) {
	if (n <= 0) return -500;
	if (n < 3) return -200;
	return Math.min(Math.round(75 * Math.log10(n) - 60), 150);
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Returns which quality bucket a stream belongs to ("4k" | "1080p" | "720p" |
 * "480p" | null).
 */
function detectQuality(text) {
	if (/2160p|4k|uhd/i.test(text)) return "4k";
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
	const emojiMatch = title.match(/\u{1F464}\s*(\d+)/u);
	if (emojiMatch) return parseInt(emojiMatch[1], 10);

	const seedsMatch = title.match(/seeds?[:\s]+(\d+)/i);
	if (seedsMatch) return parseInt(seedsMatch[1], 10);

	return 0;
}

/**
 * Extracts file size from a Torrentio title string ("💾 18.5 GB" / "💾 2.3 MB").
 * Returns size in MB, or 0 if not found.
 */
function extractSizeMB(title) {
	// 💾 is U+1F4BE
	const match = title.match(/\u{1F4BE}\s*([\d.]+)\s*(MB|GB)/iu);
	if (!match) return 0;

	const value = parseFloat(match[1]);
	const unit = match[2].toUpperCase();
	return unit === "GB" ? value * 1024 : value;
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
 *     resolution, releaseType, hdr, audio, encoding, seeders, sizePenalty, groupBonus
 *   },
 *   labels: {                // human-readable detected values for stream naming
 *     releaseType, hdr, audio, encoding
 *   },
 *   seeders: number,
 *   sizeMB: number,
 * }
 */
function scoreStream(stream) {
	const combined = `${stream.name ?? ""} ${stream.title ?? ""}`;
	const title = stream.title ?? "";

	// ── Resolution ───────────────────────────────────────────────────────────
	const quality = detectQuality(combined);
	const resolutionPts = RESOLUTION_SCORES[quality] ?? 0;

	// ── Release type ─────────────────────────────────────────────────────────
	let releaseTypePts = 0;
	let releaseTypeLabel = "Unknown";
	let discarded = false;
	let discardReason = "";

	for (const { re, score, label } of RELEASE_TYPE) {
		if (re.test(combined)) {
			releaseTypePts = score;
			releaseTypeLabel = label;
			if (score <= -99999) {
				discarded = true;
				discardReason = label;
			}
			break;
		}
	}

	// ── HDR ──────────────────────────────────────────────────────────────────
	let hdrPts = 0;
	let hdrLabel = "";

	for (const { re, score, label } of HDR_TYPES) {
		if (re.test(combined)) {
			hdrPts = score;
			hdrLabel = label;
			break;
		}
	}

	// ── Audio ─────────────────────────────────────────────────────────────────
	let audioPts = 0;
	let audioLabel = "";

	for (const { re, score, label } of AUDIO_TYPES) {
		if (re.test(combined)) {
			audioPts = score;
			audioLabel = label;
			break;
		}
	}

	// ── Encoding ─────────────────────────────────────────────────────────────
	let encodingPts = 0;
	let encodingLabel = "";

	for (const { re, score, label } of ENCODING_TYPES) {
		if (re.test(combined)) {
			encodingPts = score;
			encodingLabel = label;
			break;
		}
	}

	// ── Seeders ───────────────────────────────────────────────────────────────
	const seeders = extractSeeders(title);
	const seederPts = seederScore(seeders);

	// ── File size sanity check ────────────────────────────────────────────────
	// A wildly small file for the claimed resolution is almost certainly
	// mislabelled or a sample — penalise it.
	const sizeMB = extractSizeMB(title);
	let sizePenalty = 0;

	if (sizeMB > 0) {
		if (quality === "4k" && sizeMB < 4 * 1024) sizePenalty = -500;
		else if (quality === "1080p" && sizeMB < 500) sizePenalty = -500;
		else if (quality === "720p" && sizeMB < 200) sizePenalty = -200;
	}

	// ── Release-group bonus ───────────────────────────────────────────────────
	const groupBonus = QUALITY_GROUPS.test(combined) ? 50 : 0;

	// ── Total ─────────────────────────────────────────────────────────────────
	const total =
		resolutionPts +
		releaseTypePts +
		hdrPts +
		audioPts +
		encodingPts +
		seederPts +
		sizePenalty +
		groupBonus;

	return {
		total,
		quality,
		discarded,
		discardReason,
		breakdown: {
			resolution: resolutionPts,
			releaseType: releaseTypePts,
			hdr: hdrPts,
			audio: audioPts,
			encoding: encodingPts,
			seeders: seederPts,
			sizePenalty,
			groupBonus,
		},
		labels: {
			releaseType: releaseTypeLabel,
			hdr: hdrLabel,
			audio: audioLabel,
			encoding: encodingLabel,
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
function buildStreamName(quality, scored) {
	const { labels } = scored;

	// Quality + optional HDR tag
	const qualityStr = quality === "4k" ? "4K" : quality;
	const hdrPart = labels.hdr ? ` ${labels.hdr}` : "";
	const qualityTag = `⚡ ${qualityStr}${hdrPart}`;

	// Release type + optional audio tag
	const audioPart = labels.audio ? ` ${labels.audio}` : "";
	const sourcePart =
		labels.releaseType !== "Unknown"
			? `${labels.releaseType}${audioPart}`
			: audioPart.trim();

	// Assemble — only include non-empty segments
	const segments = [qualityTag, sourcePart].filter(Boolean);

	return segments.join(" | ");
}

// ---------------------------------------------------------------------------
// Stream selection core
// ---------------------------------------------------------------------------

/**
 * Analyses a raw Torrentio streams array, scores every stream, discards
 * CAM/TS entries, buckets the rest into quality tiers, and returns the
 * winning stream per tier as enriched Stremio stream objects.
 *
 * Returns { streams, debugInfo } where debugInfo is used by /debug endpoint.
 */
function analyseStreams(rawStreams) {
	/** @type {Map<string, {stream: object, scored: object}>} */
	const buckets = new Map([
		["4k", null],
		["1080p", null],
		["720p", null],
		["480p", null],
	]);

	const discardedLog = [];

	for (const stream of rawStreams) {
		const scored = scoreStream(stream);

		if (scored.discarded || scored.total <= -99999) {
			discardedLog.push({
				name: stream.name ?? "",
				title: (stream.title ?? "").split("\n")[0],
				reason: scored.discardReason || "score too low",
				score: scored.total,
			});
			continue;
		}

		// Only bucket recognised quality tiers (skip unknown)
		if (!["4k", "1080p", "720p", "480p"].includes(scored.quality)) continue;

		const current = buckets.get(scored.quality);
		if (!current || scored.total > current.scored.total) {
			buckets.set(scored.quality, { stream, scored });
		}
	}

	// Build Stremio stream objects for winners
	const streams = [];
	const winners = {};

	for (const quality of ["4k", "1080p", "720p", "480p"]) {
		const entry = buckets.get(quality);
		if (!entry) continue;

		const name = buildStreamName(quality, entry.scored);
		streams.push({ ...entry.stream, name });

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
 * Returns an empty array on any error — the Worker must never crash.
 */
async function fetchTorrentioStreams(type, id) {
	const url = `${TORRENTIO_BASE}/stream/${type}/${id}.json`;

	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			console.error(`Torrentio returned ${response.status} for ${url}`);
			return [];
		}

		const data = await response.json();
		return Array.isArray(data.streams) ? data.streams : [];
	} catch (err) {
		console.error(`Failed to fetch from Torrentio: ${err.message}`);
		return [];
	}
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
	}
	const body = pretty
		? JSON.stringify(data, null, 2)
		: JSON.stringify(data);
	return new Response(body, { status, headers });
}

function notFound() {
	return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
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
async function handleRequest(request) {
	const { pathname } = new URL(request.url);

	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: CORS_HEADERS });
	}

	if (request.method !== "GET") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: CORS_HEADERS,
		});
	}

	// ── /manifest.json ──────────────────────────────────────────────────────
	if (pathname === "/manifest.json") {
		return jsonResponse(MANIFEST, 200, 86400);
	}

	// ── /stream/:type/:id.json ───────────────────────────────────────────────
	const streamMatch = pathname.match(
		/^\/stream\/(movie|series)\/([^/]+)\.json$/,
	);
	if (streamMatch) {
		const [, type, id] = streamMatch;
		const rawStreams = await fetchTorrentioStreams(type, id);
		const streams = selectBestStreams(rawStreams);
		return jsonResponse({ streams }, 200, 900);
	}

	// ── /debug/:type/:id ─────────────────────────────────────────────────────
	// Returns the full per-stream scoring breakdown for developer inspection.
	// Example: GET /debug/movie/tt0371746
	const debugMatch = pathname.match(/^\/debug\/(movie|series)\/([^/]+)$/);
	if (debugMatch) {
		const [, type, id] = debugMatch;
		const rawStreams = await fetchTorrentioStreams(type, id);
		const { debugInfo } = analyseStreams(rawStreams);
		return jsonResponse(debugInfo, 200, 0, true);
	}

	// ── /diag/:type/:id ──────────────────────────────────────────────────────
	const diagMatch = pathname.match(/^\/diag\/(movie|series)\/([^/]+)$/);
	if (diagMatch) {
		const [, type, id] = diagMatch;
		const url = `${TORRENTIO_BASE}/stream/${type}/${id}.json`;
		const result = { url, status: null, headers: {}, bodySnippet: "", error: null };
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
			result.status = response.status;
			for (const [k, v] of response.headers) result.headers[k] = v;
			const text = await response.text();
			result.bodySnippet = text.slice(0, 500);
		} catch (err) {
			result.error = err.message;
		}
		return jsonResponse(result, 200, 0, true);
	}

	// ── / (root redirect) ────────────────────────────────────────────────────
	if (pathname === "/" || pathname === "") {
		return new Response(null, {
			status: 302,
			headers: { ...CORS_HEADERS, Location: "/manifest.json" },
		});
	}

	return notFound();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
	detectQuality,
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
