import { cmd } from "./cmd"
import { Duration, Effect, Match, Option } from "effect"
import { UI } from "../ui"
import { runtime } from "@/effect/runtime"
import { AccountService, OrgID, PollExpired, type PollResult } from "@/account/service"
import { type AccountServiceError } from "@/account/schema"
import * as Prompt from "../effect/prompt"
import open from "open"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const loginEffect = Effect.fn("login")(function* (url?: string) {
  const service = yield* AccountService

  yield* Prompt.intro("Log in")
  const login = yield* service.login(url)

  yield* Prompt.log.info("Go to: " + login.url)
  yield* Prompt.log.info("Enter code: " + login.user)
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  yield* s.start("Waiting for authorization...")

  const poll = (wait: number): Effect.Effect<PollResult, AccountServiceError> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* service.poll(login)
      if (result._tag === "PollPending") return yield* poll(wait)
      if (result._tag === "PollSlow") return yield* poll(wait + 5000)
      return result
    })

  const result = yield* poll(login.interval * 1000).pipe(
    Effect.timeout(Duration.seconds(login.expiry)),
    Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
  )

  yield* Match.valueTags(result, {
    PollSuccess: (r) =>
      Effect.gen(function* () {
        yield* s.stop("Logged in as " + r.email)
        yield* Prompt.outro("Done")
      }),
    PollExpired: () => s.stop("Device code expired", 1),
    PollDenied: () => s.stop("Authorization denied", 1),
    PollError: (r) => s.stop("Error: " + String(r.cause), 1),
    PollPending: () => s.stop("Unexpected state", 1),
    PollSlow: () => s.stop("Unexpected state", 1),
  })
})

const logoutEffect = Effect.fn("logout")(function* (email?: string) {
  const service = yield* AccountService

  if (email) {
    const accounts = yield* service.list()
    const match = accounts.find((a) => a.email === email)
    if (!match) return yield* println("Account not found: " + email)
    yield* service.remove(match.id)
    yield* println("Logged out from " + email)
    return
  }

  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println("Not logged in")
  yield* service.remove(active.value.id)
  yield* println("Logged out from " + active.value.email)
})

const switchEffect = Effect.fn("switch")(function* () {
  const service = yield* AccountService

  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println("Not logged in")

  const orgs = yield* service.orgs(active.value.id)
  if (orgs.length === 0) return yield* println("No orgs found")

  yield* Prompt.intro("Switch org")

  const opts = orgs.map((o) => ({
    value: o.id,
    label: o.id === active.value.org_id ? o.name + UI.Style.TEXT_DIM + " (active)" : o.name,
  }))

  const selected = yield* Prompt.select<OrgID>({ message: "Select org", options: opts })
  if (Option.isNone(selected)) return

  yield* service.use(active.value.id, Option.some(selected.value))
  yield* Prompt.outro("Switched to " + orgs.find((o) => o.id === selected.value)?.name)
})

const orgsEffect = Effect.fn("orgs")(function* () {
  const service = yield* AccountService

  const accounts = yield* service.list()
  if (accounts.length === 0) return yield* println("No accounts found")

  const allOrgs = yield* Effect.all(
    accounts.map((account) =>
      service.orgs(account.id).pipe(Effect.map((orgs) => orgs.map((org) => ({ org, account })))),
    ),
    { concurrency: "unbounded" },
  )

  for (const { org, account } of allOrgs.flat()) {
    yield* println([org.name, account.email, org.id].join("\t"))
  }
})

export const LoginCommand = cmd({
  command: "login [url]",
  describe: "log in to an opencode account",
  builder: (yargs) =>
    yargs.positional("url", {
      describe: "server URL",
      type: "string",
    }),
  async handler(args) {
    UI.empty()
    await runtime.runPromise(loginEffect(args.url))
  },
})

export const LogoutCommand = cmd({
  command: "logout [email]",
  describe: "log out from an account",
  builder: (yargs) =>
    yargs.positional("email", {
      describe: "account email to log out from",
      type: "string",
    }),
  async handler(args) {
    UI.empty()
    await runtime.runPromise(logoutEffect(args.email))
  },
})

export const SwitchCommand = cmd({
  command: "switch",
  describe: "switch active org",
  async handler() {
    UI.empty()
    await runtime.runPromise(switchEffect())
  },
})

export const OrgsCommand = cmd({
  command: "orgs",
  aliases: ["org"],
  describe: "list all orgs",
  async handler() {
    UI.empty()
    await runtime.runPromise(orgsEffect())
  },
})
