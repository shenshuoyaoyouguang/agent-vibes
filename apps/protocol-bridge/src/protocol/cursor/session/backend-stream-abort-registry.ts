/**
 * @deprecated Re-export shim. The implementation moved to
 * `cursor/backend/backend-abort-registry.ts` as part of the cursor-namespace
 * Phase A rewrite. The class was renamed `BackendAbortRegistry`. New code
 * MUST import from the backend/ path; this shim exists only so we can land
 * Phase A without touching every caller in cursor-connect-stream.service.ts.
 * Phase H will delete this file along with the rest of the legacy surface.
 */
export {
  BackendAbortRegistry as BackendStreamAbortRegistry,
  type RegisteredBackendAbortController,
} from "../backend/backend-abort-registry"
