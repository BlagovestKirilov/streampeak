import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
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
} from "../src/index.js";

const TORRENTIO_DEFAULT = "https://torrentio.withoutthefuss.dpdns.org";

// ---------------------------------------------------------------------------
// detectQuality
// ---------------------------------------------------------------------------

describe("detectQuality", () => {
	it.each([
		["2160p BluRay", "4k"],
		["4K UHD stream", "4k"],
		["UHD HDR DolbyVision", "4k"],
		["1080p WEB-DL", "1080p"],
		["720p WEBRip", "720p"],
		["480p DVDRip", "480p"],
		["No resolution info", null],
		["[Bluray 720p] ⚙️ Wolfmax4k", "720p"],
	])('detectQuality("%s") === %s', (text, expected) => {
		expect(detectQuality(text)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe("detectLanguage", () => {
	it("detects English keyword → score 100, no label", () => {
		expect(detectLanguage("1080p WEB-DL English")).toEqual({ score: 100, label: "" });
	});

	it("detects 'eng' abbreviation → score 100", () => {
		expect(detectLanguage("BluRay ENG x265")).toEqual({ score: 100, label: "" });
	});

	it("detects 🇬🇧 flag → score 100", () => {
		expect(detectLanguage("🇬🇧 English 1080p")).toEqual({ score: 100, label: "" });
	});

	it("detects 🇺🇸 flag → score 100", () => {
		expect(detectLanguage("🇺🇸 1080p WEB-DL")).toEqual({ score: 100, label: "" });
	});

	it("detects Multi → score 50, no label", () => {
		expect(detectLanguage("Multi 4K BluRay")).toEqual({ score: 50, label: "" });
	});

	it("detects non-English flag (🇷🇺) → score -200, label 'non-EN'", () => {
		expect(detectLanguage("🇷🇺 Russian 1080p")).toEqual({ score: -200, label: "non-EN" });
	});

	it("detects non-English flag (🇩🇪) → score -200, label 'non-EN'", () => {
		expect(detectLanguage("🇩🇪 1080p WEB-DL")).toEqual({ score: -200, label: "non-EN" });
	});

	it("detects explicit non-English language word → score -200", () => {
		expect(detectLanguage("French 1080p BluRay")).toEqual({ score: -200, label: "non-EN" });
	});

	it("returns score 0 when no language info", () => {
		expect(detectLanguage("1080p WEB-DL x265 Atmos")).toEqual({ score: 0, label: "" });
	});

	it("English takes priority over flag catch-all (🇬🇧 matched first)", () => {
		expect(detectLanguage("🇬🇧 English 4K BluRay")).toEqual({ score: 100, label: "" });
	});
});

// ---------------------------------------------------------------------------
// extractSeeders
// ---------------------------------------------------------------------------

describe("extractSeeders", () => {
	it("extracts seeders from 👤 format", () => {
		expect(extractSeeders("4K / BluRay\n👤 342 💾 18.5 GB")).toBe(342);
	});

	it("extracts seeders from 'Seeds: N' format", () => {
		expect(extractSeeders("1080p WEB-DL Seeds: 891")).toBe(891);
	});

	it("extracts seeders from 'seed N' format", () => {
		expect(extractSeeders("720p seed 5")).toBe(5);
	});

	it("returns 0 when no seeder info", () => {
		expect(extractSeeders("720p WEBRip x264")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// extractSizeMB
// ---------------------------------------------------------------------------

describe("extractSizeMB", () => {
	it("parses GB correctly", () => {
		expect(extractSizeMB("4K BluRay\n👤 342 💾 18.5 GB ⚙ YTS")).toBeCloseTo(
			18.5 * 1024,
			0,
		);
	});

	it("parses MB correctly", () => {
		expect(extractSizeMB("720p WEBRip\n👤 50 💾 850 MB ⚙ YTS")).toBe(850);
	});

	it("returns 0 when no size info", () => {
		expect(extractSizeMB("1080p WEB-DL no size")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// seederScore
// ---------------------------------------------------------------------------

describe("seederScore", () => {
	it.each([
		[1500, 150],
		[750, 150],
		[300, 126],
		[150, 103],
		[75, 81],
		[25, 45],
		[3, -24],
		[2, -200],
		[0, -99999],
	])("seederScore(%i) === %i", (n, expected) => {
		expect(seederScore(n)).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// calcSizeScore
// ---------------------------------------------------------------------------

describe("calcSizeScore", () => {
	// 4K
	it("4K too small (<4 GB) → -500", () => {
		expect(calcSizeScore("4k", 2.5 * 1024)).toBe(-500);
	});

	it("4K sweet spot (5–25 GB) → +75", () => {
		expect(calcSizeScore("4k", 15 * 1024)).toBe(75);
	});

	it("4K acceptable (25–40 GB) → +25", () => {
		expect(calcSizeScore("4k", 35 * 1024)).toBe(25);
	});

	it("4K oversized (>40 GB encode) → -100", () => {
		expect(calcSizeScore("4k", 50 * 1024)).toBe(-100);
	});

	it("4K oversized remux (>40 GB) → -300", () => {
		expect(calcSizeScore("4k", 65 * 1024, true)).toBe(-300);
	});

	// 1080p
	it("1080p too small (<500 MB) → -500", () => {
		expect(calcSizeScore("1080p", 300)).toBe(-500);
	});

	it("1080p sweet spot (2–10 GB) → +75", () => {
		expect(calcSizeScore("1080p", 6 * 1024)).toBe(75);
	});

	it("1080p acceptable (10–20 GB) → +25", () => {
		expect(calcSizeScore("1080p", 15 * 1024)).toBe(25);
	});

	it("1080p oversized (>20 GB encode) → -100", () => {
		expect(calcSizeScore("1080p", 25 * 1024)).toBe(-100);
	});

	it("1080p oversized remux (>20 GB) → -300", () => {
		expect(calcSizeScore("1080p", 30 * 1024, true)).toBe(-300);
	});

	// 720p
	it("720p too small (<200 MB) → -200", () => {
		expect(calcSizeScore("720p", 150)).toBe(-200);
	});

	it("720p sweet spot (0.5–4 GB) → +50", () => {
		expect(calcSizeScore("720p", 2 * 1024)).toBe(50);
	});

	it("720p acceptable (4–8 GB) → +25", () => {
		expect(calcSizeScore("720p", 6 * 1024)).toBe(25);
	});

	it("720p oversized (>8 GB) → -50", () => {
		expect(calcSizeScore("720p", 10 * 1024)).toBe(-50);
	});

	it("720p oversized remux → -200", () => {
		expect(calcSizeScore("720p", 12 * 1024, true)).toBe(-200);
	});

	// Edge cases
	it("unknown size (0) → 0", () => {
		expect(calcSizeScore("4k", 0)).toBe(0);
	});

	it("480p → always 0", () => {
		expect(calcSizeScore("480p", 5 * 1024)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// scoreStream
// ---------------------------------------------------------------------------

describe("scoreStream", () => {
	const make = (name, title) => ({ name, title, url: "magnet:?test" });

	it("correctly identifies 4K BluRay HDR Atmos stream", () => {
		const s = scoreStream(
			make("Torrentio", "4K / 2160p / BluRay / x265 / HDR / Atmos\n👤 342 💾 45 GB ⚙ YTS"),
		);

		expect(s.quality).toBe("4k");
		expect(s.discarded).toBe(false);
		expect(s.breakdown.resolution).toBe(1000);
		expect(s.breakdown.releaseType).toBe(400);
		expect(s.breakdown.hdr).toBe(100);
		expect(s.breakdown.audio).toBe(100);
		expect(s.breakdown.encoding).toBe(50);
		expect(s.seeders).toBe(342);
		expect(s.labels.releaseType).toBe("BluRay");
		expect(s.labels.hdr).toBe("HDR");
		expect(s.labels.audio).toBe("Atmos");
	});

	it("marks CAM stream as discarded with -99999 release type", () => {
		const s = scoreStream(make("Torrentio", "1080p CAM\n👤 500 💾 1 GB ⚙ Source"));
		expect(s.discarded).toBe(true);
		expect(s.discardReason).toBe("CAM");
		expect(s.breakdown.releaseType).toBe(-99999);
		expect(s.total).toBeLessThan(-98000);
	});

	it("marks TS stream as discarded", () => {
		const s = scoreStream(make("Torrentio", "720p TS\n👤 999 💾 1 GB ⚙ Source"));
		expect(s.discarded).toBe(true);
		expect(s.total).toBeLessThan(-98000);
	});

	it("marks HDCAM stream as discarded", () => {
		const s = scoreStream(make("Torrentio", "1080p HDCAM\n👤 200 💾 2 GB ⚙ Source"));
		expect(s.discarded).toBe(true);
	});

	it("marks TELESYNC stream as discarded", () => {
		const s = scoreStream(make("Torrentio", "720p TeleSync\n👤 100 💾 1 GB ⚙ Source"));
		expect(s.discarded).toBe(true);
	});

	it("applies size penalty for mislabeled 4K stream (< 4 GB)", () => {
		const s = scoreStream(
			make("Torrentio", "4K UHD WEB-DL\n👤 200 💾 2.5 GB ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(-500);
	});

	it("applies size penalty for mislabeled 1080p stream (< 500 MB)", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL\n👤 200 💾 300 MB ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(-500);
	});

	it("applies size penalty for mislabeled 720p stream (< 200 MB)", () => {
		const s = scoreStream(
			make("Torrentio", "720p WEBRip\n👤 100 💾 150 MB ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(-200);
	});

	it("does NOT apply size penalty when size is 0 (unknown)", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay\n👤 342 ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(0);
	});

	it("applies group bonus for known release groups", () => {
		const s = scoreStream(
			make("[SPARKS] Movie", "1080p WEB-DL\n👤 200 💾 6 GB ⚙ SPARKS"),
		);
		expect(s.breakdown.groupBonus).toBe(50);
	});

	it("does NOT apply group bonus for YIFY/YTS (low quality groups)", () => {
		const s = scoreStream(
			make("[YTS] Movie", "1080p WEB-DL\n👤 200 💾 6 GB ⚙ YTS"),
		);
		expect(s.breakdown.groupBonus).toBe(0);
	});

	it("no group bonus for unknown groups", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL\n👤 200 💾 6 GB ⚙ Source"),
		);
		expect(s.breakdown.groupBonus).toBe(0);
	});

	it("gives 0-seeder streams -99999 seeder score (discarded)", () => {
		const s = scoreStream(
			make("Torrentio", "1080p BluRay\n👤 0 💾 8 GB ⚙ Source"),
		);
		expect(s.breakdown.seeders).toBe(-99999);
		expect(s.seeders).toBe(0);
	});

	it("detects HDR10+", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay HDR10+\n👤 200 💾 50 GB ⚙ Source"),
		);
		expect(s.labels.hdr).toBe("HDR10+");
		expect(s.breakdown.hdr).toBe(150);
	});

	it("detects Dolby Vision", () => {
		const s = scoreStream(
			make("Torrentio", "4K WEB-DL Dolby Vision\n👤 200 💾 20 GB ⚙ Source"),
		);
		expect(s.labels.hdr).toBe("DV");
		expect(s.breakdown.hdr).toBe(120);
	});

	it("detects DV+HDR dual-layer combo → 170 pts", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay Dolby Vision HDR\n👤 200 💾 20 GB ⚙ Source"),
		);
		expect(s.labels.hdr).toBe("DV HDR");
		expect(s.breakdown.hdr).toBe(170);
	});

	it("detects DV+HDR with DoVi abbreviation", () => {
		const s = scoreStream(
			make("Torrentio", "4K WEB-DL DoVi HDR\n👤 200 💾 20 GB ⚙ Source"),
		);
		expect(s.labels.hdr).toBe("DV HDR");
		expect(s.breakdown.hdr).toBe(170);
	});

	it("DV+HDR scores higher than HDR10+ alone", () => {
		const dvHdr = scoreStream(
			make("Torrentio", "4K BluRay Dolby Vision HDR x265\n👤 200 💾 20 GB ⚙ Source"),
		);
		const hdr10 = scoreStream(
			make("Torrentio", "4K BluRay HDR10+ x265\n👤 200 💾 20 GB ⚙ Source"),
		);
		expect(dvHdr.breakdown.hdr).toBeGreaterThan(hdr10.breakdown.hdr);
	});

	it("detects REMUX release type → 350 pts", () => {
		const s = scoreStream(
			make("Torrentio", "4K Remux Atmos\n👤 200 💾 60 GB ⚙ Source"),
		);
		expect(s.labels.releaseType).toBe("REMUX");
		expect(s.breakdown.releaseType).toBe(350);
	});

	it("REMUX gets harsher size penalty than encode when oversized", () => {
		const remux = scoreStream(
			make("Torrentio", "4K Remux Atmos\n👤 200 💾 65 GB ⚙ Source"),
		);
		const encode = scoreStream(
			make("Torrentio", "4K BluRay Atmos x265\n👤 200 💾 65 GB ⚙ Source"),
		);
		expect(remux.breakdown.sizeScore).toBeLessThan(encode.breakdown.sizeScore);
	});

	it("sweet-spot 4K encode gets +75 sizeScore", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay x265\n👤 200 💾 15 GB ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(75);
	});

	it("sweet-spot 1080p encode gets +75 sizeScore", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL x265\n👤 200 💾 6 GB ⚙ Source"),
		);
		expect(s.breakdown.sizeScore).toBe(75);
	});

	it("sweet-spot 1080p beats oversized 1080p remux", () => {
		const sweet = scoreStream(
			make("Torrentio", "1080p BluRay x265\n👤 200 💾 8 GB ⚙ Source"),
		);
		const remux = scoreStream(
			make("Torrentio", "1080p Remux DTS-HD MA\n👤 200 💾 30 GB ⚙ Source"),
		);
		expect(sweet.total).toBeGreaterThan(remux.total);
	});

	it("detects DTS-HD MA audio", () => {
		const s = scoreStream(
			make("Torrentio", "1080p BluRay DTS-HD MA\n👤 300 💾 15 GB ⚙ Source"),
		);
		expect(s.labels.audio).toBe("DTS-HD MA");
		expect(s.breakdown.audio).toBe(90);
	});

	it("detects x265 encoding", () => {
		const s = scoreStream(
			make("Torrentio", "1080p BluRay x265\n👤 300 💾 8 GB ⚙ Source"),
		);
		expect(s.labels.encoding).toBe("x265");
		expect(s.breakdown.encoding).toBe(50);
	});

	it("detects AV1 encoding", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL AV1\n👤 300 💾 4 GB ⚙ Source"),
		);
		expect(s.labels.encoding).toBe("AV1");
		expect(s.breakdown.encoding).toBe(45);
	});

	it("detects x264 encoding", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL x264\n👤 300 💾 4 GB ⚙ Source"),
		);
		expect(s.labels.encoding).toBe("x264");
		expect(s.breakdown.encoding).toBe(20);
	});

	it("DTS-HD scores 75, higher than plain DTS (70)", () => {
		const dtsHd = scoreStream(
			make("Torrentio", "1080p BluRay DTS-HD\n👤 300 💾 15 GB ⚙ Source"),
		);
		const dts = scoreStream(
			make("Torrentio", "1080p BluRay DTS\n👤 300 💾 15 GB ⚙ Source"),
		);
		expect(dtsHd.breakdown.audio).toBe(75);
		expect(dts.breakdown.audio).toBe(70);
		expect(dtsHd.breakdown.audio).toBeGreaterThan(dts.breakdown.audio);
	});

	it("English stream gets +100 language bonus", () => {
		const s = scoreStream(make("🇬🇧 English", "1080p WEB-DL x265\n👤 100 💾 6 GB ⚙ Source"));
		expect(s.breakdown.language).toBe(100);
		expect(s.labels.language).toBe("");
	});

	it("Multi stream gets +50 language bonus", () => {
		const s = scoreStream(make("Multi", "1080p WEB-DL x265\n👤 100 💾 6 GB ⚙ Source"));
		expect(s.breakdown.language).toBe(50);
		expect(s.labels.language).toBe("");
	});

	it("non-English stream (Russian flag) gets -200 language penalty and 'non-EN' label", () => {
		const s = scoreStream(make("🇷🇺 Russian", "1080p WEB-DL x265\n👤 100 💾 6 GB ⚙ Source"));
		expect(s.breakdown.language).toBe(-200);
		expect(s.labels.language).toBe("non-EN");
	});

	it("unknown language gets 0 language pts", () => {
		const s = scoreStream(make("Torrentio", "1080p WEB-DL x265\n👤 100 💾 6 GB ⚙ Source"));
		expect(s.breakdown.language).toBe(0);
		expect(s.labels.language).toBe("");
	});

	it("English stream scores higher than identical non-English stream", () => {
		const eng = scoreStream(make("🇬🇧 English", "1080p WEB-DL x265\n👤 200 💾 6 GB ⚙ Source"));
		const rus = scoreStream(make("🇷🇺 Russian", "1080p WEB-DL x265\n👤 200 💾 6 GB ⚙ Source"));
		expect(eng.total).toBeGreaterThan(rus.total);
		expect(eng.total - rus.total).toBe(300);
	});
});

// ---------------------------------------------------------------------------
// buildStreamName
// ---------------------------------------------------------------------------

describe("buildStreamName", () => {
	it("returns ⚡ 4K for 4k quality", () => {
		expect(buildStreamName("4k")).toBe("⚡ 4K");
	});

	it("returns ⚡ 1080p for 1080p quality", () => {
		expect(buildStreamName("1080p")).toBe("⚡ 1080p");
	});

	it("returns ⚡ 720p for 720p quality", () => {
		expect(buildStreamName("720p")).toBe("⚡ 720p");
	});

	it("returns ⚡ 480p for 480p quality", () => {
		expect(buildStreamName("480p")).toBe("⚡ 480p");
	});
});

// ---------------------------------------------------------------------------
// analyseStreams / selectBestStreams
// ---------------------------------------------------------------------------

describe("analyseStreams", () => {
	const make = (name, title, url = "magnet:?test") => ({ name, title, url });

	it("picks highest-scoring stream per bucket", () => {
		const raw = [
			make("Torrentio", "1080p WEB-DL x265\n👤 200 💾 5 GB ⚙ Source"),
			make("Torrentio", "1080p BluRay x265 Atmos\n👤 891 💾 12 GB ⚙ Source"),
			make("Torrentio", "4K BluRay HDR x265 Atmos\n👤 342 💾 45 GB ⚙ Source"),
			make("Torrentio", "720p WEBRip x264\n👤 234 💾 2 GB ⚙ Source"),
		];

		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(3);
		expect(streams[0].name).toMatch(/4K/);
		expect(streams[1].name).toMatch(/1080p/);
		expect(streams[2].name).toMatch(/720p/);
	});

	it("includes discarded list in debugInfo", () => {
		const raw = [
			make("Torrentio", "1080p CAM\n👤 500 💾 1 GB ⚙ Source"),
			make("Torrentio", "1080p WEB-DL\n👤 300 💾 5 GB ⚙ Source"),
		];

		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(debugInfo.discarded).toHaveLength(1);
		expect(debugInfo.discarded[0].reason).toBe("CAM");
		expect(debugInfo.total_streams_analyzed).toBe(2);
	});

	it("discards TS streams", () => {
		const raw = [make("Torrentio", "720p TS\n👤 999 💾 1 GB ⚙ Source")];
		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(0);
		expect(debugInfo.discarded).toHaveLength(1);
	});

	it("prefers BluRay over WEB-DL at equal seeders via score", () => {
		const raw = [
			make("Torrentio", "1080p WEB-DL\n👤 100 💾 5 GB ⚙ Source"),
			make("Torrentio", "1080p BluRay\n👤 100 💾 8 GB ⚙ Source"),
		];

		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toBe("⚡ 1080p");
		expect(debugInfo.winner_1080p.labels.releaseType).toBe("BluRay");
	});

	it("returns empty streams when all are CAM/TS", () => {
		const raw = [
			make("Torrentio", "720p CAM\n👤 50 💾 1 GB ⚙ Source"),
			make("Torrentio", "1080p TS\n👤 30 💾 1 GB ⚙ Source"),
		];
		expect(analyseStreams(raw).streams).toHaveLength(0);
	});

	it("includes 480p bucket when available", () => {
		const raw = [make("Torrentio", "480p DVDRip\n👤 50 💾 700 MB ⚙ Source")];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toMatch(/480p/);
	});

	it("skips missing quality tiers (only 1080p available)", () => {
		const raw = [make("Torrentio", "1080p WEB-DL\n👤 400 💾 6 GB ⚙ Source")];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toMatch(/1080p/);
	});

	it("preserves original stream fields (url, behaviorHints) and enriches magnet", () => {
		const raw = [
			{
				name: "Torrentio",
				title: "4K BluRay\n👤 342 💾 45 GB ⚙ Source",
				url: "magnet:?xt=urn:btih:abc",
				behaviorHints: { notWebReady: true },
			},
		];

		const { streams } = analyseStreams(raw);
		expect(streams[0].url).toContain("magnet:?xt=urn:btih:abc");
		expect(streams[0].url).toContain("&tr=");
		expect(streams[0].behaviorHints).toEqual({ notWebReady: true });
	});

	it("includes winner details in debugInfo", () => {
		const raw = [
			make("Torrentio", "4K BluRay HDR x265 Atmos\n👤 342 💾 45 GB ⚙ Source"),
		];

		const { debugInfo } = analyseStreams(raw);
		expect(debugInfo.winner_4k).toBeDefined();
		expect(debugInfo.winner_4k.score).toBeGreaterThan(0);
		expect(debugInfo.winner_4k.breakdown).toBeDefined();
	});

	it("discards low-seeder streams (<5) and logs reason", () => {
		const raw = [make("Torrentio", "1080p BluRay\n👤 3 💾 8 GB ⚙ Source")];
		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(0);
		expect(debugInfo.discarded).toHaveLength(1);
		expect(debugInfo.discarded[0].reason).toBe("<5 seeders");
	});

	it("0-seeder stream (no seeder count) is discarded", () => {
		const raw = [
			make("Torrentio", "1080p BluRay\n👤 0 💾 8 GB ⚙ Source"),
			make("Torrentio", "1080p WEB-DL\n👤 5 💾 6 GB ⚙ Source"),
		];
		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toBe("⚡ 1080p");
		expect(debugInfo.winner_1080p.labels.releaseType).toBe("WEB-DL");
	});

	it("English stream beats non-English stream of same quality and seeders", () => {
		const raw = [
			make("🇷🇺 Russian", "1080p WEB-DL x265\n👤 200 💾 8 GB ⚙ Source"),
			make("🇬🇧 English", "1080p WEB-DL x265\n👤 200 💾 8 GB ⚙ Source"),
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).not.toMatch(/\[non-EN]/);
	});

	it("non-English winner shows same name format as English (no language tag)", () => {
		const raw = [
			make("🇷🇺 Russian", "1080p WEB-DL x265\n👤 200 💾 8 GB ⚙ Source"),
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toMatch(/^⚡ 1080p/);
		expect(streams[0].name).not.toMatch(/non-EN/);
	});
});

describe("selectBestStreams", () => {
	it("is a convenience wrapper returning only the streams array", () => {
		const raw = [
			{ name: "T", title: "1080p WEB-DL\n👤 300 💾 6 GB ⚙ S", url: "m" },
		];
		const result = selectBestStreams(raw);
		expect(Array.isArray(result)).toBe(true);
		expect(result[0].name).toMatch(/1080p/);
	});
});

// ---------------------------------------------------------------------------
// extractInfoHash
// ---------------------------------------------------------------------------

describe("extractInfoHash", () => {
	it("extracts infoHash from stream.infoHash field", () => {
		const stream = { infoHash: "AABB00112233445566778899AABBCCDDEEFF0011" };
		expect(extractInfoHash(stream)).toBe("aabb00112233445566778899aabbccddeeff0011");
	});

	it("extracts infoHash from magnet URI in stream.url", () => {
		const stream = {
			url: "magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&dn=Movie",
		};
		expect(extractInfoHash(stream)).toBe("1234567890abcdef1234567890abcdef12345678");
	});

	it("returns null when no infoHash found", () => {
		const stream = { name: "T", title: "1080p", url: "http://example.com/file.mkv" };
		expect(extractInfoHash(stream)).toBeNull();
	});

	it("returns null when stream has no url or infoHash", () => {
		const stream = { name: "T", title: "1080p" };
		expect(extractInfoHash(stream)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// deduplicateStreams
// ---------------------------------------------------------------------------

describe("deduplicateStreams", () => {
	const hash1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const hash2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("keeps highest-seeder entry for duplicate infoHash", () => {
		const streams = [
			{ infoHash: hash1, title: "1080p BluRay\n👤 50 💾 8 GB", name: "T" },
			{ infoHash: hash1, title: "1080p BluRay\n👤 200 💾 8 GB", name: "T" },
			{ infoHash: hash1, title: "1080p BluRay\n👤 100 💾 8 GB", name: "T" },
		];
		const result = deduplicateStreams(streams);
		expect(result).toHaveLength(1);
		expect(result[0].title).toContain("👤 200");
	});

	it("keeps all entries with different infoHashes", () => {
		const streams = [
			{ infoHash: hash1, title: "1080p\n👤 50 💾 5 GB", name: "T" },
			{ infoHash: hash2, title: "4K\n👤 30 💾 20 GB", name: "T" },
		];
		const result = deduplicateStreams(streams);
		expect(result).toHaveLength(2);
	});

	it("preserves streams without infoHash (cannot dedup)", () => {
		const streams = [
			{ name: "T", title: "1080p\n👤 50 💾 5 GB", url: "http://example.com/a.mkv" },
			{ name: "T", title: "1080p\n👤 80 💾 5 GB", url: "http://example.com/b.mkv" },
		];
		const result = deduplicateStreams(streams);
		expect(result).toHaveLength(2);
	});

	it("extracts hash from magnet URI for dedup", () => {
		const magnetA = `magnet:?xt=urn:btih:${hash1}&dn=Movie+A`;
		const magnetB = `magnet:?xt=urn:btih:${hash1}&dn=Movie+B`;
		const streams = [
			{ name: "T", title: "1080p\n👤 10 💾 5 GB", url: magnetA },
			{ name: "T", title: "1080p\n👤 99 💾 5 GB", url: magnetB },
		];
		const result = deduplicateStreams(streams);
		expect(result).toHaveLength(1);
		expect(result[0].title).toContain("👤 99");
	});

	it("mixed: deduplicates hashed entries and keeps non-hashed", () => {
		const streams = [
			{ infoHash: hash1, title: "1080p\n👤 10 💾 5 GB", name: "T" },
			{ infoHash: hash1, title: "1080p\n👤 50 💾 5 GB", name: "T" },
			{ name: "T", title: "720p\n👤 30 💾 2 GB", url: "http://example.com" },
		];
		const result = deduplicateStreams(streams);
		expect(result).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// analyseStreams — min seeders threshold
// ---------------------------------------------------------------------------

describe("analyseStreams — min seeders threshold", () => {
	const make = (name, title, url = "magnet:?test") => ({ name, title, url });

	it("discards streams with 4 seeders (below threshold of 5)", () => {
		const raw = [make("T", "1080p WEB-DL\n👤 4 💾 6 GB ⚙ Source")];
		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(0);
		expect(debugInfo.discarded[0].reason).toBe("<5 seeders");
	});

	it("accepts streams with exactly 5 seeders", () => {
		const raw = [make("T", "1080p WEB-DL\n👤 5 💾 6 GB ⚙ Source")];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
	});

	it("discards streams with 1 seeder", () => {
		const raw = [make("T", "720p WEBRip\n👤 1 💾 2 GB ⚙ Source")];
		const { streams, debugInfo } = analyseStreams(raw);
		expect(streams).toHaveLength(0);
		expect(debugInfo.discarded[0].reason).toBe("<5 seeders");
	});

	it("keeps streams with 100 seeders", () => {
		const raw = [make("T", "4K BluRay HDR\n👤 100 💾 25 GB ⚙ Source")];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// analyseStreams — deduplication integration
// ---------------------------------------------------------------------------

describe("analyseStreams — deduplication integration", () => {
	const hash = "cccccccccccccccccccccccccccccccccccccccc";

	it("deduplicates before scoring — only best copy enters the bucket", () => {
		const raw = [
			{ infoHash: hash, name: "T", title: "1080p BluRay\n👤 50 💾 8 GB ⚙ Source" },
			{ infoHash: hash, name: "T", title: "1080p BluRay\n👤 200 💾 8 GB ⚙ Source" },
		];
		const { debugInfo } = analyseStreams(raw);
		// Only 1 stream should be analyzed (the deduped winner with 200 seeders)
		expect(debugInfo.total_streams_analyzed).toBe(2);
		expect(debugInfo.winner_1080p).toBeDefined();
		expect(debugInfo.winner_1080p.seeders).toBe(200);
	});

	it("different hashes in same quality — highest score wins bucket", () => {
		const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const raw = [
			{ infoHash: hashA, name: "T", title: "1080p WEB-DL\n👤 50 💾 5 GB ⚙ Source" },
			{ infoHash: hashB, name: "T", title: "1080p BluRay Atmos\n👤 300 💾 10 GB ⚙ Source" },
		];
		const { debugInfo } = analyseStreams(raw);
		expect(debugInfo.winner_1080p.seeders).toBe(300);
	});
});

// ---------------------------------------------------------------------------
// handleRequest — stale-while-revalidate
// ---------------------------------------------------------------------------

describe("handleRequest — stale-while-revalidate", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns cached response and triggers background revalidation when stale", async () => {
		const staleTimestamp = String(Math.floor(Date.now() / 1000) - 30000); // 30000s ago
		const cachedBody = JSON.stringify({ streams: [{ name: "⚡ 1080p | WEB-DL", url: "magnet:?old" }] });
		const cachedResponse = new Response(cachedBody, {
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"X-Cached-At": staleTimestamp,
				"X-Soft-TTL": "28800",
				"Cache-Control": "public, max-age=115200",
			},
		});

		const putFn = vi.fn();
		const cacheMock = { match: vi.fn().mockResolvedValue(cachedResponse), put: putFn };
		vi.stubGlobal("caches", { default: cacheMock });

		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ streams: [{ name: "T", title: "1080p WEB-DL\n👤 100 💾 6 GB", url: "magnet:?new" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const waitUntilFns = [];
		const ctx = { waitUntil: (p) => waitUntilFns.push(p) };

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		const res = await handleRequest(req, ctx);

		// Should return the stale cached response immediately
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams[0].url).toBe("magnet:?old");

		// Background revalidation should have been triggered
		expect(waitUntilFns.length).toBe(1);
		await waitUntilFns[0]; // await the revalidation promise
		expect(fetchSpy).toHaveBeenCalled();
		expect(putFn).toHaveBeenCalled();
	});

	it("SWR does NOT overwrite cache when Torrentio returns empty (429/failure)", async () => {
		const staleTimestamp = String(Math.floor(Date.now() / 1000) - 30000);
		const cachedBody = JSON.stringify({ streams: [{ name: "⚡ 1080p", url: "magnet:?good" }] });
		const cachedResponse = new Response(cachedBody, {
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"X-Cached-At": staleTimestamp,
				"X-Soft-TTL": "28800",
				"Cache-Control": "public, max-age=115200",
			},
		});

		const putFn = vi.fn();
		const cacheMock = { match: vi.fn().mockResolvedValue(cachedResponse), put: putFn };
		vi.stubGlobal("caches", { default: cacheMock });

		const fetchSpy = vi.fn().mockResolvedValue(
			new Response("Internal Server Error", { status: 500 }),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const waitUntilFns = [];
		const ctx = { waitUntil: (p) => waitUntilFns.push(p) };

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		const res = await handleRequest(req, ctx);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams[0].url).toBe("magnet:?good");

		expect(waitUntilFns.length).toBe(1);
		await waitUntilFns[0];
		expect(fetchSpy).toHaveBeenCalled();
		expect(putFn).not.toHaveBeenCalled();
	});

	it("returns cached response WITHOUT revalidation when still fresh", async () => {
		const freshTimestamp = String(Math.floor(Date.now() / 1000) - 100); // 100s ago (fresh)
		const cachedBody = JSON.stringify({ streams: [{ name: "⚡ 4K | BluRay", url: "magnet:?fresh" }] });
		const cachedResponse = new Response(cachedBody, {
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"X-Cached-At": freshTimestamp,
				"X-Soft-TTL": "28800",
				"Cache-Control": "public, max-age=115200",
			},
		});

		const cacheMock = { match: vi.fn().mockResolvedValue(cachedResponse), put: vi.fn() };
		vi.stubGlobal("caches", { default: cacheMock });

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const waitUntilFns = [];
		const ctx = { waitUntil: (p) => waitUntilFns.push(p) };

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		const res = await handleRequest(req, ctx);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams[0].url).toBe("magnet:?fresh");

		// Should NOT trigger background revalidation
		expect(waitUntilFns.length).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// enrichMagnet
// ---------------------------------------------------------------------------

describe("enrichMagnet", () => {
	it("appends public trackers to a bare magnet link", () => {
		const magnet = "magnet:?xt=urn:btih:abc123&dn=Movie";
		const result = enrichMagnet(magnet);
		expect(result).toContain("&tr=");
		expect(result).toContain("tracker.opentrackr.org");
		expect(result).toContain("open.stealth.si");
		expect(result).toContain("tracker.torrent.eu.org");
	});

	it("does not duplicate trackers already present in the magnet", () => {
		const magnet = "magnet:?xt=urn:btih:abc123&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce";
		const result = enrichMagnet(magnet);
		// opentrackr should appear only once
		const count = (result.match(/opentrackr/g) || []).length;
		expect(count).toBe(1);
		// but others should be added
		expect(result).toContain("open.stealth.si");
	});

	it("returns non-magnet URLs unchanged", () => {
		const url = "http://example.com/file.mkv";
		expect(enrichMagnet(url)).toBe(url);
	});

	it("returns undefined/null/empty unchanged", () => {
		expect(enrichMagnet(undefined)).toBeUndefined();
		expect(enrichMagnet(null)).toBeNull();
		expect(enrichMagnet("")).toBe("");
	});

	it("handles magnet with existing trackers (unencoded) without duplicating", () => {
		const magnet = "magnet:?xt=urn:btih:abc123&tr=udp://open.stealth.si:80/announce";
		const result = enrichMagnet(magnet);
		const count = (result.match(/open\.stealth\.si/g) || []).length;
		expect(count).toBe(1);
	});
});

describe("analyseStreams — tracker enrichment integration", () => {
	it("enriches winning stream magnet URLs with public trackers", () => {
		const raw = [
			{
				name: "T",
				title: "1080p BluRay x265\n👤 200 💾 8 GB ⚙ Source",
				url: "magnet:?xt=urn:btih:aabbccdd11223344556677889900aabbccddeeff&dn=Movie",
			},
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].url).toContain("&tr=");
		expect(streams[0].url).toContain("tracker.opentrackr.org");
	});

	it("does not modify non-magnet stream URLs", () => {
		const raw = [
			{
				name: "T",
				title: "1080p WEB-DL\n👤 100 💾 5 GB ⚙ Source",
				url: "http://example.com/stream.mkv",
			},
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].url).toBe("http://example.com/stream.mkv");
	});

	it("adds sources array to infoHash-only streams (no url, no sources)", () => {
		const raw = [
			{
				name: "T",
				title: "4K BluRay HDR\n👤 200 💾 25 GB ⚙ Source",
				infoHash: "0e78b0777e8ad05581de003530f98f9ecb33be2e",
				fileIdx: 0,
			},
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].sources).toBeDefined();
		expect(streams[0].sources[0]).toBe("dht:0e78b0777e8ad05581de003530f98f9ecb33be2e");
		expect(streams[0].sources.some((s) => s.includes("tracker.opentrackr.org"))).toBe(true);
		expect(streams[0].sources.some((s) => s.includes("open.stealth.si"))).toBe(true);
		// Original fields preserved
		expect(streams[0].infoHash).toBe("0e78b0777e8ad05581de003530f98f9ecb33be2e");
		expect(streams[0].fileIdx).toBe(0);
	});

	it("does NOT overwrite existing sources array", () => {
		const existingSources = [
			"tracker:udp://existing-tracker.org:6969/announce",
			"dht:92406642886c2e706b7af436f742e5e3cd2ab595",
		];
		const raw = [
			{
				name: "T",
				title: "720p BDRip\n👤 50 💾 5 GB ⚙ Source",
				infoHash: "92406642886c2e706b7af436f742e5e3cd2ab595",
				sources: existingSources,
				fileIdx: 0,
			},
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].sources).toEqual(existingSources);
	});

	it("does NOT add sources when stream has url (even with infoHash)", () => {
		const raw = [
			{
				name: "T",
				title: "1080p WEB-DL\n👤 80 💾 6 GB ⚙ Source",
				url: "magnet:?xt=urn:btih:aabbccdd11223344556677889900aabbccddeeff&dn=Test",
				infoHash: "aabbccdd11223344556677889900aabbccddeeff",
			},
		];
		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		// url should be enriched (magnet trackers appended)
		expect(streams[0].url).toContain("&tr=");
		// sources should NOT be added (url branch handles enrichment)
		expect(streams[0].sources).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// handleRequest — manifest
// ---------------------------------------------------------------------------

describe("handleRequest — manifest", () => {
	it("GET /manifest.json returns manifest with CORS header", async () => {
		const req = new Request("http://worker.test/manifest.json");
		const res = await handleRequest(req);

		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

		const body = await res.json();
		expect(body.id).toBe(MANIFEST.id);
		expect(body.version).toBe(MANIFEST.version);
		expect(body.name).toBe("StreamPeak");
		expect(body.resources).toContain("stream");
		expect(body.logo).toBeDefined();
		expect(body.logo).toContain("streampeak.png");
	});
});

// ---------------------------------------------------------------------------
// handleRequest — CORS pre-flight
// ---------------------------------------------------------------------------

describe("handleRequest — CORS pre-flight", () => {
	it("OPTIONS returns 204 with CORS headers", async () => {
		const req = new Request("http://worker.test/manifest.json", {
			method: "OPTIONS",
		});
		const res = await handleRequest(req);
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

// ---------------------------------------------------------------------------
// handleRequest — root redirect
// ---------------------------------------------------------------------------

describe("handleRequest — root redirect", () => {
	it("GET / redirects to /manifest.json", async () => {
		const req = new Request("http://worker.test/");
		const res = await handleRequest(req);
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/manifest.json");
	});
});

// ---------------------------------------------------------------------------
// handleRequest — stream endpoint
// ---------------------------------------------------------------------------

describe("handleRequest — stream endpoint", () => {
	const mockStreams = [
		{
			name: "Torrentio",
			title: "4K BluRay HDR x265 Atmos\n👤 342 💾 45 GB ⚙ YTS",
			url: "magnet:?test",
		},
		{
			name: "Torrentio",
			title: "1080p WEB-DL DD+\n👤 891 💾 8 GB ⚙ YTS",
			url: "magnet:?test2",
		},
	];

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: mockStreams }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("GET /stream/movie/:id.json returns ⚡ labelled streams", async () => {
		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		const res = await handleRequest(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.streams)).toBe(true);
		expect(body.streams[0].name).toMatch(/^⚡ 4K/);
		expect(body.streams[1].name).toMatch(/^⚡ 1080p/);
	});

	it("GET /stream/series/:id.json works with episode id", async () => {
		const req = new Request(
			"http://worker.test/stream/series/tt1234567:1:2.json",
		);
		const res = await handleRequest(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.streams)).toBe(true);
	});

	it("GET /stream/series/:id.json works with percent-encoded colons", async () => {
		const req = new Request(
			"http://worker.test/stream/series/tt1234567%3A1%3A2.json",
		);
		const res = await handleRequest(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.streams)).toBe(true);
		expect(body.streams.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// handleRequest — caching
// ---------------------------------------------------------------------------

describe("handleRequest — caching", () => {
	const mockStreams = [
		{ name: "T", title: "4K BluRay x265 Atmos\n👤 400 💾 50 GB ⚙ S", url: "magnet:?a" },
		{ name: "T", title: "1080p WEB-DL x265\n👤 300 💾 6 GB ⚙ S", url: "magnet:?b" },
		{ name: "T", title: "720p WEBRip\n👤 200 💾 2 GB ⚙ S", url: "magnet:?c" },
	];
	const mockFetchFn = () =>
		new Response(JSON.stringify({ streams: mockStreams }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	const noCacheMock = {
		match: vi.fn().mockResolvedValue(undefined),
		put: vi.fn().mockResolvedValue(undefined),
	};

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn().mockImplementation(mockFetchFn));
		vi.stubGlobal("caches", { default: noCacheMock });
		noCacheMock.match.mockClear();
		noCacheMock.put.mockClear();
	});

	afterEach(() => vi.unstubAllGlobals());

	it("movie stream response has Cache-Control max-age=115200 (softTtl 28800 × 4)", async () => {
		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		const res = await handleRequest(req);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=115200");
	});

	it("series stream response has Cache-Control max-age=115200", async () => {
		const req = new Request("http://worker.test/stream/series/tt0903747:1:1.json");
		const res = await handleRequest(req);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=115200");
	});

	it("returns cached response when cache hits and does not call Torrentio", async () => {
		const freshTimestamp = String(Math.floor(Date.now() / 1000) - 100);
		const cachedBody = JSON.stringify({ streams: [{ name: "cached", title: "cached", url: "m" }] });
		const cachedResponse = new Response(cachedBody, {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"X-Cached-At": freshTimestamp,
				"X-Soft-TTL": "28800",
			},
		});
		const hitCacheMock = {
			match: vi.fn().mockResolvedValue(cachedResponse),
			put: vi.fn().mockResolvedValue(undefined),
		};
		vi.stubGlobal("caches", { default: hitCacheMock });
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		const res = await handleRequest(req);
		const body = await res.json();

		expect(hitCacheMock.match).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(body.streams[0].name).toBe("cached");
	});

	it("stores response in cache on miss", async () => {
		const ctx = { waitUntil: vi.fn((p) => p) };
		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		await handleRequest(req, ctx);

		expect(noCacheMock.match).toHaveBeenCalledOnce();
		expect(ctx.waitUntil).toHaveBeenCalledOnce();
		expect(noCacheMock.put).toHaveBeenCalledOnce();
	});

	it("uses 3h soft TTL (max-age=43200) when Torrentio returns empty (failure/429)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		const res = await handleRequest(req);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=43200");
		expect(res.headers.get("X-Soft-TTL")).toBe("10800");
	});

	it("does NOT cache empty results on cold miss (Torrentio failed)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		const ctx = { waitUntil: vi.fn((p) => p) };
		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		await handleRequest(req, ctx);
		expect(ctx.waitUntil).not.toHaveBeenCalled();
		expect(noCacheMock.put).not.toHaveBeenCalled();
	});

	it("uses 10-min soft TTL (max-age=2400) when fewer than 2 streams (new release)", async () => {
		const sparse = [
			{ name: "T", title: "1080p WEB-DL\n👤 50 💾 6 GB ⚙ S", url: "magnet:?a" },
		];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: sparse }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		const req = new Request("http://worker.test/stream/movie/tt0468569.json");
		const res = await handleRequest(req);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=2400");
		expect(res.headers.get("X-Soft-TTL")).toBe("600");
	});
});

// ---------------------------------------------------------------------------
// handleRequest — security & defensive fixes
// ---------------------------------------------------------------------------

describe("handleRequest — id validation", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("rejects invalid id (no tt prefix) and returns empty streams without calling Torrentio", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() } });

		const req = new Request("http://worker.test/stream/movie/INVALID_ID.json");
		const res = await handleRequest(req);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.streams).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("accepts valid movie id (tt1234567)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() } });

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
	});

	it("accepts valid series id (tt1234567:2:5)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() } });

		const req = new Request("http://worker.test/stream/series/tt1234567:2:5.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
	});
});

describe("fetchTorrentioStreams — non-JSON guard", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns [] when Torrentio responds with HTML (text/html)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response("<html>Error</html>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
			),
		);
		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(result).toEqual([]);
	});

	it("returns streams when Torrentio responds with application/json", async () => {
		const streams = [{ name: "T", title: "1080p WEB-DL\n👤 100 💾 5 GB", url: "magnet:?x" }];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams }), {
					status: 200,
					headers: { "content-type": "application/json; charset=utf-8" },
				}),
			),
		);
		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(result).toHaveLength(1);
	});
});

describe("fetchTorrentioStreams — fallback to secondary", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("falls back to secondary when primary returns 500", async () => {
		const streams = [{ name: "T", title: "1080p\n👤 50 💾 5 GB", url: "magnet:?x" }];
		const fetchSpy = vi.fn()
			.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ streams }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0][0]).toContain("withoutthefuss");
		expect(fetchSpy.mock.calls[1][0]).toContain("strem.fun");
		expect(result).toHaveLength(1);
	});

	it("falls back to secondary when primary throws (timeout/network error)", async () => {
		const streams = [{ name: "T", title: "720p\n👤 30 💾 2 GB", url: "magnet:?y" }];
		const fetchSpy = vi.fn()
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ streams }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result).toHaveLength(1);
	});

	it("falls back to secondary when primary returns non-JSON", async () => {
		const streams = [{ name: "T", title: "1080p\n👤 100 💾 8 GB", url: "magnet:?z" }];
		const fetchSpy = vi.fn()
			.mockResolvedValueOnce(
				new Response("<html>Blocked</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ streams }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result).toHaveLength(1);
	});

	it("returns [] when both primary and secondary fail", async () => {
		const fetchSpy = vi.fn().mockRejectedValue(new Error("Network error"));
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result).toEqual([]);
	});

	it("does NOT try fallback when primary succeeds", async () => {
		const streams = [{ name: "T", title: "4K\n👤 200 💾 20 GB", url: "magnet:?ok" }];
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ streams }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result).toHaveLength(1);
	});

	it("does NOT add fallback if torrentioBase is already the fallback URL", async () => {
		const fetchSpy = vi.fn().mockRejectedValue(new Error("fail"));
		vi.stubGlobal("fetch", fetchSpy);

		const result = await fetchTorrentioStreams("movie", "tt1234567", "https://torrentio.strem.fun");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual([]);
	});
});

describe("handleRequest — debug endpoint auth", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ streams: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("returns 403 when DEBUG_KEY is set and ?key is missing", async () => {
		const req = new Request("http://worker.test/debug/movie/tt0371746");
		const res = await handleRequest(req, undefined, { DEBUG_KEY: "secret123" });
		expect(res.status).toBe(403);
	});

	it("returns 403 when DEBUG_KEY is set and ?key is wrong", async () => {
		const req = new Request("http://worker.test/debug/movie/tt0371746?key=wrong");
		const res = await handleRequest(req, undefined, { DEBUG_KEY: "secret123" });
		expect(res.status).toBe(403);
	});

	it("returns 200 when DEBUG_KEY matches ?key", async () => {
		const req = new Request("http://worker.test/debug/movie/tt0371746?key=secret123");
		const res = await handleRequest(req, undefined, { DEBUG_KEY: "secret123" });
		expect(res.status).toBe(200);
	});

	it("returns 200 when DEBUG_KEY is not set (open access)", async () => {
		const req = new Request("http://worker.test/debug/movie/tt0371746");
		const res = await handleRequest(req, undefined, {});
		expect(res.status).toBe(200);
	});
});

describe("handleRequest — TORRENTIO_URL env override", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("uses TORRENTIO_DEFAULT when env.TORRENTIO_URL is not set", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ streams: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() } });

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		await handleRequest(req, undefined, {});
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining(TORRENTIO_DEFAULT),
			expect.any(Object),
		);
	});

	it("uses env.TORRENTIO_URL when set", async () => {
		const customBase = "https://my-custom-torrentio.example.com";
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ streams: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() } });

		const req = new Request("http://worker.test/stream/movie/tt1234567.json");
		await handleRequest(req, undefined, { TORRENTIO_URL: customBase });
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining(customBase),
			expect.any(Object),
		);
	});
});

// ---------------------------------------------------------------------------
// handleRequest — debug endpoint
// ---------------------------------------------------------------------------

describe("handleRequest — debug endpoint", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						streams: [
							{
								name: "Torrentio",
								title: "4K BluRay HDR\n👤 342 💾 45 GB ⚙ YTS",
								url: "magnet:?test",
							},
							{
								name: "Torrentio",
								title: "1080p CAM\n👤 500 💾 1 GB ⚙ Source",
								url: "magnet:?cam",
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("GET /debug/movie/:id returns scoring breakdown", async () => {
		const req = new Request("http://worker.test/debug/movie/tt0371746");
		const res = await handleRequest(req);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.winner_4k).toBeDefined();
		expect(body.winner_4k.breakdown).toBeDefined();
		expect(body.discarded).toBeInstanceOf(Array);
		expect(body.discarded[0].reason).toBe("CAM");
		expect(body.total_streams_analyzed).toBe(2);
	});

	it("GET /debug/series/:id works", async () => {
		const req = new Request(
			"http://worker.test/debug/series/tt1234567:1:1",
		);
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.total_streams_analyzed).toBe("number");
	});
});

// ---------------------------------------------------------------------------
// handleRequest — Torrentio error fallback
// ---------------------------------------------------------------------------

describe("handleRequest — Torrentio error fallback", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Network error")),
		);
	});

	afterEach(() => vi.unstubAllGlobals());

	it("returns empty streams array when Torrentio returns non-200", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 })),
		);
		const req = new Request("http://worker.test/stream/movie/tt9999999.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams).toEqual([]);
	});

	it("returns empty streams array when Torrentio is unreachable", async () => {
		const req = new Request("http://worker.test/stream/movie/tt9999999.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams).toEqual([]);
	});

	it("debug endpoint returns empty analysis when Torrentio is unreachable", async () => {
		const req = new Request("http://worker.test/debug/movie/tt9999999");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.total_streams_analyzed).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// handleRequest — 404
// ---------------------------------------------------------------------------

describe("handleRequest — 404", () => {
	it("unknown paths return 404", async () => {
		const req = new Request("http://worker.test/unknown/path");
		const res = await handleRequest(req);
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Integration — Worker default export
// ---------------------------------------------------------------------------

describe("Worker default export", () => {
	it("serves manifest via worker.fetch()", async () => {
		const req = new Request("http://worker.test/manifest.json");
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(MANIFEST.id);
	});
});
