import { Clock, Effect, Layer, Option, Schema, ServiceMap } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

import { withTransientReadRetry } from "@/util/effect-http-client"
import { AccountRepo, type AccountRow } from "./repo"
import { AccessToken, Account, AccountID, AccountServiceError, Login, OrgID, type PollResult } from "./schema"

export { AccessToken, Account, AccountID, AccountServiceError, Login, OrgID, type PollResult } from "./schema"

class RemoteOrg extends Schema.Class<RemoteOrg>("RemoteOrg")({
  id: Schema.optional(OrgID),
  name: Schema.optional(Schema.String),
}) {}

const RemoteOrgs = Schema.Array(RemoteOrg)

class RemoteConfig extends Schema.Class<RemoteConfig>("RemoteConfig")({
  config: Schema.Record(Schema.String, Schema.Json),
}) {}

class TokenRefresh extends Schema.Class<TokenRefresh>("TokenRefresh")({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
}) {}

class DeviceCode extends Schema.Class<DeviceCode>("DeviceCode")({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
}) {}

class DeviceToken extends Schema.Class<DeviceToken>("DeviceToken")({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
}) {}

class User extends Schema.Class<User>("User")({
  id: Schema.optional(AccountID),
  email: Schema.optional(Schema.String),
}) {}

const ClientId = Schema.Struct({ client_id: Schema.String })

const DeviceTokenRequest = Schema.Struct({
  grant_type: Schema.String,
  device_code: Schema.String,
  client_id: Schema.String,
})

const serverDefault = "https://web-14275-d60e67f5-pyqs0590.onporter.run"
const clientId = "opencode-cli"

const toAccountServiceError = (operation: string, message: string, cause?: unknown) =>
  new AccountServiceError({ operation, message, cause })

const mapAccountServiceError =
  (operation: string, message = "Account service operation failed") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccountServiceError, R> =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof AccountServiceError ? error : toAccountServiceError(operation, message, error),
      ),
    )

export class AccountService extends ServiceMap.Service<
  AccountService,
  {
    readonly active: () => Effect.Effect<Option.Option<Account>, AccountServiceError>
    readonly list: () => Effect.Effect<Account[], AccountServiceError>
    readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountServiceError>
    readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountServiceError>
    readonly orgs: (accountID: AccountID) => Effect.Effect<{ id: string; name: string }[], AccountServiceError>
    readonly config: (
      accountID: AccountID,
      orgID: OrgID,
    ) => Effect.Effect<Option.Option<Record<string, unknown>>, AccountServiceError>
    readonly token: (accountID: AccountID) => Effect.Effect<Option.Option<AccessToken>, AccountServiceError>
    readonly login: (url?: string) => Effect.Effect<Login, AccountServiceError>
    readonly poll: (input: Login) => Effect.Effect<PollResult, AccountServiceError>
  }
>()("@opencode/Account") {
  static readonly layer: Layer.Layer<AccountService, never, AccountRepo | HttpClient.HttpClient> = Layer.effect(
    AccountService,
    Effect.gen(function* () {
      const repo = yield* AccountRepo
      const http = yield* HttpClient.HttpClient
      const httpRead = withTransientReadRetry(http)

      const execute = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
        http.execute(request).pipe(mapAccountServiceError(operation, "HTTP request failed"))

      const executeRead = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
        httpRead.execute(request).pipe(mapAccountServiceError(operation, "HTTP request failed"))

      const executeEffect = <E>(operation: string, request: Effect.Effect<HttpClientRequest.HttpClientRequest, E>) =>
        request.pipe(
          Effect.flatMap((req) => http.execute(req)),
          mapAccountServiceError(operation, "HTTP request failed"),
        )

      const okOrNone = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
        HttpClientResponse.filterStatusOk(response).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError"
              ? Effect.succeed(Option.none<HttpClientResponse.HttpClientResponse>())
              : Effect.fail(error),
          ),
          mapAccountServiceError(operation),
        )

      const tokenForRow = Effect.fn("AccountService.tokenForRow")(function* (found: AccountRow) {
        const now = yield* Clock.currentTimeMillis
        if (found.token_expiry && found.token_expiry > now) return Option.some(AccessToken.make(found.access_token))

        const response = yield* execute(
          "token.refresh",
          HttpClientRequest.post(`${found.url}/oauth/token`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyUrlParams({
              grant_type: "refresh_token",
              refresh_token: found.refresh_token,
            }),
          ),
        )

        const ok = yield* okOrNone("token.refresh", response)
        if (Option.isNone(ok)) return Option.none()

        const parsed = yield* HttpClientResponse.schemaBodyJson(TokenRefresh)(ok.value).pipe(
          mapAccountServiceError("token.refresh", "Failed to decode response"),
        )

        const expiry = Option.fromNullishOr(parsed.expires_in).pipe(Option.map((e) => now + e * 1000))

        yield* repo.persistToken(
          AccountID.make(found.id),
          parsed.access_token,
          parsed.refresh_token ?? found.refresh_token,
          expiry,
        )

        return Option.some(AccessToken.make(parsed.access_token))
      })

      const resolveAccess = Effect.fn("AccountService.resolveAccess")(function* (accountID: AccountID) {
        const maybeAccount = yield* repo.getRow(accountID)
        if (Option.isNone(maybeAccount)) return Option.none<{ account: AccountRow; accessToken: AccessToken }>()

        const account = maybeAccount.value
        const accessToken = yield* tokenForRow(account)
        if (Option.isNone(accessToken)) return Option.none<{ account: AccountRow; accessToken: AccessToken }>()

        return Option.some({ account, accessToken: accessToken.value })
      })

      const token = Effect.fn("AccountService.token")((accountID: AccountID) =>
        resolveAccess(accountID).pipe(Effect.map(Option.map((r) => r.accessToken))),
      )

      const orgs = Effect.fn("AccountService.orgs")(function* (accountID: AccountID) {
        const resolved = yield* resolveAccess(accountID)
        if (Option.isNone(resolved)) return []

        const { account, accessToken } = resolved.value

        const response = yield* executeRead(
          "orgs",
          HttpClientRequest.get(`${account.url}/api/orgs`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(accessToken),
          ),
        )

        const ok = yield* okOrNone("orgs", response)
        if (Option.isNone(ok)) return []

        const orgs = yield* HttpClientResponse.schemaBodyJson(RemoteOrgs)(ok.value).pipe(
          mapAccountServiceError("orgs", "Failed to decode response"),
        )
        return orgs.map((org) => ({ id: org.id ?? "", name: org.name ?? "" }))
      })

      const config = Effect.fn("AccountService.config")(function* (accountID: AccountID, orgID: OrgID) {
        const resolved = yield* resolveAccess(accountID)
        if (Option.isNone(resolved)) return Option.none()

        const { account, accessToken } = resolved.value

        const response = yield* executeRead(
          "config",
          HttpClientRequest.get(`${account.url}/api/config`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(accessToken),
            HttpClientRequest.setHeaders({ "x-org-id": orgID }),
          ),
        )

        const ok = yield* okOrNone("config", response)
        if (Option.isNone(ok)) return Option.none()

        const parsed = yield* HttpClientResponse.schemaBodyJson(RemoteConfig)(ok.value).pipe(
          mapAccountServiceError("config", "Failed to decode response"),
        )
        return Option.some(parsed.config)
      })

      const login = Effect.fn("AccountService.login")(function* (url?: string) {
        const server = url ?? serverDefault

        const response = yield* executeEffect(
          "login",
          HttpClientRequest.post(`${server}/auth/device/code`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.schemaBodyJson(ClientId)({ client_id: clientId }),
          ),
        )

        const ok = yield* okOrNone("login", response)
        if (Option.isNone(ok)) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* Effect.fail(
            toAccountServiceError("login", `Failed to initiate device flow: ${body || response.status}`),
          )
        }

        const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceCode)(ok.value).pipe(
          mapAccountServiceError("login", "Failed to decode response"),
        )
        return {
          code: parsed.device_code,
          user: parsed.user_code,
          url: `${server}${parsed.verification_uri_complete}`,
          server,
          expiry: parsed.expires_in,
          interval: parsed.interval,
        }
      })

      const poll = Effect.fn("AccountService.poll")(function* (input: Login) {
        const response = yield* executeEffect(
          "poll",
          HttpClientRequest.post(`${input.server}/auth/device/token`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.schemaBodyJson(DeviceTokenRequest)({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: input.code,
              client_id: clientId,
            }),
          ),
        )

        const parsed = yield* HttpClientResponse.schemaBodyJson(DeviceToken)(response).pipe(
          mapAccountServiceError("poll", "Failed to decode response"),
        )

        if (!parsed.access_token) {
          if (parsed.error === "authorization_pending") return { type: "pending" } as const
          if (parsed.error === "slow_down") return { type: "slow" } as const
          if (parsed.error === "expired_token") return { type: "expired" } as const
          if (parsed.error === "access_denied") return { type: "denied" } as const
          return { type: "error", msg: parsed.error ?? JSON.stringify(parsed) } as const
        }

        const access = parsed.access_token

        const fetchUser = executeRead(
          "poll.user",
          HttpClientRequest.get(`${input.server}/api/user`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(access),
          ),
        ).pipe(
          Effect.flatMap((r) =>
            HttpClientResponse.schemaBodyJson(User)(r).pipe(
              mapAccountServiceError("poll.user", "Failed to decode response"),
            ),
          ),
        )

        const fetchOrgs = executeRead(
          "poll.orgs",
          HttpClientRequest.get(`${input.server}/api/orgs`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(access),
          ),
        ).pipe(
          Effect.flatMap((r) =>
            HttpClientResponse.schemaBodyJson(RemoteOrgs)(r).pipe(
              mapAccountServiceError("poll.orgs", "Failed to decode response"),
            ),
          ),
        )

        const [user, remoteOrgs] = yield* Effect.all([fetchUser, fetchOrgs], { concurrency: 2 })

        const userId = user.id
        const userEmail = user.email

        if (!userId || !userEmail) {
          return { type: "error", msg: "No id or email in response" } as const
        }

        const firstOrgID = remoteOrgs.length > 0 ? Option.fromNullishOr(remoteOrgs[0].id) : Option.none()

        const now = yield* Clock.currentTimeMillis
        const expiry = now + (parsed.expires_in ?? 0) * 1000
        const refresh = parsed.refresh_token ?? ""

        yield* repo.persistAccount({
          id: userId,
          email: userEmail,
          url: input.server,
          accessToken: access,
          refreshToken: refresh,
          expiry,
          orgID: firstOrgID,
        })

        return { type: "success", email: userEmail } as const
      })

      return AccountService.of({
        active: repo.active,
        list: repo.list,
        remove: repo.remove,
        use: repo.use,
        orgs,
        config,
        token,
        login,
        poll,
      })
    }),
  )

  static readonly defaultLayer = AccountService.layer.pipe(Layer.provide(AccountRepo.layer), Layer.provide(FetchHttpClient.layer))
}
