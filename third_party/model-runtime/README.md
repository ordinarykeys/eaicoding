# Model runtime license fallbacks

The model-runtime build gathers license and notice files from every npm package actually present in its esbuild input graph. These fallback copies cover packages whose npm tarballs omit a standalone notice file:

- `pi-ai-LICENSE`: MIT, Mario Zechner, from `earendil-works/pi` root `LICENSE` (the source repository declared by `@earendil-works/pi-ai 1.1.0`).
- `standardwebhooks-LICENSE`: MIT, Svix, from `standard-webhooks/standard-webhooks/libraries/LICENSE`. The repository root license is for the specification and is not the JavaScript library license.
- `proxy-agents-LICENSE`: the shared MIT attribution for Nathan Rajlich's proxy-agents code, copied from the installed `https-proxy-agent/LICENSE`; retained for the bundled `proxy-agent-negotiate` module from the same repository, which declares MIT and the same author but omits a notice file.

For AWS packages omitting the standard Apache text, the build uses the full `@aws-sdk/client-bedrock-runtime/LICENSE` from the same SDK family. `data-uri-to-buffer` includes its full MIT notice in its README, which the build retains. The exact bundled Node distribution's complete `LICENSE` is copied from the Node installation beside `node.exe`.

The generated `model-runtime/THIRD-PARTY-LICENSES.txt` and `NODE-LICENSE.txt` are shipped in both installer and portable packages. Runtime binaries and generated notices live under `src-tauri/target/` and are not committed.
