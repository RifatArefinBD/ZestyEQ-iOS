# Zesty EQ for iOS

Zesty EQ is a Discord client with built-in Vencord and a real-time audio processing engine. Features include 5-band parametric EQ, FX rack (reverb, delay, chorus, drive, saturation), voice warfare (vacuum, sabotage, ghost, siren, beast mode, talk mode), and a soundboard.

**Supported Devices:** iPhone, iPad, iPod touch  
**Minimum iOS Version:** 14.0

---

## Download

Pre-built unsigned IPAs are available from [GitHub Releases](https://github.com/RifatArefinBD/ZestyEQ-iOS/releases).

---

## Installation Methods

### Method 1: TrollStore (Recommended) — No Expiry, No Computer

**Requirements:** iOS 14.0–16.6.1, no jailbreak needed.

1. Install [TrollStore](https://trollstore.app) on your device using your computer (one-time setup).
2. Download `ZestyEQ.unsigned.ipa` from the releases page.
3. Open the IPA in TrollStore → tap **Install**.
4. Done. App stays installed permanently, no expiry, no refreshing.

### Method 2: Sideloadly — Free Apple ID, 7-Day Expiry

**Requirements:** Windows or Mac computer, free Apple ID. No jailbreak needed.

1. Download [Sideloadly](https://sideloadly.io) on your computer.
2. Download `ZestyEQ.unsigned.ipa` from the releases page.
3. Connect your iPhone/iPad to the computer via USB.
4. Open Sideloadly, drag the IPA in, enter your Apple ID.
5. Click **Start** — the app will be installed.
6. On your device, go to **Settings → General → VPN & Device Management** and trust your profile.
7. **Important:** Apps installed this way expire after 7 days. Re-run Sideloadly to re-sign before expiry.

### Method 3: AltStore — Auto-Refresh, 7-Day Expiry

**Requirements:** Windows or Mac computer, free Apple ID. No jailbreak needed.

1. Install [AltStore](https://altstore.io) on your computer and device.
2. Download `ZestyEQ.unsigned.ipa` from the releases page.
3. Open AltStore on your device → **My Apps** → tap **+** → select the IPA.
4. Or use AltServer on your computer to install directly.
5. AltStore will auto-refresh the app in the background if your computer is on the same network.
6. Still limited to 7-day signing but less manual work than Sideloadly.

### Method 4: Jailbreak — Permanent, No Expiry

**Requirements:** Jailbroken device (check your iOS version for available jailbreaks).

1. Download `ZestyEQ.unsigned.ipa` from the releases page.
2. Extract it (rename `.ipa` to `.zip`, unzip).
3. You'll get a `Payload/` folder containing `ZestyEQ.app`.
4. Copy `ZestyEQ.app` to `/Applications/` using Filza or SSH.
5. Run `uicache` (or respring) — the app appears on the home screen.
6. Stays installed permanently, no signing needed.

---

## Building from Source (for Contributors)

### Automated Build (Codemagic)

Push a tag to trigger an automated build and GitHub Release:

```bash
git tag v1.0.0
git push --tags
```

The unsigned IPA will be published to GitHub Releases automatically.

### Local Build (requires macOS)

```bash
# Install XcodeGen
brew install xcodegen

# Generate Xcode project
xcodegen generate

# Build for simulator (unsigned)
xcodebuild \
  -project ZestyEQ.xcodeproj \
  -scheme ZestyEQ \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  clean build

# Build for device (unsigned)
xcodebuild \
  -project ZestyEQ.xcodeproj \
  -scheme ZestyEQ \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  clean build

# Create unsigned IPA
mkdir -p Payload
cp -R "Build/Products/Debug-iphoneos/ZestyEQ.app" Payload/
zip -r ZestyEQ.unsigned.ipa Payload/
```

---

## How to Set Up Releases (One-Time)

For the unsigned IPA to be automatically published to GitHub Releases when you push a tag:

1. Go to [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens).
2. Generate a token with `repo` scope.
3. Go to [Codemagic → Apps → ZestyEQ iOS → Environment variables](https://codemagic.io/apps).
4. Add variable `GITHUB_TOKEN` with your token value, check **secure**.
5. Now when you push a git tag, Codemagic will build and publish the IPA to GitHub Releases.

---

## Features

- Full Discord web experience via WKWebView
- Vencord plugin injection
- 5-band Parametric EQ with visual graph
- Preamp, Pan, Stereo Width controls
- FX Rack: Drive, Saturation, Reverb, Delay, Chorus
- Warfare: Vacuum, Sabotage, Ghost, Siren, Beast Mode, Talk Mode
- Soundboard with file upload & YouTube download
- Audio recorder (WebM/Opus)
- Desktop/Mobile user agent toggle
- Floating draggable settings panel
- Dark theme

---

## License

Same as the original Vendroid / Zesty EQ project.
