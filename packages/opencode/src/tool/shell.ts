import z from "zod"
import os from "os"
import { spawn } from "child_process"
import { Tool } from "./tool"
import path from "path"
import DESCRIPTION from "./shell.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { Filesystem } from "@/util/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag.ts"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncation"
import { Plugin } from "@/plugin"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const PATHS = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-newname", "-path"])

export const log = Log.create({ service: "shell-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push(item.text)
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push(child.text)
  }
  return out
}

function nested(node: Node) {
  let parent = node.parent
  while (parent) {
    if (parent.type === "command") return true
    parent = parent.parent
  }
  return false
}

function cmds(node: Node) {
  const out = []
  for (const item of node.descendantsOfType("command")) {
    if (!item || nested(item)) continue
    out.push(item)
  }
  return out
}

function text(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function clean(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function env(name: string) {
  if (process.platform !== "win32") return process.env[name]
  const key = Object.keys(process.env).find((item) => item.toLowerCase() === name.toLowerCase())
  return key ? process.env[key] : undefined
}

function expand(text: string) {
  let ok = true
  const out = clean(text).replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => {
    const value = env(key)
    if (!value) {
      ok = false
      return ""
    }
    return value
  })
  if (!ok) return
  return home(out)
}

function drive(text: string) {
  return /^[A-Za-z]:($|[\\/])/.test(text)
}

function provider(text: string) {
  return /^[A-Za-z]+:/.test(text) && !drive(text)
}

function dynamic(text: string, ps: boolean) {
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (/[?*\[]/.test(text)) return true
  if (ps) return text.includes("@(") || /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function file(arg: string, cwd: string, ps: boolean) {
  const text = ps ? expand(arg) : home(clean(arg))
  if (!text || dynamic(text, ps)) return
  if (ps && provider(text)) return
  return Filesystem.canonical(text, cwd)
}

function args(tokens: string[], cmd: string | undefined, ps: boolean) {
  if (!cmd) return []
  if (!ps) {
    return tokens.slice(1).filter((arg) => !arg.startsWith("-") && !(cmd === "chmod" && arg.startsWith("+")))
  }

  const out = []
  let named = false
  let want = false
  for (const arg of tokens.slice(1)) {
    const lower = arg.toLowerCase()
    if (want) {
      out.push(arg)
      want = false
      continue
    }
    if (lower.startsWith("-")) {
      named = true
      want = FLAGS.has(lower)
      continue
    }
    if (!named) out.push(arg)
  }
  return out
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: shWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const shPath = resolveWasm(shWasm)
  const psPath = resolveWasm(psWasm)
  const [shLanguage, psLanguage] = await Promise.all([Language.load(shPath), Language.load(psPath)])
  const sh = new Parser()
  sh.setLanguage(shLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { sh, ps }
})

export const ShellTool = Tool.define("shell", async () => {
  const shell = Shell.acceptable()
  const name = Shell.name(shell)
  const chain =
    name === "powershell"
      ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
      : "If the commands depend on each other and must run sequentially, use a single Shell call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Shell for git operations, or git add before git commit), run these operations sequentially instead."
  log.info("Shell tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${os}", process.platform)
      .replaceAll("${shell}", name)
      .replaceAll("${chaining}", chain)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd =
        process.platform === "win32"
          ? Filesystem.canonical(params.workdir || Instance.directory, Instance.directory)
          : Filesystem.resolve(params.workdir || Instance.directory, Instance.directory)
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const tree = await parser().then((p) => (PS.has(name) ? p.ps : p.sh).parse(params.command))
      if (!tree) {
        throw new Error("Failed to parse command")
      }
      const directories = new Set<string>()
      if (!Instance.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const node of cmds(tree.rootNode)) {
        if (!node) continue
        const commandText = text(node)
        const command = parts(node)
        const cmd = PS.has(name) ? command[0]?.toLowerCase() : command[0]

        if (cmd && PATHS.has(cmd)) {
          for (const arg of args(command, cmd, PS.has(name))) {
            const resolved = file(arg, cwd, PS.has(name))
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              if (!Instance.containsPath(resolved)) {
                const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
                directories.add(dir)
              }
            }
          }
        }

        if (command.length && (!cmd || !CWD.has(cmd))) {
          patterns.add(commandText)
          always.add(BashArity.prefix(command).join(" ") + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          if (process.platform === "win32") return Filesystem.normalizePathPattern(path.join(dir, "*"))
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "shell",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const shellEnv = await Plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const env = {
        ...process.env,
        ...shellEnv.env,
      }
      const proc =
        process.platform === "win32" && PS.has(name)
          ? spawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", params.command], {
              cwd,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
            })
          : spawn(params.command, {
              shell,
              cwd,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              detached: process.platform !== "win32",
            })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            // truncate the metadata to avoid GIANT blobs of data (has nothing to do w/ what agent can access)
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => Shell.killTree(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
        })

        proc.once("close", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`Shell tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
