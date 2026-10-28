# Upstream attribution

This package does not depend on Spectrum core or the Advanced iMessage SDK at
runtime. It is a small Web-only adjacent facade over generated Photon protobuf
contracts and Connect's gRPC-Web implementation. Dependency licenses remain
applicable to their respective packages.

Routing behavior, shared-line semantics, multipart child IDs, attachment flow,
and reaction mapping in `src/runtime-messages.ts`, `src/runtime.ts`,
`src/runtime-lines.ts`, and `src/runtime-parts.ts` are adapted from:

- https://github.com/photon-hq/spectrum-ts
- Inspected source commit: `d9e39089dc3d1c6f4536826f5ca50798856eecab`
- Published core 12.14.0 git head: `2eb2a426d8670f3cc945d904b658a6259fe0e9e5`
- Protobuf contract source: https://github.com/photon-hq/advanced-imessage-ts
- Low-level 2.4.0 commit: `1548b6465e8ded2a461cfa2b7be1ac05b70d7329`

## Spectrum upstream license

MIT License Copyright (c) 2025 Photon AI

Permission is hereby granted,
free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice
(including the next paragraph) shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
