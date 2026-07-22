# wg-vf build toolchain.
#
# Everything needed to build the non-JS assets and run the suites:
#   - clang        native .so + C syntax checks
#   - emscripten   C/Nim → wasm (the reference vignettes, the three example)
#   - nim          the Nim-interop example (examples/three)
#   - bun          run the tests / the TS host
#
# This image ships no wg-vf source; mount the repo and run:
#   docker build -t wg-vf-toolchain .
#   docker run --rm -v "$PWD":/work wg-vf-toolchain bash -lc "npm ci && npm run test:wasm"
#
# Or use the accompanying docker-compose.yml, which wraps the mount/workdir:
#   docker compose run --rm toolchain npm run test:wasm   # build wasm/native + test
#   docker compose run --rm toolchain bun test            # full suite
#   docker compose up server                              # live host on ws://localhost:8787
#
# (Pure-C native builds need only clang; wasm needs emscripten; the three
# example's Nim-interop vignette needs nim.)

FROM debian:bookworm-slim

ARG NIM_VERSION=2.2.10
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential clang lld cmake git curl ca-certificates xz-utils unzip python3 \
    && rm -rf /var/lib/apt/lists/*

# --- Emscripten (emsdk) ---
ENV EMSDK=/opt/emsdk
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk "$EMSDK" \
    && "$EMSDK/emsdk" install latest \
    && "$EMSDK/emsdk" activate latest
ENV EMSCRIPTEN_SDK="$EMSDK"
ENV PATH="$EMSDK:$EMSDK/upstream/emscripten:$PATH"

# --- Nim (for the interop example) ---
ENV NIM=/opt/nim
RUN curl -fsSL "https://nim-lang.org/download/nim-${NIM_VERSION}-linux_x64.tar.xz" \
      | tar -xJ -C /opt \
    && mv "/opt/nim-${NIM_VERSION}" "$NIM"
ENV PATH="$NIM/bin:$PATH"

# --- Bun (run tests / TS host) ---
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# --- Node/npm (for npm scripts) ---
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Put the whole toolchain on PATH for login shells too (bash -lc resets PATH).
RUN printf 'export EMSCRIPTEN_SDK=/opt/emsdk\nexport PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/nim/bin:/root/.bun/bin:$PATH"\n' \
      > /etc/profile.d/wg-vf-toolchain.sh

# Nim compiles {.compile.} C files (wg_vf.c) into its cache before creating the
# cache dir, which fails on a cold cache under emscripten. Pre-create it so the
# Nim-interop example (examples/three, entry main.nim → main_d) builds out of the box.
RUN mkdir -p /root/.cache/nim/main_d

WORKDIR /work
CMD ["bash"]
