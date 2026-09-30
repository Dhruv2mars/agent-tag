# Pinned T3 attachment transfer, 2026-09-30

Actor types: `automated-real` and `automated-fixture`. Build: `c681907` on `feat/t3-slack-spike`, macOS arm64, Bun `1.3.13`, T3 Code `0.0.42` at source commit `719a76ca1dbf5490f1aa33ffb9966301e02be9a9`. No provider turn or human Slack file exercise is part of this run.

The adapter now validates known image/file metadata, uploads bytes through `attachments.createUploadUrl` plus the signed HTTP upload, downloads through `assets.createUrl`, and deletes pending attachments through `attachments.delete`. Images are limited to GIF, JPEG, PNG, and WebP at 10 MiB; generic files are limited to 50 MiB; turns retain T3's eight-attachment limit. The limits and methods were read from the exact pinned contracts and server routes, not the newer local T3 checkout.

The real test uploaded a text file and a one-pixel PNG with the existing token restricted to `orchestration:read` and `orchestration:operate`. Both downloads exactly matched their original bytes. Deleting each pending attachment made a subsequent download fail. The selected test passed six assertions in 0.13 seconds; seven unrelated live cases were filtered out. The first upload attempt used PUT and was rejected; the adapter was corrected to the pinned route's POST method before the passing run. No signed URL or credential appeared in the failure output.

Transfer fetches require a same-origin URL with the expected T3 route prefix, refuse redirects, and have a 30-second timeout. Downloads stop if bytes exceed declared size and reject truncated bodies. Transfer errors return a fixed classification because signed URLs carry bearer authority. A failed upload attempts to delete its still-pending allocation.

The full gate passed 69 tests, with one opt-in live test skipped and zero failures. Malformed/oversized metadata and unsupported image formats fail at the adapter boundary.

This is T3 transport evidence only. Slack ingestion still sends no attachments, its manifest still omits file scopes, and returned artifact transfer, task-bound attachment ownership, provider perception, retention, and human round-trip acceptance remain unimplemented or unverified. SLK-05 and SEC-01 remain pending. This does not establish filesystem or credential isolation.
