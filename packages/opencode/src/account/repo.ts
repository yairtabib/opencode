import { eq, isNotNull } from "drizzle-orm"
import { Effect, Layer, Option, Schema, ServiceMap } from "effect"

import { Database } from "@/storage/db"
import { AccountTable } from "./account.sql"
import { Account, AccountID, AccountServiceError, OrgID } from "./schema"

export type AccountRow = (typeof AccountTable)["$inferSelect"]

const decodeAccount = Schema.decodeUnknownSync(Account)

type DbClient = Parameters<typeof Database.use>[0] extends (db: infer T) => unknown ? T : never

const db = <A>(run: (db: DbClient) => A) =>
  Effect.try({
    try: () => Database.use(run),
    catch: (cause) => new AccountServiceError({ operation: "db", message: "Database operation failed", cause }),
  })

const fromRow = (row: AccountRow) => decodeAccount(row)

export class AccountRepo extends ServiceMap.Service<
  AccountRepo,
  {
    readonly active: () => Effect.Effect<Option.Option<Account>, AccountServiceError>
    readonly list: () => Effect.Effect<Account[], AccountServiceError>
    readonly remove: (accountID: AccountID) => Effect.Effect<void, AccountServiceError>
    readonly use: (accountID: AccountID, orgID: Option.Option<OrgID>) => Effect.Effect<void, AccountServiceError>
    readonly getRow: (accountID: AccountID) => Effect.Effect<Option.Option<AccountRow>, AccountServiceError>
    readonly persistToken: (input: {
      accountID: AccountID
      accessToken: string
      refreshToken: string
      expiry: Option.Option<number>
    }) => Effect.Effect<void, AccountServiceError>
    readonly persistAccount: (input: {
      id: AccountID
      email: string
      url: string
      accessToken: string
      refreshToken: string
      expiry: number
      orgID: Option.Option<OrgID>
    }) => Effect.Effect<void, AccountServiceError>
  }
>()("@opencode/AccountRepo") {
  static readonly layer: Layer.Layer<AccountRepo> = Layer.succeed(
    AccountRepo,
    AccountRepo.of({
      active: Effect.fn("AccountRepo.active")(() =>
        db((db) => db.select().from(AccountTable).where(isNotNull(AccountTable.org_id)).get()).pipe(
          Effect.map((row) => (row ? Option.some(fromRow(row)) : Option.none())),
        ),
      ),

      list: Effect.fn("AccountRepo.list")(() => db((db) => db.select().from(AccountTable).all().map(fromRow))),

      remove: Effect.fn("AccountRepo.remove")((accountID: AccountID) =>
        db((db) => db.delete(AccountTable).where(eq(AccountTable.id, accountID)).run()).pipe(Effect.asVoid),
      ),

      use: Effect.fn("AccountRepo.use")((accountID: AccountID, orgID: Option.Option<OrgID>) =>
        db((db) =>
          db
            .update(AccountTable)
            .set({ org_id: Option.getOrNull(orgID) })
            .where(eq(AccountTable.id, accountID))
            .run(),
        ).pipe(Effect.asVoid),
      ),

      getRow: Effect.fn("AccountRepo.getRow")((accountID: AccountID) =>
        db((db) => db.select().from(AccountTable).where(eq(AccountTable.id, accountID)).get()).pipe(
          Effect.map(Option.fromNullishOr),
        ),
      ),

      persistToken: Effect.fn("AccountRepo.persistToken")((input) =>
        db((db) =>
          db
            .update(AccountTable)
            .set({
              access_token: input.accessToken,
              refresh_token: input.refreshToken,
              token_expiry: Option.getOrNull(input.expiry),
            })
            .where(eq(AccountTable.id, input.accountID))
            .run(),
        ).pipe(Effect.asVoid),
      ),

      persistAccount: Effect.fn("AccountRepo.persistAccount")((input) => {
        const orgID = Option.getOrNull(input.orgID)
        return Effect.try({
          try: () =>
            Database.transaction((tx) => {
              tx.update(AccountTable).set({ org_id: null }).where(isNotNull(AccountTable.org_id)).run()
              tx.insert(AccountTable)
                .values({
                  id: input.id,
                  email: input.email,
                  url: input.url,
                  access_token: input.accessToken,
                  refresh_token: input.refreshToken,
                  token_expiry: input.expiry,
                  org_id: orgID,
                })
                .onConflictDoUpdate({
                  target: AccountTable.id,
                  set: {
                    access_token: input.accessToken,
                    refresh_token: input.refreshToken,
                    token_expiry: input.expiry,
                    org_id: orgID,
                  },
                })
                .run()
            }),
          catch: (cause) => new AccountServiceError({ operation: "db", message: "Database operation failed", cause }),
        }).pipe(Effect.asVoid)
      }),
    }),
  )
}
