import { Module } from "@nestjs/common"
import { ContextModule } from "../../context/context.module"
import { UsageStatsModule } from "../../usage"
import { KiroModule } from "../aws/kiro.module"
import { GoogleModule } from "../google/google.module"
import { CodexModule } from "../openai/codex.module"
import { OpenaiCompatModule } from "../openai/openai-compat.module"
import { ModelModule } from "../shared/model.module"
import { AnthropicApiService } from "./anthropic-api.service"
import { ForkedAnthropicCallService } from "./forked-anthropic-call.service"
import { PromptCacheBreakDetectionService } from "./prompt-cache-break-detection.service"

@Module({
  // KiroModule + GoogleModule + CodexModule + OpenaiCompatModule are imported
  // (not just AnthropicApiService's own deps) because ForkedAnthropicCallService
  // dispatches helper LLM calls to whichever backend serves the model the user
  // pinned in `subagent_model_overrides` (or, on inherit-from-parent, whichever
  // backend served the parent turn). All four backend modules are pure leaves —
  // they don't import AnthropicApiModule — so this does not create a cycle.
  // ModelModule provides ModelRouterService which the fork helper consults to
  // map a pinned model id (e.g. "gpt-5.5-fast", "gemini-3.1-pro") onto the
  // right backend when the user's override is a concrete model rather than
  // inherit/disabled.
  imports: [
    UsageStatsModule,
    ContextModule,
    KiroModule,
    GoogleModule,
    CodexModule,
    OpenaiCompatModule,
    ModelModule,
  ],
  providers: [
    AnthropicApiService,
    ForkedAnthropicCallService,
    PromptCacheBreakDetectionService,
  ],
  exports: [
    AnthropicApiService,
    ForkedAnthropicCallService,
    PromptCacheBreakDetectionService,
  ],
})
export class AnthropicApiModule {}
