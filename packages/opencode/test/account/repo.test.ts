import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"

import { AccountRepo } from "../../src/account/repo"
import { AccountID, OrgID } from "../../src/account/schema"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../fixture/effect"

const reset = Layer.effectDiscard(Effect.promise(() => resetDatabase()))

const it = testEffect(Layer.merge(AccountRepo.layer, reset))

it.effect(
  "list returns empty when no accounts exist",
  Effect.gen(function* () {
    const accounts = yield* AccountRepo.use((r) => r.list())
    expect(accounts).toEqual([])
  }),
)

it.effect(
  "active returns none when no accounts exist",
  Effect.gen(function* () {
    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.isNone(active)).toBe(true)
  }),
)

it.effect(
  "persistAccount inserts and getRow retrieves",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")
    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_123",
        refreshToken: "rt_456",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.isSome(row)).toBe(true)
    const value = Option.getOrThrow(row)
    expect(value.id).toBe("user-1")
    expect(value.email).toBe("test@example.com")
    expect(value.org_id).toBe("org-1")
  }),
)

it.effect(
  "persistAccount sets active account (clears previous org_ids)",
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: "at_2",
        refreshToken: "rt_2",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const row1 = yield* AccountRepo.use((r) => r.getRow(id1))
    expect(Option.getOrThrow(row1).org_id).toBeNull()

    const active = yield* AccountRepo.use((r) => r.active())
    expect(Option.isSome(active)).toBe(true)
    expect(Option.getOrThrow(active).id).toBe(AccountID.make("user-2"))
  }),
)

it.effect(
  "list returns all accounts",
  Effect.gen(function* () {
    const id1 = AccountID.make("user-1")
    const id2 = AccountID.make("user-2")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: "at_2",
        refreshToken: "rt_2",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    const accounts = yield* AccountRepo.use((r) => r.list())
    expect(accounts.length).toBe(2)
    expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
  }),
)

it.effect(
  "remove deletes an account",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use((r) => r.remove(id))

    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.isNone(row)).toBe(true)
  }),
)

it.effect(
  "use sets org_id on account",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use((r) => r.use(id, Option.some(OrgID.make("org-99"))))
    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.getOrThrow(row).org_id).toBe("org-99")

    yield* AccountRepo.use((r) => r.use(id, Option.none()))
    const row2 = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.getOrThrow(row2).org_id).toBeNull()
  }),
)

it.effect(
  "persistToken updates token fields",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "old_token",
        refreshToken: "old_refresh",
        expiry: 1000,
        orgID: Option.none(),
      }),
    )

    const expiry = Date.now() + 7200_000
    yield* AccountRepo.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: "new_token",
        refreshToken: "new_refresh",
        expiry: Option.some(expiry),
      }),
    )

    const row = yield* AccountRepo.use((r) => r.getRow(id))
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe("new_token")
    expect(value.refresh_token).toBe("new_refresh")
    expect(value.token_expiry).toBe(expiry)
  }),
)

it.effect(
  "persistToken with no expiry sets token_expiry to null",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "old_token",
        refreshToken: "old_refresh",
        expiry: 1000,
        orgID: Option.none(),
      }),
    )

    yield* AccountRepo.use((r) =>
      r.persistToken({
        accountID: id,
        accessToken: "new_token",
        refreshToken: "new_refresh",
        expiry: Option.none(),
      }),
    )

    const row = yield* AccountRepo.use((r) => r.getRow(id))
    expect(Option.getOrThrow(row).token_expiry).toBeNull()
  }),
)

it.effect(
  "persistAccount upserts on conflict",
  Effect.gen(function* () {
    const id = AccountID.make("user-1")

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_v1",
        refreshToken: "rt_v1",
        expiry: 1000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    )

    yield* AccountRepo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_v2",
        refreshToken: "rt_v2",
        expiry: 2000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    )

    const accounts = yield* AccountRepo.use((r) => r.list())
    expect(accounts.length).toBe(1)

    const row = yield* AccountRepo.use((r) => r.getRow(id))
    const value = Option.getOrThrow(row)
    expect(value.access_token).toBe("at_v2")
    expect(value.org_id).toBe("org-2")
  }),
)

it.effect(
  "getRow returns none for nonexistent account",
  Effect.gen(function* () {
    const row = yield* AccountRepo.use((r) => r.getRow(AccountID.make("nope")))
    expect(Option.isNone(row)).toBe(true)
  }),
)
