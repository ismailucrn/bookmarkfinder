# Read-only ingestion workers

The orchestrator calls `fetchGithubStars({ token, fetchImpl?, signal? })` or `fetchXBookmarks({ token, userId, fetchImpl?, signal? })`. Both return `{ entries, complete, warnings }` and throw sanitized errors for network/list API failures. Tests inject fetch; no real account is accessed by the test suite.

`complete` means the provider's visible list was enumerated through its terminal page within local bounds. It is **not** a guarantee of historical records the provider no longer exposes or an atomic snapshot while a user is changing their saves. Only a `complete:true` list is eligible to replace an existing source snapshot; this is an enumeration check, not a transaction guarantee. Invalid entries, partial X API errors, inconsistent X counts, unsafe/repeated pagination and page limits all set `complete:false`; the caller must retain its prior snapshot. A later-page HTTP failure throws so its partial data cannot accidentally replace the snapshot.

## Concurrent provider edits

GitHub stars use mutable offset pages. Removing a star during pagination can shift a later item into an already-read page; deduplication alone cannot detect that missing item. After an otherwise complete multi-page enumeration, the connector refetches the first page once and compares its ordered repository IDs, whether a next page exists, and the last-page number when provided. A changed signal yields `complete:false`, so the orchestrator retains its prior source snapshot. Verification network/API failures throw rather than certify the snapshot. Already incomplete imports do not spend the extra verification request.

This bounded check detects common drift but cannot prove atomicity: edits confined to later pages, changes that cancel one another, or changes after verification may remain unseen. Neither connector promises an immutable historical snapshot or prevents concurrent edits at the provider. Stronger production deletion guarantees require retaining missing entries until absence is confirmed in later stable syncs, or a provider-supported immutable snapshot/cursor. Synchronize while saves are stable for this MVP.

## Provider setup

- GitHub: supply a user token for the intended account; the worker uses `GET https://api.github.com/user/starred` with the star timestamp media type. Current fine-grained permissions are **Starring: read**; private README access additionally requires **Contents: read** on accessible repositories. No write scopes are required. GitHub API version is pinned to `2026-03-10`.
- X: supply an OAuth 2.0 PKCE user access token and that authenticated user's numeric ID. X's quickstart lists `bookmark.read`, `tweet.read` and `users.read` (for user expansions). This connector requests no user expansion. Developer application access and credits are external prerequisites; no OAuth UI, token refresh or billing setup is included. An app-only bearer token is insufficient for private bookmarks.

GitHub entries include repository descriptions, language, topics and optional README text. Only whitelisted fields are persisted; upstream clone tokens and arbitrary provider URLs are discarded. GitHub `starred_at` becomes `savedAt` when present. X `savedAt` is `null`: post publication time is not a bookmark timestamp. Its publication time is retained as `metadata.publishedAt`. Long post text is preferred when available; external links, images, threads and articles are not fetched.

## Bounds and safety

Each source enumerates at most 10 list pages of 100 results (1,000 entries). An otherwise complete multi-page GitHub import makes one additional first-page verification request; X may make one additional HTTP 400 compatibility request. Each source therefore makes at most 11 list requests. GitHub additionally enriches at most the newest 100 listed repositories with four concurrent README requests. Every request has a 10-second deadline; cancellation is supported. Lists are at most 2 MiB each. README streams stop at 64 KiB. Post text is capped at 32,000 characters. There are no outage, authorization or rate-limit retries. X has only the single bounded HTTP 400 compatibility fallback described below, preventing uncontrolled paid calls. A rate-limited list request fails; a rate-limited README yields an enrichment warning. The total ingestion duration can span several request deadlines.

Missing READMEs (404) are normal. Failed or truncated READMEs and the 100-repository enrichment bound produce explicit warnings. These do not make an otherwise fully enumerated list incomplete: all listed repositories remain searchable through their metadata. A subsequent sync may re-fetch content; there is no conditional request/cache implementation yet.

All network URLs are built internally using `api.github.com` or `api.x.com`; repository and user IDs are validated. GitHub Link headers serve only as pagination signals and cannot change the actual next request URL. X cursors are encoded as query parameters. Redirect following is disabled to prevent credential forwarding. Request credentials occur only in Authorization headers, are never attached to entries, and exact credential echoes in free-text provider content are redacted. Errors and warnings never reproduce request headers, upstream bodies or raw exceptions.

X documentation currently has a naming discrepancy: the generated endpoint reference lists `post.fields`/`note_post`, while the executable bookmarks quickstart uses `tweet.fields`. This worker prefers the current reference using `post.fields=created_at,lang,note_post`. On the first HTTP 400 only, it retries the same page once using legacy `tweet.fields=created_at,lang,note_tweet`, then keeps the legacy spelling for remaining pages. A second HTTP 400 fails normally; other errors are never retried. Response parsing prefers `note_post.text` and also accepts `note_tweet.text`. Verify live provider entitlement and parameter acceptance with the user's account before production rollout. No credentialed live integration was performed while implementing the MVP.

## Official references checked

- [GitHub authenticated stars](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-the-authenticated-user)
- [GitHub README API and raw media](https://docs.github.com/en/rest/repos/contents#get-a-repository-readme)
- [X bookmarks quickstart and read scopes](https://docs.x.com/x-api/posts/bookmarks/quickstart/bookmarks-lookup)
- [X generated bookmarks reference and pagination](https://docs.x.com/x-api/users/get-bookmarks)

Run the provider-independent tests with `node --test test/connectors.test.mjs` from the project directory.
