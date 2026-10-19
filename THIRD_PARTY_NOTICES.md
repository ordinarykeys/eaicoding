# Third-party notices

## DeepSeek Harness

Source: https://github.com/deepseek-ai/deepseek-harness
Reference checkout: `86a402200d95fecef4529d969836f1fe13c6cb0d`.

EAiCoding adapts the Platform PKCE account protocol, welcome-page geometry, account-menu / personal-center / sign-out interactions, decimal balance formatting, and native Windows installer presentation from DeepSeek Harness. Account references: `packages/client/ui-settings-account/src/client/{AccountMenu,AccountSection,AccountAvatar,SignOutDialog,formatBalance}` (TSX/TS and CSS modules), and `packages/credentials/deepseek-account-platform/src/{details,protocol}.ts`. Original installer source paths: `apps/desktop/installer/{pages,drawing,theme,path}.nsh`, `progress.h`, `extract.h`, `extract-progress.h`, and the presentation portion of `window-frame.cpp`. The extraction helper supervises a separate 7-Zip process and projects its progress to the UI. The Tauri adapter uses its own payload installation, progress source, registry, and launch routines. DeepSeek names and brand artwork are replaced with EAiCoding's own identity. These adaptations do not imply official certification or endorsement.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tauri NSIS installer template

`src-tauri/installer/installer.nsi` is based on the template embedded in `@tauri-apps/cli` 2.10.1, distributed under MIT or Apache-2.0. EAiCoding uses the MIT option for this adapted template.

MIT License

Copyright (c) 2017 - Present Tauri Apps Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 7-Zip installer extractor

The installer includes the unmodified Windows x64 7za.exe 21.07 binary from the pinned 7zip-bin 5.2.0 npm package, also used by Harness's build tooling. It runs only as a separate installer child process; no 7-Zip code is linked into EAiCoding. 7-Zip is Copyright (C) 1999-2021 Igor Pavlov and distributed under GNU LGPL 2.1 or later, with the additional license details included in `licenses/7zip/License.txt` and `licenses/7zip/COPYING.txt` in the distributions (repository: `third_party/7zip/`). Corresponding source is available at https://github.com/ip7z/7zip/tree/21.07 and https://www.7-zip.org/ . No modifications were made to the 7-Zip binary.

The 7zip-bin packaging code is MIT, Copyright (c) 2016 Vladimir Krivosheev; its MIT notice is supplied in the installer's temporary tool directory.

## big.js

Source: https://github.com/MikeMcl/big.js (7.0.1). Used for decimal account-balance formatting.

The MIT License (MIT)
=====================

Copyright © `<2025>` `Michael Mclaughlin`

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the “Software”), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
