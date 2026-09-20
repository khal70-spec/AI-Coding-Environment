// @ai-coding-env/memory — Plan §25. Service layer over the storage memory DAOs.
// Guarantees: exact-scope isolation (T20), secret-refusing writes (fail closed),
// audited content-free mutations, deletion/export/redaction, retention sweep.
export {
  MemoryService,
  MemoryError,
  validateRef,
  MEMORY_KEY_MAX,
  MEMORY_VALUE_JSON_MAX,
  MEMORY_EXPORT_MAX_BYTES,
  SCRATCHPAD_DEFAULT_TTL_HOURS,
} from "./service.ts";
export type {
  AuditLike,
  MemoryErrorCode,
  MemoryRef,
  MemoryServiceDeps,
  MemorySetInput,
} from "./service.ts";
