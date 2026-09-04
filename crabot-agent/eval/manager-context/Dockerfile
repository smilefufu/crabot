FROM node:20-alpine

WORKDIR /workspace
RUN corepack enable
COPY package.json ./package.json

COPY crabot-shared/package.json crabot-shared/pnpm-lock.yaml crabot-shared/tsconfig.json ./crabot-shared/
RUN corepack pnpm --dir crabot-shared install --frozen-lockfile
COPY crabot-shared/src ./crabot-shared/src
RUN corepack pnpm --dir crabot-shared build

COPY crabot-agent/package.json crabot-agent/pnpm-lock.yaml crabot-agent/tsconfig.json ./crabot-agent/
RUN corepack pnpm --dir crabot-agent install --frozen-lockfile
COPY crabot-agent/src ./crabot-agent/src
COPY crabot-agent/eval/manager-context/runner.ts crabot-agent/eval/manager-context/tsconfig.json ./crabot-agent/eval/manager-context/
COPY crabot-agent/eval/manager-context/fixtures ./crabot-agent/eval/manager-context/fixtures
RUN corepack pnpm --dir crabot-agent exec tsc -p eval/manager-context/tsconfig.json

WORKDIR /workspace/crabot-agent
ENV EVAL_FIXTURE_DIR=/workspace/crabot-agent/eval/manager-context/fixtures
ENV EVAL_OUTPUT_DIR=/output

ENTRYPOINT ["node", "dist-eval/eval/manager-context/runner.js"]
CMD ["deterministic"]
