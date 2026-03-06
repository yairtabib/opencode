import { Effect, Option } from "effect"

import {
  Account as AccountSchema,
  type AccessToken,
  AccountID,
  AccountService,
  AccountServiceError,
  type Login as LoginType,
  type PollResult as PollResultType,
  OrgID,
} from "./service"

export { AccessToken, AccountID, OrgID } from "./service"

import { runtime } from "@/effect/runtime"

type AccountServiceShape = ReturnType<typeof AccountService.of>

function runSync<A>(f: (service: AccountServiceShape) => Effect.Effect<A, AccountServiceError>) {
  return runtime.runSync(AccountService.use(f))
}

function runPromise<A>(f: (service: AccountServiceShape) => Effect.Effect<A, AccountServiceError>) {
  return runtime.runPromise(AccountService.use(f))
}

export namespace Account {
  export const Account = AccountSchema
  export type Account = AccountSchema
  export type Login = LoginType
  export type PollResult = PollResultType

  export function active(): Account | undefined {
    return Option.getOrUndefined(runSync((service) => service.active()))
  }

  export function list(): Account[] {
    return runSync((service) => service.list())
  }

  export function remove(accountID: AccountID) {
    runSync((service) => service.remove(accountID))
  }

  export function use(accountID: AccountID, orgID: OrgID | null) {
    runSync((service) => service.use(accountID, Option.fromNullishOr(orgID)))
  }

  export async function orgs(accountID: AccountID): Promise<{ id: string; name: string }[]> {
    return runPromise((service) => service.orgs(accountID))
  }

  export async function config(accountID: AccountID, orgID: OrgID): Promise<Record<string, unknown> | undefined> {
    const config = await runPromise((service) => service.config(accountID, orgID))
    return Option.getOrUndefined(config)
  }

  export async function token(accountID: AccountID): Promise<AccessToken | undefined> {
    const token = await runPromise((service) => service.token(accountID))
    return Option.getOrUndefined(token)
  }

  export async function login(url?: string): Promise<Login> {
    return runPromise((service) => service.login(url))
  }

  export async function poll(input: Login): Promise<PollResult> {
    return runPromise((service) => service.poll(input))
  }
}
