# Work paused — 2026-10-22 (owner's request)

The owner asked to stop and resume later. This note says exactly where the work stands so the next session can
continue without redoing anything.

## Where it stopped

Round «Phase 1 completion» (closing the 50 open-but-buildable Must rows and exit criterion X8 (c)/(d) listed in
`PHASE1_REPORT.md` §5.3), run as three tracks, each built and then adversarially reviewed:

| step | state |
|---|---|
| C1 — server limits, security, AI consent, per-space backup (rows 21.x, 18.17) | built and reviewed |
| C2 — spaces & lectures (19H.3 / X8 (c), 2.2, 2.3, 3.6, 3.11, 3.18, 4.5, 4.18, 11.27, 18.3–18.5, 18.18, 19H.1, 19I.2, 19I.5) | built and reviewed |
| C3 — web / UX / E2E (1.16, 1.24, 1.38, 4.7, 14.11, 19J.1, 19L.4, 20.1, 20.3, 20.5, 20.19, 21.46) | built; its review fixed defects and was **in its final gates/docs step** when stopped |
| GATE-1 re-run + its review | **not started** |

The working tree at the pause is committed as an **unverified WIP snapshot** (see `git log`). Nothing after the last
release commit (`40134f6`, release R1-c) has been through a full final verification.

## How to resume

1. Finish the C3 review's last step: run the full gates (`npm run typecheck`, `npm run lint`, `npm test`,
   `npm run build`, the E2E specs C3 touched plus `e2e/smoke.spec.ts`) and update the docs / matrix rows for C3.
2. Run the GATE-1 re-run (BUILD_PLAN §3.9): every suite, the full E2E on phone and desktop, the performance gate
   against R1-c, every Phase 1 exit criterion (X8 all parts, X9, AC-01a, AC-01b, Scenarios 2 and 4, moderation),
   the owner migration from a realistic R1-a data directory, the 123-row Must re-check; update `PHASE1_REPORT.md`.
3. An independent review of the gate; then commit the round with its verified numbers.

Do not resume an interrupted workflow run with its run id when it ran parallel chains: cached steps can re-run.
Start a new run that executes only the steps above.

## Waiting on the owner

* May a `release` branch receive verified versions only, for Render to deploy? Until then, do **not** deploy the
  latest commit of the working branch (it may be an unverified snapshot); deploy release commit `40134f6` or ask.
* May CI run on GitHub runners (uses the account's Actions minutes)? Needed for rows 23.2 and 23.3.
* `PHASE1_REPORT.md` §13: accept the «Not run (reason)» list for device/account rows; may a Subject Moderator
  approve join requests?
* For an Android APK on BOOX: deploy first; a wrapper APK pointing at the deployed URL can then be built. The native
  Android app (S Pen / BOOX ink) is a later platform track.
