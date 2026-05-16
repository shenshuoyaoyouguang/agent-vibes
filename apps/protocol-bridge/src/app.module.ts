import { Module } from "@nestjs/common"
import { ConfigModule } from "@nestjs/config"
import * as os from "os"
import * as path from "path"
import { ContextController } from "./context.controller"
import { ContextModule } from "./context/context.module"
import { HealthController } from "./health.controller"
import { KiroModule } from "./llm/aws/kiro.module"
import { GoogleModule } from "./llm/google/google.module"
import { ModelModule } from "./llm/shared/model.module"
import { PersistenceModule } from "./persistence"
import { AnthropicModule } from "./protocol/anthropic/anthropic.module"
import { CursorModule } from "./protocol/cursor/cursor.module"
import { validateEnv } from "./shared/env.validation"
import { UsageStatsModule } from "./usage"

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")

const ENV_FILE_CANDIDATES = [
  path.resolve(process.cwd(), "apps/protocol-bridge/.env.local"),
  path.resolve(process.cwd(), "apps/protocol-bridge/.env"),
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../.env.local"),
  path.resolve(__dirname, "../.env"),
  path.join(CODEX_HOME, ".env.local"),
  path.join(CODEX_HOME, ".env"),
]

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: Array.from(new Set(ENV_FILE_CANDIDATES)),
      validate: validateEnv,
    }),
    PersistenceModule,
    GoogleModule,
    AnthropicModule,
    CursorModule,
    ContextModule,
    ModelModule,
    UsageStatsModule,
    KiroModule,
  ],
  controllers: [HealthController, ContextController],
})
export class AppModule {}
