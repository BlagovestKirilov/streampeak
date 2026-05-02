<p align="center">
  <img src="assets/streampeak.png" alt="StreamPeak" width="150" />
</p>

<h1 align="center">StreamPeak</h1>

<p align="center">
  <strong>The smartest way to pick a stream in Stremio.</strong><br/>
  Built by <a href="https://github.com/BlagovestKirilov">Blagovest Kirilov</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Stremio-5B4BB5" alt="Stremio" />
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

---

## Why StreamPeak?

Every time you open a movie or episode in Stremio, Torrentio floods you with dozens of streams — different resolutions, codecs, seeders, and quality levels. **You shouldn't have to scroll through 50 results to find the best one.**

StreamPeak does the work for you. It analyzes every available stream, scores it across eight quality dimensions, and delivers **only the single best option per resolution tier** — ready to play in one click.

---

## What You Get

| Tier | Example Label |
|------|---------------|
| **4K** | ⚡ 4K HDR10+ \| BluRay Atmos |
| **1080p** | ⚡ 1080p \| WEB-DL DD+ |
| **720p** | ⚡ 720p \| WEBRip AAC |
| **480p** | ⚡ 480p \| DVDRip |

- Up to **4 streams** — one per quality tier, only the best of each
- **CAM, TeleSync, and HDCAM recordings are automatically removed** — you'll never see them
- Labels show exactly what you're getting: resolution, HDR format, source type, and audio codec
- Only detected attributes are shown — no clutter from missing metadata

---

## How It Works

1. You press play on a movie or episode in Stremio.
2. StreamPeak fetches all available streams from Torrentio behind the scenes.
3. Each stream is scored across **8 dimensions**: resolution, release type, HDR, audio codec, video encoding, seeder health, file size plausibility, and release group reputation.
4. Low-quality recordings (CAM, TS, HDCAM) are discarded automatically.
5. The highest-scoring stream in each resolution tier is returned.
6. You see clean, labelled results — pick one and watch.

---

## Installation

> **Important:** If you have Torrentio installed, **uninstall it first**. StreamPeak fetches from Torrentio internally — running both will produce duplicate results.

1. Open **Stremio** → **Settings** → **Addons**
2. Paste the addon URL into the search/install box:
   ```
   https://stremio-best-stream.<your-subdomain>.workers.dev/manifest.json
   ```
3. Click **Install**

That's it — open any movie or series and StreamPeak handles the rest.

---

## Scoring at a Glance

StreamPeak evaluates every stream across eight independent dimensions. The stream with the highest combined score wins its quality tier.

| Dimension | What It Measures | Impact |
|-----------|-----------------|--------|
| **Resolution** | 4K, 1080p, 720p, 480p | Determines the quality tier |
| **Release Type** | BluRay, WEB-DL, WEBRip, etc. | Highest weight after resolution |
| **HDR** | HDR10+, Dolby Vision, HDR | Bonus for HDR content |
| **Audio** | Atmos, DTS-HD MA, TrueHD, DD+, etc. | Rewards premium audio |
| **Encoding** | x265/HEVC, AV1, x264 | Prefers efficient codecs |
| **Seeders** | Logarithmic scale, 0–150 pts | Ensures streams are actually available |
| **File Size** | Sanity check per resolution | Penalizes suspiciously small files |
| **Release Group** | Known quality groups | Bonus for trusted uploaders |

Streams with zero seeders or CAM/TS sources are **automatically excluded** — they never appear in your results.

---

## Performance

StreamPeak runs on **Cloudflare Workers** — a globally distributed edge runtime with no cold starts. Every request is handled by the nearest data center, keeping latency minimal no matter where you are.

- **Manifest** responses are cached for 24 hours
- **Stream** responses are cached for 15 minutes
- Torrentio requests include a 10-second timeout to prevent hangs

---

## Roadmap

- **Real-Debrid / AllDebrid integration** — prioritize cached instant links
- **User preferences** — configurable quality tiers, minimum seeder thresholds
- **Multi-source aggregation** — combine streams from multiple providers before scoring
- **Sub-tier separation** — distinguish 4K HDR from 4K SDR, or 1080p Remux from 1080p encode

---

## License

MIT — free to use, modify, and distribute.
