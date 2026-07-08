# Pinned to the exact claude CLI version verified for this harness.
FROM node:22-slim

# git is needed by claude for repo-aware operations; ca-certificates for TLS to
# the API; the rest are runtime deps for the baked G-Stack toolchain (unzip for
# bun's installer, curl/xz for asset fetches, python3 for a few skill helpers).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates curl unzip xz-utils python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.202

# Bun (G-Stack is Bun-native). Node 22 and Bun coexist; bun lands on PATH.
RUN npm install -g bun@1.3.10 && bun --version

# G-Stack setup skip-flags: no sudo font install, no macOS coreutils, no gbrain
# regen. Baked here so both the image build and the runtime setup honor them.
ENV GSTACK_SKIP_FONTS=1 \
    GSTACK_SKIP_COREUTILS=1 \
    GSTACK_SKIP_GBRAIN_REGEN=1

# Bake a BUILT G-Stack into the image's own filesystem. The build MUST run on
# the image fs (not a bind-mount): `bun run build` fails over the macOS Docker
# virtiofs bind-mount (rename ENOENT) but succeeds on local fs. Vendored source
# excludes .git/node_modules/dist; node_modules + browse binary are built here.
COPY prompts/gstack/gstack-src /opt/gstack
RUN cd /opt/gstack && bun install && bun run build || true
# `|| true`: `bun run build` may exit non-zero on optional targets in-container;
# the registration step at runtime only needs the browse binary + skill dirs,
# which the build produces. We validate skill registration empirically.

# G-Stack's `setup` hard-gates on a launchable Playwright Chromium (set -e aborts
# before skill registration otherwise). Bake the browser + its host libs into the
# image so setup passes without a per-run 106 MB download. Shared browser path so
# the non-root `node` user resolves it at runtime. This is the bulk of the image
# growth; it also lets the browser-backed skills partially work in-container.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN cd /opt/gstack && bunx playwright install --with-deps chromium chromium-headless-shell \
    && chmod -R a+rX /opt/ms-playwright

# All claude config/auth is read from /cfg, never the host ~/.claude.
ENV CLAUDE_CONFIG_DIR=/cfg

# Put G-Stack's bin on PATH so its tools (browse, make-pdf, gstack) resolve when
# a variant's skills shell out to them.
ENV PATH="/opt/gstack/bin:${PATH}"

# The node:22-slim image ships a non-root `node` user (uid 1000). Running as
# non-root is a defense-in-depth plus. /cfg and /work are bind-mount targets;
# we create them and hand ownership to `node` so writes succeed. /opt/gstack is
# owned by node too so runtime setup can write .version/state next to binaries.
RUN mkdir -p /cfg /work && chown -R node:node /cfg /work /opt/gstack

USER node
WORKDIR /work

# Default to a shell; the harness always overrides the command with an explicit
# `claude ...` (or G-Stack setup) invocation via `docker run ... claude-bench <args>`.
CMD ["bash"]
