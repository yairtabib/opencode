import { Schema } from "effect"

import { withStatics } from "@/util/schema"

export const AccountID = Schema.String.pipe(
  Schema.brand("AccountId"),
  withStatics((s) => ({ make: (id: string) => s.makeUnsafe(id) })),
)
export type AccountID = Schema.Schema.Type<typeof AccountID>

export const OrgID = Schema.String.pipe(
  Schema.brand("OrgId"),
  withStatics((s) => ({ make: (id: string) => s.makeUnsafe(id) })),
)
export type OrgID = Schema.Schema.Type<typeof OrgID>

export const AccessToken = Schema.String.pipe(
  Schema.brand("AccessToken"),
  withStatics((s) => ({ make: (token: string) => s.makeUnsafe(token) })),
)
export type AccessToken = Schema.Schema.Type<typeof AccessToken>

export class Account extends Schema.Class<Account>("Account")({
  id: AccountID,
  email: Schema.String,
  url: Schema.String,
  org_id: Schema.NullOr(OrgID),
}) {}

export class AccountServiceError extends Schema.TaggedErrorClass<AccountServiceError>()("AccountServiceError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export class Login extends Schema.Class<Login>("Login")({
  code: Schema.String,
  user: Schema.String,
  url: Schema.String,
  server: Schema.String,
  expiry: Schema.Number,
  interval: Schema.Number,
}) {}

export type PollResult =
  | { type: "success"; email: string }
  | { type: "pending" }
  | { type: "slow" }
  | { type: "expired" }
  | { type: "denied" }
  | { type: "error"; msg: string }
