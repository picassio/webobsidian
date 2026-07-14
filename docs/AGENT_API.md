# WebObsidian Agent API (`/api/v1`)

REST API for AI agents to interact with the vault. Authenticated with an **API key**
created in **Settings → API Keys**. Pass it as either header:

```
Authorization: Bearer wok_xxx
X-API-Key: wok_xxx
```

Scopes: `read`, `write`, `search`. Rate limit: configurable (default 120 req/min/key).
Keys are also bound to one or more vault IDs. Select an authorized vault with
`X-WebObsidian-Vault-Id: vault_...`; omitting it selects the server default vault. A key receives 403 rather
than falling through to another vault when it lacks that vault grant. All `{path}` values are vault-relative (URL-encode slashes are fine, e.g. `Notes/Ideas.md`).

## Endpoints

| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| GET | `/api/v1/health` | – | Liveness check |
| GET | `/api/v1/notes?offset=&limit=` | read | List markdown notes (paginated) |
| GET | `/api/v1/notes/{path}` | read | Read a note + parsed metadata |
| PUT | `/api/v1/notes/{path}` | write | Revision-conditional create/update |
| PATCH | `/api/v1/notes/{path}` | write | Revision-conditional append |
| DELETE | `/api/v1/notes/{path}` | write | Revision-conditional move to trash |
| GET | `/api/v1/search?q=&limit=` | search | QMD search |
| GET | `/api/v1/backlinks?path=` | read | Notes linking to a path |
| GET | `/api/v1/tags` | read | All tags with counts |

## Safe write contract

Every mutation requires a positive, monotonically increasing `clientSequence` per API key and an
`idempotencyKey` (16–256 characters, reused unchanged only when retrying the exact same payload). Updating,
appending, or deleting an existing note also requires its `baseRevision`, returned by `GET /notes/{path}`.
Missing conditional metadata returns HTTP 428; a stale revision returns 409 and never overwrites current bytes.
Creating a path that does not exist omits `baseRevision`.

## Examples

```bash
KEY=wok_your_key_here
VAULT=vault_your_vault_id
BASE=http://localhost:8787/api/v1
AUTH=(-H "X-API-Key: $KEY" -H "X-WebObsidian-Vault-Id: $VAULT")

# list notes
curl "${AUTH[@]}" "$BASE/notes?limit=10"

# read a note
curl -H "X-API-Key: $KEY" "$BASE/notes/Welcome.md"

# create a new note
curl -X PUT -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"content":"# From the agent\n\nHello vault.","clientSequence":1,"idempotencyKey":"agent-create-generated-0001"}' \
  "$BASE/notes/Agent/Generated.md"

# append after GET reported revision 1
curl -X PATCH -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"append":"\n- a new bullet","baseRevision":1,"clientSequence":2,"idempotencyKey":"agent-append-generated-0002"}' \
  "$BASE/notes/Agent/Generated.md"

# search (fielded queries supported: tag:, path:, title:)
curl -H "X-API-Key: $KEY" "$BASE/search?q=tag:idea%20graph&limit=5"

# backlinks
curl -H "X-API-Key: $KEY" "$BASE/backlinks?path=Welcome.md"
```

## Response shapes

```jsonc
// GET /notes/{path}
{
  "path": "Welcome.md",
  "content": "...",
  "entryId": "entry_...",
  "revision": 7,
  "hash": "sha256...",
  "title": "Welcome to WebObsidian",
  "frontmatter": { "tags": ["welcome"] },
  "tags": ["welcome", "getting-started"],
  "links": ["Notes/Ideas"]
}

// GET /search
{ "query": "graph", "hits": [
  { "path": "Notes/Ideas.md", "title": "Ideas", "score": 4.2, "tags": ["idea"], "snippet": "..." }
] }
```
