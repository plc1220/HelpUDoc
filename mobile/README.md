# HelpUDoc Mobile

This directory contains the early Expo-based mobile companion app.

## Current status

The mobile app is now a static, chat-first product prototype. Today it:

- boots with Expo
- renders a HelpUDoc mobile shell with Lumo as the visible assistant avatar
- uses a primary chat screen instead of the desktop three-pane layout
- opens generated artifacts in a full-screen canvas viewer
- uses bottom sheets for recent conversations, workspace files, and canvas actions
- imports shared TypeScript types from `packages/shared` (compatibility re-export of `@helpudoc/contracts`)

It does not yet implement authentication, backend API calls, workspace syncing, or live Lumo chat.

## Getting started

```bash
cd mobile
npm install
npm start
```

That launches the Expo dev server defined by the package's `start` script.

## Files of interest

- `App.tsx`: current chat-first mobile prototype
- `assets/lumo/lumo-spritesheet.webp`: copied Lumo sprite sheet used by the mobile avatar
- `package.json`: Expo/React Native dependencies
- `tsconfig.json`: TypeScript configuration for the mobile app

## Related code

- `packages/shared/`: thin compatibility layer re-exporting `@helpudoc/contracts` (same import path as before)
- `docs/mobile-app-development-plan.md`: planning notes for the broader mobile roadmap
