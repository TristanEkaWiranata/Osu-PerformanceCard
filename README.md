<div align="center">

# 🎴 BeatCard

**osu! Player Profile Card & Performance Profile Generator**

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v1.7.0-blue.svg)](public/app.js)
[![osu! API v2](https://img.shields.io/badge/osu!%20API-v2-ff66aa.svg)](https://osu.ppy.sh/docs)

*BeatCard is a web application that generates aesthetic player cards and skill performance profiles for osu! players using official osu! API v2 data.*

---

</div>

## 📌 Overview

**BeatCard** allows users to search for any osu! player by username across multiple game modes and instantly generate:
1. **Player Overview Card**: Displays player statistics, global/country rank, total PP, play count, hit accuracy, level progress, and playstyle attributes.
2. **Performance Profile**: A multi-dimensional skill breakdown derived from the player's top 20 best plays.

All skill ratings are scaled from **0.0 to 10.0** using top-5 weighted decay aggregation ($0.90^j$) and calibrated against top global players.

---

## 🎮 Supported Game Modes & Skill Models

| Mode | Ruleset | Skill Profile Dimensions | Calculation Highlights |
|:---|:---:|:---:|:---|
| **osu! Standard** | `osu` | `AIM` • `SPEED` • `ACCURACY` • `STAMINA` | Aim & Speed rating scaling, OD timing window analysis, Candidate D logarithmic note-density stamina modeling. |
| **osu!mania** | `mania` | `SPEED` • `ACCURACY` • `STAMINA` • `LN CONTROL` | Normalized miss penalty based on total playable objects, max timing ratio (300g/MAX), and Long Note ratio scaling. |
| **osu!catch** | `fruits` | `MOVEMENT` • `ACCURACY` | **Two-Skill Model**: Spatial required velocity ($v_{\text{P95}}$) & hyperdash ratio from raw `.osu` files, droplet judgment quality. |

---

## ✨ Features

- ⚡ **Official osu! API v2 Integration**: Uses client credentials OAuth for fast, reliable player lookups.
- 🎯 **Raw `.osu` Spatial Movement Analysis**: Parses beatmap hit objects for CTB spatial velocity ($v_{\text{P95}}$) with graceful fallback (`movement_confidence: "FULL" | "REDUCED"`).
- 💾 **Saved Cards Gallery**: Save favorite player cards locally to compare profiles anytime.
- 📸 **High-Resolution PNG Export**: One-click card export to PNG image powered by `html2canvas`.
- 🔗 **View Profile Link**: Instant one-click link to the player's official osu! user page for the selected game mode.
- 📜 **What's New / Changes Log Modal**: Built-in release history modal (`v1.7.0`).
- 📱 **Fluid Responsive Design**: Metropol-inspired dark aesthetic, optimized for screen widths from 320px mobile to 4K desktop.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) `>= 18.0.0`
- An **osu! OAuth Application** (Client ID & Client Secret)
  - You can create one for free under your [osu! Account Settings](https://osu.ppy.sh/home/account/edit#new-oauth-application).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/TristanEkaWiranata/Osu-PerformanceCard.git
   cd Osu-PerformanceCard
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Create a `.env` file in the project root directory (or copy `.env.example`):
   ```env
   OSU_CLIENT_ID=your_osu_client_id_here
   OSU_CLIENT_SECRET=your_osu_client_secret_here
   PORT=3000
   ```

4. **Start the server**:
   ```bash
   npm start
   ```
   Open your browser and navigate to `http://localhost:3000`.

---

## 🛠️ Project Architecture

```
BeatCard/
├── server.js               # Express server, OAuth token management, osu! API proxy & performance profile engines
├── public/
│   ├── index.html          # Main application UI layout
│   ├── style.css           # Custom CSS design system (variables, grid, modals, responsive breakpoints)
│   └── app.js              # Client-side state, API fetching, card rendering, saved cards, changelog modal
├── package.json            # Node.js dependencies and scripts
├── .env.example            # Template for environment configuration
└── README.md               # Project documentation
```

---

## 📡 API Routes

| Endpoint | Method | Description |
|:---|:---:|:---|
| `/api/user/:username/:mode` | `GET` | Fetches basic player profile statistics and user summary. |
| `/api/user/:username/:mode/performance` | `GET` | Computes derived BeatCard Performance Profile skill ratings ($0.0 - 10.0$). |

---

## 🛠️ Built With

- **Backend**: [Node.js](https://nodejs.org/), [Express](https://expressjs.com/), [node-fetch](https://www.npmjs.com/package/node-fetch), [dotenv](https://www.npmjs.com/package/dotenv)
- **Frontend**: Vanilla HTML5, Modern CSS3 (Flexbox/Grid), JavaScript (ES6+)
- **Exporting**: [html2canvas](https://html2canvas.hertzen.com/)
- **Data Source**: [osu! API v2](https://osu.ppy.sh/docs)

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

<div align="center">
  <sub>Made with ❤️ by <a href="https://github.com/TristanEkaWiranata">Tristan Eka Wiranata</a></sub>
</div>
