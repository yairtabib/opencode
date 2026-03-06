import { test, expect, afterEach, afterAll } from "bun:test"
import { Effect, ManagedRuntime, Option } from "effect"

import { AccountRepo } from "../../src/account/repo"
import { AccountID, OrgID } from "../../src/account/schema"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await resetDatabase()
})

afterAll(async () => {
  await runtime.dispose()
})

const runtime = ManagedRuntime.make(AccountRepo.layer)
const run = <A>(effect: Effect.Effect<A, unknown, AccountRepo>) => runtime.runPromise(effect)
const repo = AccountRepo

test("list returns empty when no accounts exist", async () => {
  const accounts = await run(repo.use((r) => r.list()))
  expect(accounts).toEqual([])
})

test("active returns none when no accounts exist", async () => {
  const active = await run(repo.use((r) => r.active()))
  expect(Option.isNone(active)).toBe(true)
})

test("persistAccount inserts and getRow retrieves", async () => {
  const id = AccountID.make("user-1")
  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_123",
        refreshToken: "rt_456",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    ),
  )

  const row = await run(repo.use((r) => r.getRow(id)))
  expect(Option.isSome(row)).toBe(true)
  const value = Option.getOrThrow(row)
  expect(value.id).toBe("user-1")
  expect(value.email).toBe("test@example.com")
  expect(value.org_id).toBe("org-1")
})

test("persistAccount sets active account (clears previous org_ids)", async () => {
  const id1 = AccountID.make("user-1")
  const id2 = AccountID.make("user-2")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "first@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    ),
  )

  await run(
    repo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "second@example.com",
        url: "https://control.example.com",
        accessToken: "at_2",
        refreshToken: "rt_2",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    ),
  )

  // First account should have org_id cleared
  const row1 = await run(repo.use((r) => r.getRow(id1)))
  expect(Option.getOrThrow(row1).org_id).toBeNull()

  // Second account should be active
  const active = await run(repo.use((r) => r.active()))
  expect(Option.isSome(active)).toBe(true)
  expect(Option.getOrThrow(active).id).toBe(AccountID.make("user-2"))
})

test("list returns all accounts", async () => {
  const id1 = AccountID.make("user-1")
  const id2 = AccountID.make("user-2")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id: id1,
        email: "a@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    ),
  )

  await run(
    repo.use((r) =>
      r.persistAccount({
        id: id2,
        email: "b@example.com",
        url: "https://control.example.com",
        accessToken: "at_2",
        refreshToken: "rt_2",
        expiry: Date.now() + 3600_000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    ),
  )

  const accounts = await run(repo.use((r) => r.list()))
  expect(accounts.length).toBe(2)
  expect(accounts.map((a) => a.email).sort()).toEqual(["a@example.com", "b@example.com"])
})

test("remove deletes an account", async () => {
  const id = AccountID.make("user-1")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    ),
  )

  await run(repo.use((r) => r.remove(id)))

  const row = await run(repo.use((r) => r.getRow(id)))
  expect(Option.isNone(row)).toBe(true)
})

test("use sets org_id on account", async () => {
  const id = AccountID.make("user-1")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_1",
        refreshToken: "rt_1",
        expiry: Date.now() + 3600_000,
        orgID: Option.none(),
      }),
    ),
  )

  // Set org
  await run(repo.use((r) => r.use(id, Option.some(OrgID.make("org-99")))))
  const row = await run(repo.use((r) => r.getRow(id)))
  expect(Option.getOrThrow(row).org_id).toBe("org-99")

  // Clear org
  await run(repo.use((r) => r.use(id, Option.none())))
  const row2 = await run(repo.use((r) => r.getRow(id)))
  expect(Option.getOrThrow(row2).org_id).toBeNull()
})

test("persistToken updates token fields", async () => {
  const id = AccountID.make("user-1")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "old_token",
        refreshToken: "old_refresh",
        expiry: 1000,
        orgID: Option.none(),
      }),
    ),
  )

  const newExpiry = Date.now() + 7200_000
  await run(repo.use((r) => r.persistToken({ accountID: id, accessToken: "new_token", refreshToken: "new_refresh", expiry: Option.some(newExpiry) })))

  const row = await run(repo.use((r) => r.getRow(id)))
  const value = Option.getOrThrow(row)
  expect(value.access_token).toBe("new_token")
  expect(value.refresh_token).toBe("new_refresh")
  expect(value.token_expiry).toBe(newExpiry)
})

test("persistToken with no expiry sets token_expiry to null", async () => {
  const id = AccountID.make("user-1")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "old_token",
        refreshToken: "old_refresh",
        expiry: 1000,
        orgID: Option.none(),
      }),
    ),
  )

  await run(repo.use((r) => r.persistToken({ accountID: id, accessToken: "new_token", refreshToken: "new_refresh", expiry: Option.none() })))

  const row = await run(repo.use((r) => r.getRow(id)))
  expect(Option.getOrThrow(row).token_expiry).toBeNull()
})

test("persistAccount upserts on conflict", async () => {
  const id = AccountID.make("user-1")

  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_v1",
        refreshToken: "rt_v1",
        expiry: 1000,
        orgID: Option.some(OrgID.make("org-1")),
      }),
    ),
  )

  // Upsert same id with new tokens
  await run(
    repo.use((r) =>
      r.persistAccount({
        id,
        email: "test@example.com",
        url: "https://control.example.com",
        accessToken: "at_v2",
        refreshToken: "rt_v2",
        expiry: 2000,
        orgID: Option.some(OrgID.make("org-2")),
      }),
    ),
  )

  const accounts = await run(repo.use((r) => r.list()))
  expect(accounts.length).toBe(1)

  const row = await run(repo.use((r) => r.getRow(id)))
  const value = Option.getOrThrow(row)
  expect(value.access_token).toBe("at_v2")
  expect(value.org_id).toBe("org-2")
})

test("getRow returns none for nonexistent account", async () => {
  const row = await run(repo.use((r) => r.getRow(AccountID.make("nope"))))
  expect(Option.isNone(row)).toBe(true)
})
