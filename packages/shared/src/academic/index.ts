// Academic OS contracts (ARCHITECTURE_DELTA §2.1 «Shared contracts», BUILD_PLAN §3.2). Re-exported from the package
// root. Each track appends its own files here ONLY in its own step 0 (P1-T2: layers, ink-codec; P1-T3: versions; …),
// so two tracks of one wave never edit the same line.
export * from './visibility';
// P1-T1 step 1: accounts, devices and the platform admin's whole-deployment views
export * from './accounts-api';
export * from './platform-api';
// P1-T1 step 2: chunked uploads, blob registry / GC, per-vault backups
export * from './files-api';
// P1-T3: lecture identity, page fingerprints, version page maps, compare, link candidates
export * from './versions';
// P1-T2: authorship layers (document keys, layer access R1–R6, layer copy, history) and ink data v2 (packed points)
export * from './layers';
export * from './ink-codec';
