# Agent API Documentation

API for AI agents to read and write todos via SuperBased.

## Authentication

All requests require a Bearer token in the Authorization header:
```
Authorization: Bearer $TOKEN
```

The token will be provided in your prompt.

## Base URL

```
https://sb.otherstuff.studio
```

## Config Values

Get these from the **Agent Connect** menu in the app:

- `superbasedAppKey` - hex pubkey of the app
- `userKey` - hex pubkey of the logged-in user
- `superbasedURL` - base URL for API calls

---

## Endpoints

### Read all todos

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos"
```

### Read todos for a specific user

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos&user_pubkey={userKey}"
```

### Read todos assigned to a user

Fetch all and filter by `metadata.assigned_to`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos"
```

Then filter results where `metadata.assigned_to` equals the target hex pubkey.

### Write a single todo

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": "todo_{uuid}",
    "app_pubkey": "{superbasedAppKey}",
    "user_pubkey": "{userKey}",
    "collection": "todos",
    "encrypted_data": "{\"title\":\"My Task\",\"description\":\"\",\"priority\":\"sand\",\"state\":\"new\",\"tags\":\"\",\"scheduled_for\":null,\"assigned_to\":null,\"done\":0,\"deleted\":0,\"created_at\":\"2024-01-01T00:00:00.000Z\",\"updated_at\":\"2024-01-01T00:00:00.000Z\"}",
    "metadata": {
      "local_id": "{uuid}",
      "owner": "{userNpub}",
      "updated_at": "2024-01-01T00:00:00.000Z",
      "device_id": "agent"
    }
  }' \
  https://sb.otherstuff.studio/db/superbased_records
```

### Write multiple todos

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "record_id": "todo_{uuid1}",
      "app_pubkey": "{superbasedAppKey}",
      "user_pubkey": "{userKey}",
      "collection": "todos",
      "encrypted_data": "{...}",
      "metadata": {...}
    },
    {
      "record_id": "todo_{uuid2}",
      "app_pubkey": "{superbasedAppKey}",
      "user_pubkey": "{userKey}",
      "collection": "todos",
      "encrypted_data": "{...}",
      "metadata": {...}
    }
  ]' \
  https://sb.otherstuff.studio/db/superbased_records
```

---

## Todo Schema

The `encrypted_data` field contains a JSON string with these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Todo title |
| `description` | string | No | Detailed description |
| `priority` | string | No | `sand`, `stone`, `iron`, or `gold` (default: `sand`) |
| `state` | string | No | `new`, `doing`, `blocked`, `review`, or `done` (default: `new`) |
| `tags` | string | No | Comma-separated tags (e.g., `"work,urgent"`) |
| `scheduled_for` | string/null | No | ISO8601 datetime or null |
| `assigned_to` | string/null | No | Hex pubkey of assignee or null |
| `done` | number | No | `0` or `1` |
| `deleted` | number | No | `0` or `1` (soft delete) |
| `created_at` | string | Yes | ISO8601 datetime |
| `updated_at` | string | Yes | ISO8601 datetime |

### Priority Levels

- `sand` - Low priority
- `stone` - Normal priority
- `iron` - High priority
- `gold` - Critical priority

### State Transitions

- `new` - Just created
- `doing` - In progress
- `blocked` - Blocked/waiting
- `review` - Ready for review
- `done` - Completed

---

## Example: Create a new todo

```bash
# Generate a UUID (16 hex chars)
UUID=$(openssl rand -hex 8)
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"record_id\": \"todo_${UUID}\",
    \"app_pubkey\": \"00bb00fc6b89b34e498922...\",
    \"user_pubkey\": \"934b9c5b...\",
    \"collection\": \"todos\",
    \"encrypted_data\": \"{\\\"title\\\":\\\"Buy groceries\\\",\\\"description\\\":\\\"Milk, eggs, bread\\\",\\\"priority\\\":\\\"stone\\\",\\\"state\\\":\\\"new\\\",\\\"tags\\\":\\\"shopping\\\",\\\"scheduled_for\\\":null,\\\"assigned_to\\\":null,\\\"done\\\":0,\\\"deleted\\\":0,\\\"created_at\\\":\\\"${NOW}\\\",\\\"updated_at\\\":\\\"${NOW}\\\"}\",
    \"metadata\": {
      \"local_id\": \"${UUID}\",
      \"owner\": \"npub1...\",
      \"updated_at\": \"${NOW}\",
      \"device_id\": \"agent\"
    }
  }" \
  https://sb.otherstuff.studio/db/superbased_records
```

## Notes

- The `record_id` format is `todo_{uuid}` where uuid is a 16-character hex string
- The `encrypted_data` field is a JSON string (escaped JSON within JSON)
- Always update `updated_at` when modifying a todo
- Set `device_id` to `"agent"` to identify agent-created records
