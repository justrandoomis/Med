# MedLevo native shell — skeleton (Academic OS P1-T2 step 2)

ADR-0005 Part B decides to keep the PWA and add a native shell instead of rewriting the app: the same web bundle
(`apps/web/dist`) runs inside a Capacitor shell for the App Store and Google Play, and native plugins add only what
the web cannot do — first the low-latency iPad ink surface (PencilKit / Metal), then Android front-buffered ink for
S Pen and BOOX, background recording and nearby transports (ADR-0005 B.2).

This folder is the **skeleton** that Phase 1 ships (PRD §5.3, BUILD_PLAN §3.4):

| file | what it is |
|---|---|
| `capacitor.config.json` | the shell's configuration: app id `ai.medlevo.app` (placeholder until the owner registers the store accounts), web assets from `../web/dist`, `https` scheme, no remote URL, no mixed content, no web debugging in the committed config |
| `package.json` | Capacitor packages (one major). **Not an npm workspace** of the repository: `npm ci` at the root, the web build and the server never install or touch it |
| `scripts/check-native.mjs` | static checks of the config, the package and the two workflows (`node apps/native/scripts/check-native.mjs`) |
| `test/static-checks.test.mjs` | tests of those checks (`node --test apps/native/test/static-checks.test.mjs`) |
| `../../.github/workflows/native-ios.yml`, `native-android.yml` | manual-only workflows (`workflow_dispatch`): static checks on Linux, then an unsigned build (Xcode on a macOS runner / Gradle on Linux). Signed builds read the signing material from GitHub encrypted secrets **by name**; the signing and upload steps arrive with PL-1 (iPad) and PL-3 (Android) |

## What has and has not been done

* Done here: the files above, and their static checks pass in this container (see `docs/TEST_LOG.md`).
* **Not run (no macOS runner, no Xcode):** any iOS build, signature, TestFlight upload or install.
* **Not run (no Android SDK, emulator or device):** any Android build, signature, Play upload or install.
* **Not run:** `npm install` of the Capacitor packages — this container installs only the repository's workspaces.
  The package versions are checked for consistency, not resolved against the registry here.
* No native ink plugin exists yet (that is PL-2, right after Phase 1). The web canvas keeps rendering all ink.

## How a build will run (owner, from the GitHub web UI — no computer needed)

1. Create the Apple Developer and Google Play developer accounts (PRD Q19; decision points D-A and D-G).
2. Add the secrets named at the top of each workflow file (Settings → Secrets and variables → Actions).
3. Actions → «Native iOS» or «Native Android» → Run workflow. The static checks run first; the build job only
   after they pass. Without the signing secrets the job stops after an unsigned build and says why.

Device capabilities follow `docs/CAPABILITY_MATRIX.md` §27: a row moves to «tested» only with the device, OS, app
version and date recorded. Mouse or simulated input never validates pen quality.
