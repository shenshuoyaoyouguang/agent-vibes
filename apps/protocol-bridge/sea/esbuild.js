/**
 * esbuild configuration for Protocol Bridge SEA bundling.
 *
 * Uses @swc/core to transpile decorator-bearing TypeScript with proper
 * `emitDecoratorMetadata` output (legacy decorators + design:paramtypes).
 * NestJS DI relies on this metadata to resolve constructor params.
 *
 * Pipeline: SWC (src/**\/*.ts) → esbuild bundle (CJS) → SEA blob
 */
const esbuild = require("esbuild")
const path = require("path")
const fs = require("fs")
const swc = require("@swc/core")

// Only files under apps/protocol-bridge/src are routed through SWC.
// sea-entry.ts and any node_modules .ts are handled by esbuild's
// built-in TS loader (no decorator metadata needed there).
const SRC_ROOT = path.resolve(__dirname, "..", "src") + path.sep

const swcDecoratorPlugin = {
  name: "swc-decorators",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (!args.path.startsWith(SRC_ROOT)) return null

      const source = await fs.promises.readFile(args.path, "utf-8")
      const { code } = await swc.transform(source, {
        filename: args.path,
        sourceMaps: false,
        jsc: {
          parser: {
            syntax: "typescript",
            decorators: true,
            dynamicImport: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          target: "es2022",
          keepClassNames: true,
        },
        // Emit ES module syntax; let esbuild handle the final CJS conversion.
        module: { type: "es6" },
      })
      return { contents: code, loader: "js" }
    })
  },
}

// Plugin to redirect @nestjs/swagger to our no-op stub
const swaggerStubPlugin = {
  name: "swagger-stub",
  setup(build) {
    build.onResolve({ filter: /^@nestjs\/swagger$/ }, () => ({
      path: path.join(__dirname, "swagger-stub.js"),
    }))
  },
}

/**
 * Plugin to inline tiktoken WASM into the bundle.
 *
 * tiktoken/lite loads tiktoken_bg.wasm via fs.readFileSync(__dirname + '/tiktoken_bg.wasm').
 * In a SEA binary there is no filesystem — so we replace the tiktoken CJS module
 * with a patched version that embeds the WASM as a base64 Buffer.
 */
const tiktokenWasmPlugin = {
  name: "tiktoken-wasm-inline",
  setup(build) {
    // Read WASM once at build time
    const wasmPath = require.resolve("tiktoken/tiktoken_bg.wasm")
    const wasmBase64 = fs.readFileSync(wasmPath).toString("base64")
    console.log(
      `  [tiktoken-wasm] Inlining ${(fs.statSync(wasmPath).size / 1024 / 1024).toFixed(1)}MB WASM as base64`
    )

    // Intercept any tiktoken .cjs file that loads the WASM via fs.readFileSync
    build.onLoad(
      { filter: /tiktoken[\\/](lite[\\/])?tiktoken\.cjs$/ },
      (args) => {
        let source = fs.readFileSync(args.path, "utf-8")

        // Replace the filesystem-based WASM loading with inline Buffer.
        // Match the entire candidates-building + for-loop + error-throw block:
        //   const candidates = __dirname ... .reduce(...)
        //   candidates.unshift(...)
        //   let bytes = null;
        //   for (...) { try { ... break; } catch {} }
        //   if (bytes == null) throw ...
        source = source.replace(
          /const candidates = __dirname[\s\S]*?if \(bytes == null\) throw[^;]*;/,
          `const bytes = Buffer.from("${wasmBase64}", "base64");`
        )

        return { contents: source, loader: "js" }
      }
    )
  },
}

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, "sea-entry.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: path.join(__dirname, "..", "dist", "sea-entry.js"),
    plugins: [swcDecoratorPlugin, swaggerStubPlugin, tiktokenWasmPlugin],
    // Keep node built-ins and NestJS optional peer deps external
    external: [
      "node:*",
      "@nestjs/websockets",
      "@nestjs/websockets/*",
      "@nestjs/microservices",
      "@nestjs/microservices/*",
      "class-transformer/storage",
      "@fastify/view",
      "fsevents",
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    treeShaking: true,
    minify: false,
    sourcemap: false,
    logLevel: "info",
    mainFields: ["main", "module"],
    resolveExtensions: [".ts", ".js", ".json"],
    loader: {
      ".sql": "text",
    },
  })

  console.log("\n✅ SEA bundle ready: dist/sea-entry.js")
}

build().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
