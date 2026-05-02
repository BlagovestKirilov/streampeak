import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
	detectQuality,
	extractSeeders,
	extractSizeMB,
	seederScore,
	scoreStream,
	buildStreamName,
	analyseStreams,
	selectBestStreams,
	handleRequest,
	MANIFEST,
} from "../src/index.js";

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
	])('detectQuality("%s") === %s', (text, expected) => {
		expect(detectQuality(text)).toBe(expected);
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
		[0, -500],
	])("seederScore(%i) === %i", (n, expected) => {
		expect(seederScore(n)).toBe(expected);
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
		expect(s.breakdown.encoding).toBe(30);
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
		expect(s.total).toBeLessThan(-99000);
	});

	it("marks TS stream as discarded", () => {
		const s = scoreStream(make("Torrentio", "720p TSRip\n👤 999 💾 1 GB ⚙ Source"));
		expect(s.discarded).toBe(true);
		expect(s.total).toBeLessThan(-99000);
	});

	it("does NOT false-positive TS inside DTS", () => {
		const s = scoreStream(make("Torrentio", "1080p BluRay DTS\n👤 300 💾 8 GB ⚙ Source"));
		expect(s.discarded).toBe(false);
		expect(s.labels.audio).toBe("DTS");
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
		expect(s.breakdown.sizePenalty).toBe(-500);
	});

	it("applies size penalty for mislabeled 1080p stream (< 500 MB)", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL\n👤 200 💾 300 MB ⚙ Source"),
		);
		expect(s.breakdown.sizePenalty).toBe(-500);
	});

	it("applies size penalty for mislabeled 720p stream (< 200 MB)", () => {
		const s = scoreStream(
			make("Torrentio", "720p WEBRip\n👤 100 💾 150 MB ⚙ Source"),
		);
		expect(s.breakdown.sizePenalty).toBe(-200);
	});

	it("does NOT apply size penalty when size is 0 (unknown)", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay\n👤 342 ⚙ Source"),
		);
		expect(s.breakdown.sizePenalty).toBe(0);
	});

	it("applies group bonus for known release groups", () => {
		const s = scoreStream(
			make("[YTS] Movie", "1080p WEB-DL\n👤 200 💾 6 GB ⚙ YTS"),
		);
		expect(s.breakdown.groupBonus).toBe(50);
	});

	it("no group bonus for unknown groups", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL\n👤 200 💾 6 GB ⚙ Source"),
		);
		expect(s.breakdown.groupBonus).toBe(0);
	});

	it("heavily penalises 0-seeder streams", () => {
		const s = scoreStream(
			make("Torrentio", "1080p BluRay\n👤 0 💾 8 GB ⚙ Source"),
		);
		expect(s.breakdown.seeders).toBe(-500);
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

	it("detects DoVi tag as Dolby Vision", () => {
		const s = scoreStream(
			make("Torrentio", "4K BluRay DoVi\n👤 200 💾 50 GB ⚙ Source"),
		);
		expect(s.labels.hdr).toBe("DV");
		expect(s.breakdown.hdr).toBe(120);
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
		expect(s.breakdown.encoding).toBe(30);
	});

	it("detects AV1 encoding", () => {
		const s = scoreStream(
			make("Torrentio", "1080p WEB-DL AV1\n👤 300 💾 4 GB ⚙ Source"),
		);
		expect(s.labels.encoding).toBe("AV1");
		expect(s.breakdown.encoding).toBe(25);
	});
});

// ---------------------------------------------------------------------------
// buildStreamName
// ---------------------------------------------------------------------------

describe("buildStreamName", () => {
	it("builds full label for a 4K HDR BluRay Atmos stream", () => {
		const scored = {
			labels: { releaseType: "BluRay", hdr: "HDR10+", audio: "Atmos", encoding: "x265" },
			seeders: 342,
			sizeMB: 45 * 1024,
		};
		const name = buildStreamName("4k", scored);
		expect(name).toBe("⚡ 4K HDR10+ | BluRay Atmos");
	});

	it("builds label for a 1080p WEB-DL DD+ stream", () => {
		const scored = {
			labels: { releaseType: "WEB-DL", hdr: "", audio: "DD+", encoding: "x264" },
			seeders: 891,
			sizeMB: 8.7 * 1024,
		};
		const name = buildStreamName("1080p", scored);
		expect(name).toBe("⚡ 1080p | WEB-DL DD+");
	});

	it("omits HDR when not detected", () => {
		const scored = {
			labels: { releaseType: "WEBRip", hdr: "", audio: "AAC", encoding: "" },
			seeders: 234,
			sizeMB: 2.1 * 1024,
		};
		const name = buildStreamName("720p", scored);
		expect(name).toMatch(/^⚡ 720p \|/);
		expect(name).not.toMatch(/HDR/);
	});

	it("omits audio when not detected", () => {
		const scored = {
			labels: { releaseType: "WEB-DL", hdr: "", audio: "", encoding: "" },
			seeders: 100,
			sizeMB: 5 * 1024,
		};
		const name = buildStreamName("1080p", scored);
		expect(name).toBe("⚡ 1080p | WEB-DL");
	});

	it("omits size segment when sizeMB is 0", () => {
		const scored = {
			labels: { releaseType: "BluRay", hdr: "HDR", audio: "DTS", encoding: "" },
			seeders: 500,
			sizeMB: 0,
		};
		const name = buildStreamName("4k", scored);
		expect(name).toBe("⚡ 4K HDR | BluRay DTS");
	});

	it("shows quality and release type when size is sub-GB", () => {
		const scored = {
			labels: { releaseType: "WEBRip", hdr: "", audio: "", encoding: "" },
			seeders: 50,
			sizeMB: 850,
		};
		const name = buildStreamName("720p", scored);
		expect(name).toBe("⚡ 720p | WEBRip");
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

		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].name).toMatch(/BluRay/);
	});

	it("prefers high-seeder WEB-DL over low-seeder WEBRip in same bucket", () => {
		const raw = [
			make("Torrentio", "1080p WEBRip x264\n👤 17 💾 5 GB ⚙ Source"),
			make("Torrentio", "1080p WEB-DL x264\n👤 229 💾 6 GB ⚙ Source"),
		];

		const { streams } = analyseStreams(raw);
		expect(streams).toHaveLength(1);
		expect(streams[0].title).toContain("👤 229");
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

	it("preserves original stream fields (url, behaviorHints)", () => {
		const raw = [
			{
				name: "Torrentio",
				title: "4K BluRay\n👤 342 💾 45 GB ⚙ Source",
				url: "magnet:?xt=urn:btih:abc",
				behaviorHints: { notWebReady: true },
			},
		];

		const { streams } = analyseStreams(raw);
		expect(streams[0].url).toBe("magnet:?xt=urn:btih:abc");
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
		expect(body.version).toBe("1.0.0");
		expect(body.name).toBe("StreamPeak");
		expect(body.resources).toContain("stream");
		expect(body.logo).toBeDefined();
		expect(body.logo).toContain("streampeak.png");
		expect(body.idPrefixes).toEqual(["tt"]);
	});

	it("manifest response has Cache-Control header", async () => {
		const req = new Request("http://worker.test/manifest.json");
		const res = await handleRequest(req);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
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
// handleRequest — 405 Method Not Allowed
// ---------------------------------------------------------------------------

describe("handleRequest — 405", () => {
	it("POST returns 405", async () => {
		const req = new Request("http://worker.test/manifest.json", {
			method: "POST",
		});
		const res = await handleRequest(req);
		expect(res.status).toBe(405);
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
					{ status: 200 },
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
	afterEach(() => vi.unstubAllGlobals());

	it("returns empty streams array when Torrentio is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Network error")),
		);
		const req = new Request("http://worker.test/stream/movie/tt9999999.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams).toEqual([]);
	});

	it("debug endpoint returns empty analysis when Torrentio is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Network error")),
		);
		const req = new Request("http://worker.test/debug/movie/tt9999999");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.total_streams_analyzed).toBe(0);
	});

	it("returns empty streams when Torrentio returns 500", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 })),
		);
		const req = new Request("http://worker.test/stream/movie/tt9999999.json");
		const res = await handleRequest(req);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.streams).toEqual([]);
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
