import { Module, OnApplicationBootstrap } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { GoogleModule } from "../../llm/google/google.module"
import { KiroModule } from "../../llm/aws/kiro.module"
import { ImageGenerationModule } from "../../llm/image-generation/image-generation.module"
import { CodexModule } from "../../llm/openai/codex.module"
import { OpenaiCompatModule } from "../../llm/openai/openai-compat.module"
import { ModelModule } from "../../llm/shared/model.module"
import { AnthropicModule } from "../anthropic/anthropic.module"
import { AntigravityIdeSyncService } from "./antigravity-ide-sync.service"
import { AiserverMockController } from "./controllers/aiserver-mock.controller"
import { AuthController } from "./controllers/auth.controller"
import { CursorAdapterController } from "./controllers/cursor-adapter.controller"
import { CursorAuthService } from "./cursor-auth.service"
import { CursorConnectStreamService } from "./cursor-connect-stream.service"
import { CursorGrpcService } from "./cursor-grpc.service"
import { KnowledgeBaseService } from "./knowledge-base.service"
import { KvStorageService } from "./kv-storage.service"
import { SemanticSearchProviderService } from "./semantic-search-provider.service"
import { SessionLifecycleService } from "./session/session-lifecycle.service"
import { ExecDispatchSerializerService } from "./session/exec-dispatch-serializer.service"
import { PendingDeadlineSweeper } from "./session/pending-deadline-sweeper.service"
import { ToolExecutionCoordinatorService } from "./session/tool-execution-coordinator.service"
import { CursorSkillsManager } from "./skills"
import { SubagentLoaderService } from "./subagents/subagent-loader.service"
import { SubagentRegistryService } from "./subagents/subagent-registry.service"
import { SubagentExecBridgeService } from "./subagents/subagent-exec-bridge.service"
import { SubagentTranscriptStore } from "./subagents/subagent-transcript-store.service"
import { SubagentTaskRegistry } from "./subagents/subagent-task-registry.service"
import { SubagentBackgroundWorker } from "./subagents/subagent-background-worker.service"
import { ToolUseSummaryService } from "./subagents/tool-use-summary.service"
import { ClientSideToolV2ExecutorService } from "./tools/client-side-tool-v2-executor.service"
import { WebSearchAdapterFactory, WebSearchService } from "./web-search"
import { TurnLifecycle } from "./turn/turn-lifecycle.service"
import { TurnCleanupCoordinator } from "./turn/turn-cleanup-coordinator.service"
import { MessageStore } from "./session/message-store.service"
import { ToolCallLedger } from "./session/tool-call-ledger.service"
import { SessionPersistenceService } from "./session/session-persistence.service"
import { AssistantToolBatchService } from "./session/assistant-tool-batch.service"
import { SessionStreamService } from "./session/session-stream.service"
import { ContextStateService } from "./session/context-state.service"
import { BackgroundJobRegistry } from "./subagents-bridge/background-job-registry"

@Module({
  imports: [
    AnthropicModule,
    CodexModule,
    GoogleModule,
    ImageGenerationModule,
    KiroModule,
    ContextModule,
    ModelModule,
    OpenaiCompatModule,
  ],
  controllers: [
    CursorAdapterController,
    AuthController,
    AiserverMockController,
  ],
  providers: [
    SessionLifecycleService,
    ToolExecutionCoordinatorService,
    ExecDispatchSerializerService,
    ClientSideToolV2ExecutorService,
    AntigravityIdeSyncService,
    CursorAuthService,
    CursorConnectStreamService,
    CursorGrpcService,
    CursorSkillsManager,
    KvStorageService,
    SemanticSearchProviderService,
    KnowledgeBaseService,
    SubagentLoaderService,
    SubagentRegistryService,
    SubagentExecBridgeService,
    SubagentTranscriptStore,
    SubagentTaskRegistry,
    SubagentBackgroundWorker,
    ToolUseSummaryService,
    WebSearchAdapterFactory,
    WebSearchService,
    // Phase H1: new turn architecture providers. These are wired so
    // CursorConnectStreamService can resolve them from DI; the
    // legacy generator path still drives behavior, but now does so
    // under a TurnLifecycle so subsequent phases can swap pieces
    // in incrementally.
    TurnLifecycle,
    TurnCleanupCoordinator,
    // Step 3 additions: ledger + transactional message store + new
    // sessions/v2 schema persistence. Wired so SessionLifecycleService
    // (and follow-up callers in step 8) can resolve them from DI.
    MessageStore,
    ToolCallLedger,
    SessionPersistenceService,
    AssistantToolBatchService,
    SessionStreamService,
    ContextStateService,
    BackgroundJobRegistry,
    PendingDeadlineSweeper,
  ],
  exports: [
    CursorAuthService,
    CursorConnectStreamService,
    SessionLifecycleService,
    ToolExecutionCoordinatorService,
    SubagentRegistryService,
    SubagentExecBridgeService,
    SubagentTaskRegistry,
    SubagentTranscriptStore,
    TurnLifecycle,
    TurnCleanupCoordinator,
    MessageStore,
    ToolCallLedger,
    SessionPersistenceService,
    AssistantToolBatchService,
    SessionStreamService,
    ContextStateService,
    BackgroundJobRegistry,
  ],
})
export class CursorModule implements OnApplicationBootstrap {
  constructor(
    private readonly sweeper: PendingDeadlineSweeper,
    private readonly streamService: CursorConnectStreamService
  ) {}

  /**
   * Wire the sweeper → streamService cycle after the DI graph is
   * fully constructed. The sweeper uses the stream service to
   * synthesize expiry frames; the stream service uses the
   * sessionManager which the sweeper also depends on, so injecting
   * the stream service through the sweeper's constructor would
   * create a cycle. `onApplicationBootstrap` is the standard Nest
   * hook for this pattern.
   */
  onApplicationBootstrap(): void {
    this.sweeper.setStreamService(this.streamService)
  }
}
