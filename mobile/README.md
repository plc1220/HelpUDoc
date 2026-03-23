# HelpUDoc Mobile

This directory contains the early Expo-based mobile companion app.

## Current status

The mobile app is still a lightweight spike rather than a full product surface. Today it:

- boots with Expo
- renders a simple HelpUDoc screen
- imports shared TypeScript types from `packages/shared`

It does not yet implement authentication, backend API calls, workspace syncing, or agent chat.

## Getting started

```bash
cd mobile
npm install
npm start
```

That launches the Expo dev server defined by the package's `start` script.

## Files of interest

- `App.tsx`: current proof-of-life screen
- `package.json`: Expo/React Native dependencies
- `tsconfig.json`: TypeScript configuration for the mobile app

## Related code

- `packages/shared/`: shared type exports already used by the app scaffold
- `docs/mobile-app-development-plan.md`: planning notes for the broader mobile roadmap
