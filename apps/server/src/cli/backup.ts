// Backup CLI — NOT IMPLEMENTED YET (a later track implements backup: VACUUM INTO + file store copy,
// manifest with checksums, secret.key handled as a secret). Exits with code 2 so scripts never treat
// a missing backup as success.
process.stderr.write('MedLevo backup: not implemented yet. No backup was created.\n');
process.exit(2);
