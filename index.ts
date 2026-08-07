export {
  monetize,
  MemoryNonceStore,
  RedisNonceStore,
  type MonetizeOptions,
  type NonceStore
} from "./monetize";

export {
  createMonetizedMCPTool,
  type MCPToolDefinition
} from "./mcpWrapper";

// Add these exports for security guard
export { x402Guard, scanPayloadForInjection } from "./guard.js";
export type { GuardOptions } from "./guard.js";