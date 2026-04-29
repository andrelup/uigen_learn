# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

UIGen is a Next.js app that lets users describe a React component in chat and watch the assistant build it live in a browser-side sandbox. There is **no scaffolded codebase on disk** for the generated components — the AI's tool calls operate on an in-memory `VirtualFileSystem`, and the preview is rendered by transforming the virtual files through Babel-standalone and wiring them into an iframe via an import map of blob URLs.

## Commands

```bash
npm run setup       # install deps, run prisma generate, apply migrations
npm run dev         # next dev --turbopack (foreground, default)
npm run dev:daemon  # same, backgrounded with logs to logs.txt
npm run build       # next build
npm run lint        # next lint
npm test            # vitest (jsdom environment)
npm run db:reset    # prisma migrate reset --force
```

Run a single test: `npx vitest run path/to/file.test.ts` (or `-t "test name"` for a single case).

## Big-picture architecture

### Virtual file system, not the real one
`src/lib/file-system.ts` defines `VirtualFileSystem`, an in-memory tree of files/directories. Generated components only ever exist here — they are serialized to JSON and persisted on the `Project.data` column. Anything that looks like a file path (`/App.jsx`, `/components/Foo.jsx`) refers to this virtual root, not the project on disk.

### AI loop
`src/app/api/chat/route.ts` is the only LLM endpoint. Per request it:
1. Prepends `generationPrompt` (`src/lib/prompts/generation.tsx`) as a cached system message.
2. Rebuilds a fresh `VirtualFileSystem` from the client-supplied `files` payload (`deserializeFromNodes`).
3. Streams via `streamText` from the Vercel AI SDK with two tools: `str_replace_editor` (Anthropic-style text editor: `view`/`create`/`str_replace`/`insert`) and `file_manager` (`rename`/`delete`). Both tools mutate the per-request VFS.
4. On finish, if `projectId` and an authenticated session both exist, persists `messages` + `fileSystem.serialize()` back to the `Project` row.

The model is selected by `getLanguageModel()` in `src/lib/provider.ts`. **Without `ANTHROPIC_API_KEY` in `.env`, it falls back to `MockLanguageModel`**, a hardcoded scripted streamer that emits one of three canned components (counter / form / card) based on keyword matching. Step caps differ: 4 for the mock, 40 for the real model. When debugging tool flow without burning API credits, the mock path is the one the route will follow.

### Client mirrors the server's tool calls
On the client, `FileSystemProvider` (`src/lib/contexts/file-system-context.tsx`) holds its own `VirtualFileSystem` instance and `ChatProvider` (`src/lib/contexts/chat-context.tsx`) wires `useChat`'s `onToolCall` to `handleToolCall`. So every server-side tool call is replayed locally to keep the client VFS in sync — that's how the file tree, code editor, and preview update during streaming. The client sends `fileSystem.serialize()` in every request body so the server can reconstruct state.

### Preview pipeline
`src/lib/transform/jsx-transformer.ts` runs entirely in the browser. `createImportMap` walks every virtual file, transforms `.jsx`/`.tsx`/`.ts` with `@babel/standalone` (`react` automatic runtime + optional `typescript` preset), wraps each transformed module in a `Blob` URL, and assembles an ES module import map that resolves:
- `react`, `react-dom`, `react/jsx-runtime` → esm.sh CDN
- Every virtual path, both absolute and `@/`-aliased, with and without extension → its blob URL
- Any unresolved third-party package → `https://esm.sh/<pkg>`
- Any unresolved local import → a synthesized placeholder module that renders an empty div (so missing files don't crash the preview mid-stream)

CSS imports are extracted, concatenated, and inlined into the iframe `<style>` block; Tailwind is loaded via CDN script in `createPreviewHTML`. The result is rendered into an iframe by `PreviewFrame`.

### Authentication and projects
- JWT in an `httpOnly` cookie (`auth-token`), signed/verified with `jose` against `JWT_SECRET` (falls back to `"development-secret-key"` in dev). See `src/lib/auth.ts`.
- Passwords hashed with `bcrypt`. Server actions live in `src/actions/` and are marked `"use server"`.
- `src/middleware.ts` only enforces auth on `/api/projects` and `/api/filesystem` (currently no such routes exist — `/api/chat` is intentionally open to anonymous users).
- Anonymous users get a working session via `src/lib/anon-work-tracker.ts`, which keeps `messages` + serialized VFS in `sessionStorage` under `uigen_anon_data`. After sign-in/sign-up, that pending work can be hydrated into a new project.
- `src/app/page.tsx`: authed users are redirected to their most-recent project (or a freshly created one); anonymous users get the editor with no `projectId`.

### Data layer
SQLite via Prisma (`prisma/dev.db`). The Prisma client is generated to **`src/generated/prisma`** (see the `output` line in `prisma/schema.prisma`) — import it as `@/generated/prisma`, not `@prisma/client`. `Project.messages` and `Project.data` are stringified JSON columns; nothing about the virtual filesystem is normalized in the schema.

### Node 25+ SSR workaround
`src/instrumentation.ts` and `node-compat.cjs` both delete `globalThis.localStorage`/`sessionStorage` on the server. Node 25 exposes these globals via the experimental Web Storage API but they throw without `--localstorage-file`; deleting them restores the pre-25 `typeof localStorage === "undefined"` behavior that SSR-safe libraries expect. **Don't add `typeof window` guards as a workaround — the global being missing is the fix.**

## Conventions worth knowing

- Path alias `@/*` maps to `src/*` (see `tsconfig.json`). Inside the *virtual* filesystem, `@/` also resolves to the virtual root — the JSX transformer rewrites both forms.
- shadcn/ui is configured (`components.json`, style `new-york`, base color `neutral`, lucide icons). New UI primitives go in `src/components/ui/`.
- Tests colocated in `__tests__/` folders next to the code under test. Vitest uses `jsdom` and `vite-tsconfig-paths` to resolve `@/`.
- `MODEL` constant in `src/lib/provider.ts` is the single source of truth for the Anthropic model id (currently `claude-haiku-4-5`).
