// Re-export shim. The real source is in src/index.ts.
// This file is here only as a safety net so that tools / typecheckers that
// resolve the package entry before the build step won't fail with a hard error.
export { MemoryCapsulePlugin } from './src/index.js'
export type { CognitiveCapsule, RuntimeContext, CapsulePluginConfig } from './src/types.js'
