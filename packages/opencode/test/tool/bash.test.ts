import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { BashTool } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { Truncate } from "../../src/tool/truncation"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const projectRoot = path.join(__dirname, "../..")
const win = process.env.WINDIR?.replaceAll("\\", "/")
const bin = process.execPath.replaceAll("\\", "/")
const file = path.join(projectRoot, "test/tool/fixtures/output.ts").replaceAll("\\", "/")
const kind = () => path.win32.basename(process.env.SHELL || "", ".exe").toLowerCase()
const fill = (mode: "lines" | "bytes", n: number) => {
  if (["pwsh", "powershell"].includes(kind())) {
    if (mode === "lines") return `1..${n} | ForEach-Object { $_ }`
    return `Write-Output ('a' * ${n})`
  }
  return `${bin} ${file} ${mode} ${n}`
}
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = process.env.SHELL || Bun.which("bash") || "/bin/sh"
    return [{ label: path.basename(shell), shell }]
  }

  const list = [
    { label: "git bash", shell: process.env.SHELL || Bun.which("bash") },
    { label: "pwsh", shell: Bun.which("pwsh") },
    { label: "powershell", shell: Bun.which("powershell") },
    { label: "cmd", shell: process.env.COMSPEC || Bun.which("cmd.exe") },
  ].filter((item): item is { label: string; shell: string } => Boolean(item.shell))

  return list.filter((item, i) => list.findIndex((x) => x.shell.toLowerCase() === item.shell.toLowerCase()) === i)
})()
const ps = shells.filter((item) => ["pwsh", "powershell"].includes(item.label))
const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell =
  (item: { label: string; shell: string }, fn: (item: { label: string; shell: string }) => Promise<void>) =>
  async () => {
    const prev = process.env.SHELL
    process.env.SHELL = item.shell
    Shell.acceptable.reset()
    Shell.preferred.reset()
    try {
      await fn(item)
    } finally {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
      Shell.acceptable.reset()
      Shell.preferred.reset()
    }
  }

const each = (name: string, fn: (item: { label: string; shell: string }) => Promise<void>) => {
  for (const item of shells) {
    test(`${name} [${item.label}]`, withShell(item, fn))
  }
}

const mustTruncate = (result: { metadata: any; output: string }, item: { label: string; shell: string }) => {
  if (result.metadata.truncated) return
  throw new Error(
    [
      `shell: ${item.label}`,
      `path: ${item.shell}`,
      `exit: ${String(result.metadata.exit)}`,
      "output:",
      result.output,
    ].join("\n"),
  )
}

describe("tool.bash", () => {
  each("basic", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo 'test'",
            description: "Echo test message",
          },
          ctx,
        )
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      },
    })
  })
})

describe("tool.bash permissions", () => {
  each("asks for bash permission with correct pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo hello")
      },
    })
  })

  each("asks for bash permission with multiple commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo foo && echo bar",
            description: "Echo twice",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("bash")
        expect(requests[0].patterns).toContain("echo foo")
        expect(requests[0].patterns).toContain("echo bar")
      },
    })
  })

  for (const item of ps) {
    test(
      `parses PowerShell conditionals for permission prompts [${item.label}]`,
      withShell(item, async () => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const bash = await BashTool.init()
            const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
            const testCtx = {
              ...ctx,
              ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                requests.push(req)
              },
            }
            await bash.execute(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              testCtx,
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.patterns).not.toContain("0")
            expect(bashReq!.always).toContain("Write-Host *")
            expect(bashReq!.always).not.toContain("0 *")
          },
        })
      }),
    )
  }

  if (win) {
    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell aliases [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await BashTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await bash.execute(
                {
                  command: `cat ${win}/win.ini`,
                  description: "Read Windows ini",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell cmdlets [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const bash = await BashTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await bash.execute(
                {
                  command: `Get-Content ${win}/win.ini`,
                  description: "Read Windows ini",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            },
          })
        }),
      )
    }
  }

  each("asks for external_directory permission when cd to parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd ../",
            description: "Change to parent directory",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
      },
    })
  })

  each("asks for external_directory permission when workdir is outside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "echo ok",
            workdir: os.tmpdir(),
            description: "Echo from temp dir",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(path.join(os.tmpdir(), "*"))
      },
    })
  })

  if (process.platform === "win32") {
    for (const item of shells) {
      test(
        `normalizes external_directory workdir variants on Windows [${item.label}]`,
        withShell(item, async () => {
          await using outerTmp = await tmpdir()
          await using tmp = await tmpdir({ git: true })
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const bash = await BashTool.init()
              const want = Filesystem.normalizePathPattern(path.join(outerTmp.path, "*"))

              for (const dir of forms(outerTmp.path)) {
                const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
                const testCtx = {
                  ...ctx,
                  ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                    requests.push(req)
                  },
                }

                await bash.execute(
                  {
                    command: "echo ok",
                    workdir: dir,
                    description: "Echo from external dir",
                  },
                  testCtx,
                )

                const extDirReq = requests.find((r) => r.permission === "external_directory")
                expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                  dir,
                  patterns: [want],
                  always: [want],
                })
              }
            },
          })
        }),
        { timeout: 20000 },
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "outside.txt"), "x")
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        const filepath = path.join(outerTmp.path, "outside.txt")
        await bash.execute(
          {
            command: `cat ${filepath}`,
            description: "Read external file",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        const expected = path.join(outerTmp.path, "*")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(expected)
        expect(extDirReq!.always).toContain(expected)
      },
    })
  })

  each("does not ask for external_directory permission when rm inside project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }

        await Bun.write(path.join(tmp.path, "tmpfile"), "x")

        await bash.execute(
          {
            command: `rm -rf ${path.join(tmp.path, "nested")}`,
            description: "remove nested dir",
          },
          testCtx,
        )

        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })

  each("includes always patterns for auto-approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "git log --oneline -5",
            description: "Git log",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].always.length).toBeGreaterThan(0)
        expect(requests[0].always.some((p) => p.endsWith("*"))).toBe(true)
      },
    })
  })

  each("does not ask for bash permission when command is cd only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute(
          {
            command: "cd .",
            description: "Stay in current directory",
          },
          testCtx,
        )
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeUndefined()
      },
    })
  })

  each("matches redirects in permission pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute({ command: "echo test > output.txt", description: "Redirect test output" }, testCtx)
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        expect(bashReq!.patterns).toContain("echo test > output.txt")
      },
    })
  })

  each("always pattern has space before wildcard to not include different commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const bash = await BashTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await bash.execute({ command: "ls -la", description: "List" }, testCtx)
        const bashReq = requests.find((r) => r.permission === "bash")
        expect(bashReq).toBeDefined()
        const pattern = bashReq!.always[0]
        expect(pattern).toBe("ls *")
      },
    })
  })
})

describe("tool.bash truncation", () => {
  each("truncates output exceeding line limit", async (item) => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await bash.execute(
          {
            command: fill("lines", lineCount),
            description: "Generate lines exceeding limit",
          },
          ctx,
        )
        mustTruncate(result, item)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  each("truncates output exceeding byte limit", async (item) => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await bash.execute(
          {
            command: fill("bytes", byteCount),
            description: "Generate bytes exceeding limit",
          },
          ctx,
        )
        mustTruncate(result, item)
        expect(result.output).toContain("truncated")
        expect(result.output).toContain("The tool call succeeded but the output was truncated")
      },
    })
  })

  each("does not truncate small output", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const result = await bash.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          ctx,
        )
        expect((result.metadata as any).truncated).toBe(false)
        expect(result.output).toContain("hello")
      },
    })
  })

  each("full output is saved to file when truncated", async (item) => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const bash = await BashTool.init()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await bash.execute(
          {
            command: fill("lines", lineCount),
            description: "Generate lines for file check",
          },
          ctx,
        )
        mustTruncate(result, item)

        const filepath = (result.metadata as any).outputPath
        expect(filepath).toBeTruthy()

        const saved = await Filesystem.readText(filepath)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      },
    })
  })
})
