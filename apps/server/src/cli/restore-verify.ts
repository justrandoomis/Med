// Restore verification CLI — NOT IMPLEMENTED YET (a later track restores a backup into a separate
// directory and verifies database integrity, migrations, and file checksums). Exits with code 2 so a
// missing verification is never reported as a pass.
process.stderr.write('MedLevo restore:verify: not implemented yet. Nothing was verified.\n');
process.exit(2);
