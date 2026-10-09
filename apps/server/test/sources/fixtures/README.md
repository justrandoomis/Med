# Test fixtures (sources upload tests)

TEST FIXTURE files — synthetic, contain only the line "TEST FIXTURE - encrypted pdf test".

| file | how it was made | used for |
|---|---|---|
| `password_protected.pdf` | LibreOffice 24.2 `--convert-to 'pdf:writer_pdf_Export:{"EncryptFile":…,"DocumentOpenPassword":"secret"}'` | must be rejected (needs a password to open) |
| `owner_restricted.pdf` | LibreOffice 24.2 `… {"RestrictPermissions":…,"PermissionPassword":"owner"}` (no open password) | readable → accepted, with a note |
