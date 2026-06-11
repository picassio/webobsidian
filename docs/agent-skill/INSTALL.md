# Install the WebObsidian Agent skill (copy-paste bootstrap)

This is a **self-installing prompt**. Copy *everything* inside the box below (from
`SYSTEM / TASK` to the end) and paste it into your coding agent (Claude Code, Codex,
OpenCode, Cursor, etc.). The agent will install the skill, ask you for your WebObsidian
URL + API key, save them, and from then on be able to operate your vault.

> You only do this once per machine. After that, just tell the agent "use my WebObsidian
> vault to …" and the skill takes over.

---

````text
SYSTEM / TASK — Install the "webobsidian" agent skill, then set up credentials.

Do the following steps in order. Do not skip the credential step.

STEP 1 — Pick the skill directory for your runtime and create the skill folder:
  - Claude Code:  ~/.claude/skills/webobsidian/
  - Codex:        ~/.codex/skills/webobsidian/
  - OpenCode:     ~/.opencode/skills/webobsidian/
  - Otherwise, use this runtime's documented skills directory.
  Create that directory.

STEP 2 — Write the file SKILL.md into that folder with EXACTLY the content between the
<<<SKILL.md>>> markers below (verbatim, including the YAML frontmatter):

<<<SKILL.md>>>
---
name: webobsidian
description: "Read, write, search, and manage notes in a WebObsidian vault through its Agent REST API (/api/v1). Use whenever the user asks to find, read, create, update, append to, or delete notes in their WebObsidian / Obsidian vault, list tags, get backlinks, or run a vault search. Credentials (base URL + API key) are stored in ~/.webobsidian/credentials.json; if missing, ask the user for them and save them before making requests."
---

# WebObsidian Agent skill

Operate a WebObsidian vault over its Agent REST API at `/api/v1`. Everything is a plain
HTTP call authenticated with an API key.

## Credentials (read these first, every session)

Credentials live in `~/.webobsidian/credentials.json`:

    { "baseUrl": "https://your-webobsidian.example.com", "apiKey": "wok_xxxxxxxx" }

Before the first request in a session, load them into shell variables:

    BASE=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["baseUrl"].rstrip("/"))')
    KEY=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["apiKey"])')

If the file does not exist or a call returns 401, ask the user for their base URL and API
key (created in the app at Settings -> API Keys, scopes read/write/search; keys look like
wok_...), then save without echoing the key:

    mkdir -p ~/.webobsidian && chmod 700 ~/.webobsidian
    printf '{ "baseUrl": "%s", "apiKey": "%s" }\n' "<BASE_URL>" "<API_KEY>" > ~/.webobsidian/credentials.json
    chmod 600 ~/.webobsidian/credentials.json

Security: never print, log, or commit the API key; never write it into vault notes.

## Sanity check

    curl -s "$BASE/api/v1/health"
    curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/tags" | head

## Authentication

Send the key as a header on every /api/v1 request (either form):
  X-API-Key: wok_xxx
  Authorization: Bearer wok_xxx
Scopes per key: read, write, search. Out-of-scope -> 403. Rate limited (~120/min) -> 429.

## Endpoint reference

All {path} values are vault-relative and URL-encoded. Notes need the .md extension.

  GET    /api/v1/health                      (no scope)  liveness
  GET    /api/v1/notes?offset=&limit=        read        list notes (paginated)
  GET    /api/v1/notes/{path}                read        read a note + metadata
  PUT    /api/v1/notes/{path}                write       create/overwrite, body {"content":"..."}
  PATCH  /api/v1/notes/{path}                write       append, body {"append":"..."}
  DELETE /api/v1/notes/{path}                write       move note to trash
  GET    /api/v1/search?q=&limit=            search      QMD search (fielded: tag: path: title:)
  GET    /api/v1/backlinks?path=             read        notes linking to a path
  GET    /api/v1/tags                        read        all tags with counts

## Recipes

    # list
    curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/notes?limit=10"
    # read
    curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/notes/Welcome.md"
    # create / overwrite
    curl -s -X PUT -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
      -d '{"content":"# Title\n\nBody."}' "$BASE/api/v1/notes/Agent/Generated.md"
    # append
    curl -s -X PATCH -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
      -d '{"append":"\n- another bullet"}' "$BASE/api/v1/notes/Agent/Generated.md"
    # delete
    curl -s -X DELETE -H "X-API-Key: $KEY" "$BASE/api/v1/notes/Agent/Generated.md"
    # search (fielded queries supported)
    curl -s -G -H "X-API-Key: $KEY" "$BASE/api/v1/search" \
      --data-urlencode "q=tag:idea graph" --data-urlencode "limit=5"
    # backlinks
    curl -s -G -H "X-API-Key: $KEY" "$BASE/api/v1/backlinks" --data-urlencode "path=Welcome.md"
    # tags
    curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/tags"

## Obsidian Flavored Markdown (write notes in this dialect)

The vault is a real Obsidian vault (the user also opens it in the Obsidian app), so write
Obsidian Flavored Markdown. Use [[wikilinks]] for links between vault notes; use [text](url)
only for external URLs.

Properties = YAML frontmatter at the very top between --- fences (keys: tags, aliases,
cssclasses). Preserve existing frontmatter on overwrite:

    ---
    title: My Note
    tags:
      - project
    aliases:
      - Alternative Name
    ---

Wikilinks:
    [[Note Name]]                 link to a note
    [[Note Name|Display Text]]    custom display text
    [[Note Name#Heading]]         link to a heading
    [[Note Name#^block-id]]       link to a block
    [[#Heading in same note]]     same-note link

Block reference: append ^block-id to a paragraph (own line after lists/quotes):
    This paragraph can be linked to. ^my-block-id

Embeds / transclusion (prefix a wikilink with !):
    ![[Note Name]]        ![[Note Name#Heading]]        ![[image.png]]
    ![[image.png|300]]    ![[document.pdf#page=3]]

Callouts:
    > [!note]
    > Basic callout.
    > [!warning] Custom Title
    > Callout with a custom title.
    > [!faq]- Collapsed by default
    > Foldable (- collapsed, + expanded).
  Types: note tip info warning danger success failure question example quote bug abstract todo.

Tags: #tag and #nested/tag (also frontmatter tags:). Tasks: - [ ] pending / - [x] done.

Other: ==highlight== **bold** *italic* ; footnote[^1] with [^1]: text ; %%hidden comment%% ;
inline math $e^{i\pi}+1=0$ ; block math $$...$$ (KaTeX) ; ```mermaid code blocks.

## Editing rules

- Prefer PATCH append over PUT when only adding content; read before overwriting unless told
  to replace, and preserve existing frontmatter/formatting.
- Paths are case-sensitive and include the .md extension.
- Link other notes with [[...]] rather than bare names, to keep graph + backlinks intact.

## Troubleshooting

  401 -> key missing/invalid (re-run credentials)   403 -> key lacks scope
  404 -> wrong path/casing or in .trash             429 -> rate limited, back off
<<<SKILL.md>>>

STEP 3 — Set up credentials now:
  - Check whether ~/.webobsidian/credentials.json already exists. If it does and is valid,
    skip to STEP 4.
  - Otherwise ASK ME for:
      (a) my WebObsidian base URL (e.g. https://notes.example.com or http://host:8787)
      (b) my API key (I create it in the app at Settings -> API Keys; it looks like wok_...)
  - Save them WITHOUT echoing the key back:
      mkdir -p ~/.webobsidian && chmod 700 ~/.webobsidian
      printf '{ "baseUrl": "%s", "apiKey": "%s" }\n' "<BASE_URL>" "<API_KEY>" > ~/.webobsidian/credentials.json
      chmod 600 ~/.webobsidian/credentials.json

STEP 4 — Verify and confirm:
      BASE=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["baseUrl"].rstrip("/"))')
      KEY=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["apiKey"])')
      curl -s "$BASE/api/v1/health"
      curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/tags" | head
  Report success (number of tags found, say) WITHOUT printing the API key, and tell me the
  skill is installed and ready. From now on, when I ask you to work with my WebObsidian /
  Obsidian vault, use the webobsidian skill.
````

---

## Alternative install methods

If your runtime supports the [Agent Skills](https://github.com/obsidianmd/obsidian-skills)
installer you can also do:

```bash
# from the repo (after it is published)
npx skills add https://github.com/xnohat/webobsidian --path docs/agent-skill/webobsidian
```

Or manually copy [`webobsidian/SKILL.md`](webobsidian/SKILL.md) into your runtime's skills
directory (`~/.claude/skills/webobsidian/`, `~/.codex/skills/webobsidian/`, …) and run the
credential step from the paste above.

> The canonical, maintained copy of the skill is [`webobsidian/SKILL.md`](webobsidian/SKILL.md).
> The embedded copy in the paste box is kept in sync with it.
