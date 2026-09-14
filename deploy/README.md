# Browser sandbox profile

`browser-seccomp.json` is the Playwright v1.63.0 Docker seccomp profile from https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json, distributed under the included Apache-2.0 license (`LICENSE.playwright`). It adds the user-namespace permissions needed for sandboxed Chromium to Docker's baseline syscall policy. The worker runs as the non-root `node` user; it does not use `--no-sandbox`, privileged containers, host networking, or a host Chrome profile.

The browser version in the worker package and Dockerfile must remain aligned.
