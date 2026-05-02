# Best Stream Selector

A Stremio addon that fetches every available stream from [Torrentio](https://torrentio.strem.fun), runs each one through a multi-dimensional scoring engine, and returns **only the single best 4K, 1080p, and 720p stream** — evaluated by resolution, release type, HDR, audio codec, encoding, seeder count, file size sanity, and release group.

Runs on **Cloudflare Workers** — zero servers, zero cold starts, globally distributed.

---

## Important: Uninstall Torrentio First

> **This addon replaces Torrentio — do not run both at the same time.**

Best Stream Selector fetches streams from Torrentio *internally* and returns only the winners. If you also have Torrentio installed in Stremio, you will see **duplicate results**: the raw 50+ Torrentio streams *plus* the 3 curated streams from this addon, which creates clutter and defeats the purpose.

**Steps before installing:**

1. Open Stremio → Settings → Addons
2. Find Torrentio and click **Uninstall**
3. Install Best Stream Selector (instructions below)

You get the same content — with none of the noise.

---

## What It Does

1. Stremio requests streams for a movie or episode.
2. The Worker fetches all available streams from Torrentio's public API.
3. Every stream is **scored across 8 dimensions** (see Scoring System below).
4. CAM, HDCAM, TeleSync, and PDVD recordings receive a -99,999 penalty and are **always discarded**.
5. Remaining streams are grouped into **4K / 1080p / 720p** quality buckets.
6. The **highest-scoring stream per bucket** is returned — up to 3 streams total.
7. If a bucket has no qualifying streams, it is skipped entirely.

### Example Stream Labels

```
⚡ 4K HDR10+ | BluRay Atmos | 342 seeds | 45.2 GB
⚡ 1080p | WEB-DL DD+ | 891 seeds | 8.7 GB
⚡ 720p | WEBRip AAC | 234 seeds | 2.1 GB
```

Only detected attributes are shown — no HDR label if none was found, no audio label if none was detected.

---

## Installing in Stremio

### Production (after deploying to Cloudflare)

1. Deploy the addon (see Deploying to Cloudflare below) to get your Worker URL:
   ```
   https://stremio-best-stream.<your-subdomain>.workers.dev
   ```
2. In Stremio: **Settings → Addons → Community Addons**
3. Paste the manifest URL into the install box:
   ```
   https://stremio-best-stream.<your-subdomain>.workers.dev/manifest.json
   ```
4. Click **Install**.

### Local Development

While running `npm run dev`, paste this into Stremio:

```
http://localhost:8787/manifest.json
```

> Stremio requires HTTPS for production addons. Local `http://` only works when Stremio runs on the same machine.

---

## Running Locally

**Prerequisites:** Node.js 18+, a Cloudflare account (free tier)

```bash
# Install dependencies
npm install

# Start local dev server (hot-reload on save)
npm run dev
```

The Worker runs at `http://localhost:8787`. Test it:

```bash
# Manifest
curl http://localhost:8787/manifest.json

# Best streams for a movie (The Dark Knight)
curl http://localhost:8787/stream/movie/tt0468569.json

# Best streams for a series episode (Breaking Bad S01E01)
curl http://localhost:8787/stream/series/tt0903747:1:1.json

# Full scoring breakdown (debug endpoint)
curl http://localhost:8787/debug/movie/tt0468569
```

### Running Tests

```bash
npm test
```

---

## Deploying to Cloudflare

```bash
# Authenticate once (opens browser)
npx wrangler login

# Deploy
npm run deploy
```

After a successful deploy, Wrangler prints:

```
Published stremio-best-stream (xx ms)
  https://stremio-best-stream.<your-subdomain>.workers.dev
```

---

## Adding a Logo

The manifest currently uses a placeholder image. To set your own:

1. Go to [imgur.com](https://imgur.com) and upload a square PNG (256x256 px recommended).
2. Right-click the image and copy the direct `.png` URL, e.g. `https://i.imgur.com/AbCdEfG.png`
3. In `src/index.js`, update the `MANIFEST` object:
   ```js
   logo: "https://i.imgur.com/AbCdEfG.png",
   background: "https://i.imgur.com/AbCdEfG.png",
   ```
4. Redeploy: `npm run deploy`

---

## Submitting to the Stremio Addon Collection

1. Fork [stremio-addon-collection](https://github.com/Stremio/stremio-addon-collection) on GitHub.
2. Add an entry to `addons.json`:
   ```json
   {
     "manifest": "https://stremio-best-stream.<your-subdomain>.workers.dev/manifest.json",
     "transportUrl": "https://stremio-best-stream.<your-subdomain>.workers.dev/manifest.json"
   }
   ```
3. Open a Pull Request — the Stremio team reviews and merges.

---

## Scoring System

Every stream receives a **total score** that is the sum of 8 independent components. The stream with the highest total wins its quality bucket.

### 1. Resolution (most important)

| Detected | Points |
|----------|--------|
| 2160p / 4K / UHD | +1000 |
| 1080p | +800 |
| 720p | +600 |
| 480p / SD | +100 |
| Unknown | 0 |

### 2. Release Type

| Detected | Points |
|----------|--------|
| BluRay / BDRip / BDRemux | +400 |
| WEB-DL | +300 |
| WEBRip | +200 |
| HDTV | +100 |
| DVDRip | +50 |
| CAM / HDCAM / TeleSync / PDVD | **-99,999 — always discarded** |

### 3. HDR

| Detected | Points |
|----------|--------|
| HDR10+ | +150 |
| Dolby Vision / DV | +120 |
| HDR | +100 |
| None | 0 |

### 4. Audio

| Detected | Points |
|----------|--------|
| Atmos / TrueHD Atmos | +100 |
| DTS-X / DTS-HD MA | +90 |
| TrueHD | +80 |
| DTS-HD / DTS | +70 |
| DD+ / EAC3 / Dolby Digital Plus | +60 |
| Dolby Digital / DD / AC3 / 5.1 | +40 |
| AAC | +20 |
| Unknown / MP3 | 0 |

### 5. Encoding

| Detected | Points |
|----------|--------|
| x265 / HEVC / H.265 | +30 |
| AV1 | +25 |
| x264 / H.264 | +10 |
| Unknown | 0 |

### 6. Seeder Count (tiebreaker)

| Seeders | Points |
|---------|--------|
| 1000+ | +50 |
| 500-999 | +40 |
| 200-499 | +30 |
| 100-199 | +20 |
| 50-99 | +10 |
| 10-49 | +5 |
| 1-9 | **-200** (unreliable) |
| 0 | **-500** (effectively discarded) |

### 7. File Size Sanity Check

A stream claiming high resolution but with a suspiciously small file is almost certainly mislabelled.

| Condition | Penalty |
|-----------|---------|
| Claims 4K but under 4 GB | -500 |
| Claims 1080p but under 500 MB | -500 |
| Claims 720p but under 200 MB | -200 |
| Size not detected | no penalty |

### 8. Known Quality Release Groups (bonus)

If the stream name or title contains any of these group tags, it receives **+50 points**:

`YTS` `YIFY` `SPARKS` `FGT` `ROVERS` `GECKOS` `DEFLATE` `CMRG` `NTb` `FLUX` `LAZY` `TEPES` `MZABI` `TIGOLE`

---

## Debug Endpoint

The `/debug/:type/:id` endpoint returns the full per-stream scoring breakdown. Use it to see exactly why a stream won or was discarded, without opening Stremio.

```
GET /debug/movie/tt0371746
GET /debug/series/tt0903747:1:1
```

Example response:

```json
{
  "winner_4k": {
    "name": "⚡ 4K HDR | BluRay Atmos | 342 seeds | 45.2 GB",
    "score": 1680,
    "breakdown": {
      "resolution": 1000,
      "releaseType": 400,
      "hdr": 100,
      "audio": 100,
      "encoding": 30,
      "seeders": 30,
      "sizePenalty": 0,
      "groupBonus": 0
    },
    "labels": {
      "releaseType": "BluRay",
      "hdr": "HDR",
      "audio": "Atmos",
      "encoding": "x265"
    },
    "seeders": 342,
    "sizeMB": 46285
  },
  "winner_1080p": { "..." : "..." },
  "discarded": [
    { "name": "Torrentio", "title": "1080p CAM", "reason": "CAM", "score": -98300 }
  ],
  "total_streams_analyzed": 47
}
```

---

## Technical Architecture

```
Stremio client
    |  GET /stream/movie/tt0468569.json
    v
Cloudflare Worker  (src/index.js)
    |
    +-- handleRequest (router)
    |       GET /manifest.json         -> serve MANIFEST constant
    |       GET /stream/:type/:id.json -> fetchTorrentioStreams -> selectBestStreams
    |       GET /debug/:type/:id       -> fetchTorrentioStreams -> analyseStreams (full breakdown)
    |       OPTIONS *                  -> CORS pre-flight 204
    |       GET /                      -> 302 -> /manifest.json
    |
    +-- fetchTorrentioStreams
    |       fetch() from torrentio.strem.fun with 10 s timeout
    |       returns [] on any network error or non-200 response
    |
    +-- analyseStreams
            scoreStream()     -> 8-component score per stream
            detectQuality()   -> bucket assignment (4k / 1080p / 720p)
            extractSeeders()  -> regex on emoji N or Seeds: N
            extractSizeMB()   -> regex on floppy-disk emoji N GB/MB
            buildStreamName() -> "⚡ 4K HDR | BluRay Atmos | 342 seeds | 45.2 GB"
```

### Why no SDK?

`stremio-addon-sdk` targets Node.js and depends on `express` and Node built-ins. Cloudflare Workers run a Service Worker API — no Node.js runtime. The 30-line router here does exactly what the SDK would do, with zero extra dependencies and full Workers compatibility.

---

## Future Improvement Ideas

- **Real-Debrid / AllDebrid support** — pass a debrid token to Torrentio to retrieve instant HTTP links; prioritise cached links above all else.
- **User configuration page** — let users tune minimum seeder threshold, disable certain quality tiers, or force a preferred source type.
- **Workers KV caching** — cache Torrentio responses per `(type, id)` for 5-15 minutes to cut latency and upstream load.
- **Multiple source aggregation** — pull from Knightcrawler, Jackett, or other public addons before scoring.
- **Sub-tier separation** — treat 4K HDR and 4K SDR as separate buckets, or 1080p Remux vs 1080p encode.
- **File-size cap option** — let power users cap max file size to avoid 70 GB Remux picks.
- **Workers Analytics Engine** — instrument which quality tier wins most often for observability.
