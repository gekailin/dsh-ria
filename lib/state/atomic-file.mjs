// Compatibility entry point: the implementation lives in lib/shared/fs.mjs.
// Existing imports keep working while new code uses the shared module.
export { writeAtomic } from '../shared/fs.mjs'
