import { describe, expect, test } from "bun:test"
import { realpathSync } from "fs"
import os from "os"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { ShellTool } from "../../src/tool/shell"
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
const full = (p: string) => {
  if (process.platform !== "win32") return p
  const file = path.win32.normalize(path.win32.resolve(p))
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}
const pat = (dir: string) => (process.platform === "win32" ? path.join(full(dir), "*") : path.join(dir, "*"))
const kind = () => Shell.name(process.env.SHELL || "")
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
  const file = full(dir)
  const slash = file.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([file, slash, root, root.toLowerCase()]))
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

describe("tool.shell", () => {
  each("basic", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await ShellTool.init()
        const result = await tool.execute(
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

describe("tool.shell permissions", () => {
  each("asks for shell permission with correct pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
          {
            command: "echo hello",
            description: "Echo hello",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("shell")
        expect(requests[0].patterns).toContain("echo hello")
      },
    })
  })

  each("asks for shell permission with multiple commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
          {
            command: "echo foo && echo bar",
            description: "Echo twice",
          },
          testCtx,
        )
        expect(requests.length).toBe(1)
        expect(requests[0].permission).toBe("shell")
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
            const tool = await ShellTool.init()
            const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
            const testCtx = {
              ...ctx,
              ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                requests.push(req)
              },
            }
            await tool.execute(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
                description: "Check PowerShell conditional",
              },
              testCtx,
            )
            const shellReq = requests.find((r) => r.permission === "shell")
            expect(shellReq).toBeDefined()
            expect(shellReq!.patterns).toContain("Write-Host foo")
            expect(shellReq!.patterns).toContain("Write-Host bar")
            expect(shellReq!.patterns).not.toContain("0")
            expect(shellReq!.always).toContain("Write-Host *")
            expect(shellReq!.always).not.toContain("0 *")
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
              const tool = await ShellTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await tool.execute(
                {
                  command: `cat ${win}/win.ini`,
                  description: "Read Windows ini",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(pat(process.env.WINDIR!))
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
              const tool = await ShellTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await tool.execute(
                {
                  command: `Get-Content ${win}/win.ini`,
                  description: "Read Windows ini",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(pat(process.env.WINDIR!))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `asks for external_directory permission for PowerShell env paths [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const tool = await ShellTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await tool.execute(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                  description: "Read Windows ini from env",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(pat(process.env.WINDIR!))
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `treats Set-Location like cd for permissions [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const tool = await ShellTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await tool.execute(
                {
                  command: `Set-Location ${win}`,
                  description: "Change location",
                },
                testCtx,
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const shellReq = requests.find((r) => r.permission === "shell")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(pat(process.env.WINDIR!))
              expect(shellReq).toBeUndefined()
            },
          })
        }),
      )
    }

    for (const item of ps) {
      test(
        `does not add nested PowerShell expressions to permission prompts [${item.label}]`,
        withShell(item, async () => {
          await Instance.provide({
            directory: projectRoot,
            fn: async () => {
              const tool = await ShellTool.init()
              const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
              const testCtx = {
                ...ctx,
                ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                  requests.push(req)
                },
              }
              await tool.execute(
                {
                  command: "Write-Output ('a' * 3)",
                  description: "Write repeated text",
                },
                testCtx,
              )
              const shellReq = requests.find((r) => r.permission === "shell")
              expect(shellReq).toBeDefined()
              expect(shellReq!.patterns).not.toContain("a * 3")
              expect(shellReq!.always).not.toContain("a *")
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
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
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
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
          {
            command: "echo ok",
            workdir: os.tmpdir(),
            description: "Echo from temp dir",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(pat(os.tmpdir()))
      },
    })
  })

  if (process.platform === "win32") {
    for (const item of shells) {
      test(
        `normalizes external_directory workdir variants on Windows [${item.label}]`,
        withShell(item, async () => {
          // This test only cares about the permission payload, so stop before the
          // shell spawns to avoid slow Windows PowerShell startup dominating CI.
          const err = new Error("stop after permission")
          await using outerTmp = await tmpdir()
          await using tmp = await tmpdir({ git: true })
          await Instance.provide({
            directory: tmp.path,
            fn: async () => {
              const tool = await ShellTool.init()
              const want = pat(outerTmp.path)

              for (const dir of forms(outerTmp.path)) {
                const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
                const testCtx = {
                  ...ctx,
                  ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
                    requests.push(req)
                    throw err
                  },
                }

                await expect(
                  tool.execute(
                    {
                      command: "echo ok",
                      workdir: dir,
                      description: "Echo from external dir",
                    },
                    testCtx,
                  ),
                ).rejects.toThrow(err.message)

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
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        const filepath = path.join(outerTmp.path, "outside.txt")
        await tool.execute(
          {
            command: `cat ${filepath}`,
            description: "Read external file",
          },
          testCtx,
        )
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        const expected = pat(outerTmp.path)
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
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }

        await Bun.write(path.join(tmp.path, "tmpfile"), "x")

        await tool.execute(
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
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
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

  each("does not ask for shell permission when command is cd only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute(
          {
            command: "cd .",
            description: "Stay in current directory",
          },
          testCtx,
        )
        const shellReq = requests.find((r) => r.permission === "shell")
        expect(shellReq).toBeUndefined()
      },
    })
  })

  each("matches redirects in permission pattern", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute({ command: "echo test > output.txt", description: "Redirect test output" }, testCtx)
        const shellReq = requests.find((r) => r.permission === "shell")
        expect(shellReq).toBeDefined()
        expect(shellReq!.patterns).toContain("echo test > output.txt")
      },
    })
  })

  each("always pattern has space before wildcard to not include different commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ShellTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await tool.execute({ command: "ls -la", description: "List" }, testCtx)
        const shellReq = requests.find((r) => r.permission === "shell")
        expect(shellReq).toBeDefined()
        const pattern = shellReq!.always[0]
        expect(pattern).toBe("ls *")
      },
    })
  })
})

describe("tool.shell truncation", () => {
  each("truncates output exceeding line limit", async (item) => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const tool = await ShellTool.init()
        const lineCount = Truncate.MAX_LINES + 500
        const result = await tool.execute(
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
        const tool = await ShellTool.init()
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = await tool.execute(
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
        const tool = await ShellTool.init()
        const result = await tool.execute(
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
        const tool = await ShellTool.init()
        const lineCount = Truncate.MAX_LINES + 100
        const result = await tool.execute(
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
