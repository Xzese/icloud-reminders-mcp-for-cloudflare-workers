# Provenance and attribution

Protocol implementations in `src/crypto/apple-kdf.ts`, `srp.ts`, `spake2.ts`, `src/transport/apple-push.ts`, `src/auth/apple/`, `src/transport/apple-websocket.ts`, `src/icloud/cloudkit.ts`, and `src/reminders/crdt.ts` are TypeScript translations or narrow reimplementations informed by the exact pyicloud revision in `sources.json`. Preserve its MIT notice, copyright PyiCloud Authors, together with the application reference's MIT notice, copyright Petr Chesnokov. The reference application is chesnokpeter/icloud-linux; no unrelated iCloud services were ported.

SRP formulas and reference transcripts also use Python `srp==1.0.22`; its MIT notice is preserved. Cryptography and protobuf are build-time fixture dependencies only; their distribution notices are retained. No Python code or subprocess is part of the deployed runtime. The fixture generator executes selected pinned Python encoding functions only at build time with invented inputs.

Runtime P-256/scrypt uses @noble/curves and @noble/hashes (MIT); compression uses fflate (MIT); HTTP MCP uses the official MCP SDK (MIT). Exact package versions and installed license declarations are recorded in `dependencies.json` and `package-lock.json`. `THIRD_PARTY_NOTICES.txt` preserves available license texts from installed packages, including build-time dependencies as a conservative superset. A copy is shipped as a static notice asset. The Sites starter plugin's MIT notice is included separately and in that asset.

The pinned protobuf schemas identify Apple main.js as their source. Their provenance is not treated as independently resolved by the repository MIT license. No .proto or generated Python protobuf source is copied into this project. The implementation is a bounded, hand-written protocol codec with reference-generated synthetic wire fixtures. Review schema provenance before copying or expanding schema/generated-code reuse or treating the codec as production-approved.

Fixture agreement is not independent proof of Apple protocol correctness. A cryptographic review and live hosted acceptance remain required. No source license notice grants authorization to access an Apple account or live data.

To refresh the package inventory and notice asset after a locked install, run `node scripts/release/generate-notices.mjs` and rebuild. Review unknown package license declarations before approving a production release.
