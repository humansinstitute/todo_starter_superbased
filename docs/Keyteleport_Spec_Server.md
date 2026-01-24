# Key Teleport - Server Implementation Spec

## Overview

Key Teleport enables secure, private transfer of Nostr identities between apps. This spec covers the **sender side** - the app that holds the user's key and initiates teleport.

### Design Principles

1. **No server storage** - Encrypted key goes directly in the URL blob
2. **No fetch required** - Receiving app decrypts locally, no callbacks
3. **Fragment URLs** - Blob in `#fragment` so servers never see it
4. **Double encryption** - Throwaway key + target app key
5. **No traces** - No database records, no server logs
6. **Minimal pubkey exposure** - Target app pubkey not in blob (see rationale below)

### Why No Recipient Tag?

Standard Nostr events typically include a `["p", recipientPubkey]` tag to indicate the intended recipient. **We deliberately omit this for teleport blobs.**

**Rationale:**

1. **Quantum resistance** - Exposed public keys can theoretically be reversed to private keys using Shor's algorithm. By not including the target app's pubkey in the blob, an attacker capturing the blob cannot directly target that key.

2. **Receiver validation via decryption** - NIP-44 uses authenticated encryption (ChaCha20-Poly1305). The receiving app simply attempts decryption with its own key:
   - Success → blob was intended for this app
   - Failure (auth error) → blob was not for this app

3. **No relay routing needed** - Unlike standard Nostr events, teleport blobs are transmitted via clipboard or QR code, not relays. There's no routing layer that needs to know the recipient.

4. **Privacy by default** - An observer who intercepts the blob cannot determine which app it's destined for without additional context.

**What IS in the blob:**
- Sender's pubkey (Welcome) - required for signature verification, and Welcome is a known public service anyway
- Encrypted payload - only decryptable by intended recipient

**What is NOT in the blob:**
- Target app's pubkey
- User's npub (encrypted inside payload)
- Throwaway pubkey (transmitted separately via clipboard)

---

## 1. Configuration

### Server Keypair

The server needs a persistent Nostr keypair for:
- Signing teleport blobs (proves authenticity)
- Encrypting payloads to target apps

```typescript
// config.ts
export const WELCOME_PRIVKEY = Bun.env.WELCOME_PRIVKEY ?? "";
```

**.env file:**
```bash
# Generate once and store securely
WELCOME_PRIVKEY=nsec1...  # or 64-char hex
```

### Helper Functions

```typescript
import { nip19, getPublicKey } from "nostr-tools";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function getServerSecretKey(): Uint8Array | null {
  if (!WELCOME_PRIVKEY) return null;

  try {
    if (WELCOME_PRIVKEY.startsWith("nsec1")) {
      const decoded = nip19.decode(WELCOME_PRIVKEY);
      if (decoded.type === "nsec") {
        return decoded.data as Uint8Array;
      }
    } else if (WELCOME_PRIVKEY.length === 64) {
      return hexToBytes(WELCOME_PRIVKEY);
    }
  } catch (err) {
    console.error("Failed to decode WELCOME_PRIVKEY:", err);
  }
  return null;
}

function getServerNpub(): string | null {
  const secretKey = getServerSecretKey();
  if (!secretKey) return null;
  return nip19.npubEncode(getPublicKey(secretKey));
}
```

---

## 2. App Registration

Users register target apps by pasting a registration blob from the remote app.

### Database Schema

```sql
CREATE TABLE user_teleport_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_npub TEXT NOT NULL,
  app_pubkey TEXT NOT NULL,        -- Hex pubkey of remote app
  app_url TEXT NOT NULL,           -- Base URL or custom URI scheme
  app_name TEXT NOT NULL,
  app_description TEXT DEFAULT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_npub, app_pubkey)
);
```

### Registration Blob Format (from remote app)

```typescript
interface RegistrationEvent {
  kind: 30078;                    // Custom kind for KeyTeleport
  pubkey: string;                 // Remote app's pubkey (hex)
  created_at: number;
  tags: [
    ["p", "<server_pubkey>"],
    ["type", "keyteleport-app-registration"]
  ];
  content: string;                // NIP-44 encrypted to server
  sig: string;
}

// Decrypted content
interface AppRegistrationContent {
  url: string;                    // "https://app.com" or "nostrapp://"
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}
```

### API: Get Server Public Key

```typescript
// GET /api/keyteleport/pubkey
export async function handleGetServerPubkey(): Promise<Response> {
  const npub = getServerNpub();
  if (!npub) {
    return Response.json(
      { success: false, error: "Key teleport not configured" },
      { status: 503 }
    );
  }
  return Response.json({ success: true, npub });
}
```

### API: Verify Registration Blob

```typescript
import { nip19, nip44, verifyEvent } from "nostr-tools";

// POST /api/keyteleport/verify-app
export async function handleVerifyAppBlob(req: Request): Promise<Response> {
  const { blob } = await req.json();

  const serverSecretKey = getServerSecretKey();
  if (!serverSecretKey) {
    return Response.json(
      { success: false, error: "Not configured" },
      { status: 503 }
    );
  }

  // 1. Decode base64
  let event;
  try {
    event = JSON.parse(atob(blob));
  } catch {
    return Response.json(
      { success: false, error: "Invalid blob format" },
      { status: 400 }
    );
  }

  // 2. Verify signature (proves app identity)
  if (!verifyEvent(event)) {
    return Response.json(
      { success: false, error: "Invalid signature" },
      { status: 400 }
    );
  }

  // 3. Decrypt content
  let content;
  try {
    const ck = nip44.v2.utils.getConversationKey(serverSecretKey, event.pubkey);
    content = JSON.parse(nip44.v2.decrypt(event.content, ck));
  } catch {
    return Response.json(
      { success: false, error: "Decryption failed" },
      { status: 400 }
    );
  }

  // 4. Validate
  if (!content.url || !content.name) {
    return Response.json(
      { success: false, error: "Missing required fields" },
      { status: 400 }
    );
  }

  return Response.json({
    success: true,
    appPubkey: event.pubkey,
    appNpub: nip19.npubEncode(event.pubkey),
    url: content.url,
    name: content.name,
    description: content.description || null,
    metadata: content.metadata || {},
  });
}
```

### API: Add/List/Delete User Apps

```typescript
// POST /api/keyteleport/apps
export async function handleAddApp(req: Request): Promise<Response> {
  const npub = req.headers.get("X-Npub");
  if (!npub) return Response.json({ success: false, error: "Auth required" }, { status: 401 });

  const { appPubkey, url, name, description, metadata } = await req.json();

  const app = createUserTeleportApp(npub, appPubkey, url, name, description, JSON.stringify(metadata || {}));
  if (!app) return Response.json({ success: false, error: "Failed" }, { status: 500 });

  return Response.json({ success: true, app });
}

// GET /api/keyteleport/apps
export async function handleListApps(req: Request): Promise<Response> {
  const npub = req.headers.get("X-Npub");
  if (!npub) return Response.json({ success: false, error: "Auth required" }, { status: 401 });

  return Response.json({ success: true, apps: getUserTeleportApps(npub) });
}

// DELETE /api/keyteleport/apps/:id
export async function handleDeleteApp(req: Request, id: number): Promise<Response> {
  const npub = req.headers.get("X-Npub");
  if (!npub) return Response.json({ success: false, error: "Auth required" }, { status: 401 });

  const deleted = deleteUserTeleportApp(id, npub);
  return Response.json({ success: deleted, error: deleted ? null : "Not found" });
}
```

---

## 3. Key Teleport Flow

When user initiates teleport to a registered app.

### Blob Structure (Direct - No Server Fetch)

```typescript
// The blob contains everything needed - no callback to server
interface TeleportPayload {
  encryptedNsec: string;   // NIP-44(nsec, conversationKey(userKey, throwawayPubkey))
  npub: string;            // User's public key (needed for decryption)
  v: number;               // Protocol version (1)
}

// This payload is encrypted to target app's pubkey
// Then wrapped in a signed Nostr event
```

### Client-Side: Initiate Teleport

```typescript
import { nip19, nip44, finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

async function initiateKeyTeleport(
  userNsec: string,           // User's nsec
  targetAppPubkey: string,    // Hex pubkey of target app
  targetAppUrl: string,       // "https://app.com" or "nostrapp://"
  serverSecretKey: Uint8Array // Server's signing key
): Promise<{ url: string; unlockCode: string }> {

  // 1. Decode user's nsec
  const { data: userSecretKey } = nip19.decode(userNsec);
  const userPubkey = getPublicKey(userSecretKey as Uint8Array);
  const userNpub = nip19.npubEncode(userPubkey);

  // 2. Generate throwaway keypair
  const throwawaySecretKey = generateSecretKey();
  const throwawayPubkey = getPublicKey(throwawaySecretKey);

  // 3. Encrypt nsec: user's key + throwaway pubkey
  const innerConversationKey = nip44.v2.utils.getConversationKey(
    userSecretKey as Uint8Array,
    throwawayPubkey
  );
  const encryptedNsec = nip44.v2.encrypt(userNsec, innerConversationKey);

  // 4. Create payload
  const payload: TeleportPayload = {
    encryptedNsec,
    npub: userNpub,
    v: 1,
  };

  // 5. Encrypt payload to target app
  const outerConversationKey = nip44.v2.utils.getConversationKey(
    serverSecretKey,
    targetAppPubkey
  );
  const encryptedPayload = nip44.v2.encrypt(JSON.stringify(payload), outerConversationKey);

  // 6. Create and sign event (no "p" tag - see "Why No Recipient Tag?" above)
  const event = finalizeEvent({
    kind: 21059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: encryptedPayload,
  }, serverSecretKey);

  // 7. Encode blob
  const blob = btoa(JSON.stringify(event));

  // 8. Build URL with fragment (server never sees blob)
  const separator = targetAppUrl.includes("#") ? "&" : "#";
  const url = `${targetAppUrl}${separator}keyteleport=${encodeURIComponent(blob)}`;

  // 9. Unlock code is the throwaway nsec
  const unlockCode = nip19.nsecEncode(throwawaySecretKey);

  return { url, unlockCode };
}
```

### API: Create Teleport Blob

For web-based senders that can't sign client-side:

```typescript
// POST /api/keyteleport/create
// Body: { encryptedNsec, npub, appPubkey }
// Note: Browser encrypts nsec before sending
export async function handleCreateTeleport(req: Request): Promise<Response> {
  const { encryptedNsec, npub, appPubkey } = await req.json();

  const serverSecretKey = getServerSecretKey();
  if (!serverSecretKey) {
    return Response.json({ success: false, error: "Not configured" }, { status: 503 });
  }

  // Validate inputs
  if (!encryptedNsec || !npub || !appPubkey) {
    return Response.json({ success: false, error: "Missing fields" }, { status: 400 });
  }

  // Create payload (encryptedNsec already encrypted by browser)
  const payload = { encryptedNsec, npub, v: 1 };

  // Encrypt to target app
  const conversationKey = nip44.v2.utils.getConversationKey(serverSecretKey, appPubkey);
  const encryptedPayload = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);

  // Sign event (no "p" tag - recipient determined by decryption success)
  const event = finalizeEvent({
    kind: 21059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: encryptedPayload,
  }, serverSecretKey);

  const blob = btoa(JSON.stringify(event));

  return Response.json({ success: true, blob });
}
```

### Browser Integration

```typescript
// Browser-side teleport initiation
async function teleportToApp(app: UserTeleportApp) {
  // 1. Get user's nsec from encrypted storage
  const nsec = await decryptStoredNsec();
  const { data: secretKey } = nip19.decode(nsec);
  const userPubkey = getPublicKey(secretKey);

  // 2. Generate throwaway
  const throwawaySecretKey = generateSecretKey();
  const throwawayPubkey = getPublicKey(throwawaySecretKey);

  // 3. Encrypt nsec with throwaway
  const ck = nip44.v2.utils.getConversationKey(secretKey, throwawayPubkey);
  const encryptedNsec = nip44.v2.encrypt(nsec, ck);

  // 4. Request signed blob from server
  const res = await fetch("/api/keyteleport/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encryptedNsec,
      npub: nip19.npubEncode(userPubkey),
      appPubkey: app.app_pubkey,
    }),
  });
  const { blob } = await res.json();

  // 5. Copy unlock code to clipboard
  const unlockCode = nip19.nsecEncode(throwawaySecretKey);
  await navigator.clipboard.writeText(unlockCode);

  // 6. Open target app with fragment URL
  const url = `${app.app_url}#keyteleport=${encodeURIComponent(blob)}`;
  window.open(url, "_blank");
}
```

---

## 4. URL Formats

### Web Apps (HTTPS with Fragment)

```
https://app.example.com/#keyteleport=<BLOB>
```

- Fragment is **not sent to server**
- Server logs show only `https://app.example.com/`
- JavaScript reads via `window.location.hash`

### Native Apps (Custom URI Scheme)

```
nostrapp://auth#keyteleport=<BLOB>
damus://import#keyteleport=<BLOB>
amethyst://keyteleport#blob=<BLOB>
```

- No HTTP request at all
- Opens native app directly
- Maximum privacy

### Universal/Generic Scheme

```
nostr:keyteleport?blob=<BLOB>
```

Could be standardized in a NIP for any Nostr app to handle.

---

## 5. Security Model

### Double Encryption

```
BLOB structure:
└── Signed Nostr event (server's key)
    ├── pubkey: server's pubkey (for signature verification)
    ├── tags: []  (empty - no recipient pubkey exposed)
    ├── content: NIP-44 encrypted (server → target app):
    │   └── payload:
    │       ├── encryptedNsec (NIP-44: user → throwaway)
    │       ├── npub
    │       └── v: 1
    └── sig: signature
```

**Note:** The `tags` array is intentionally empty. See "Why No Recipient Tag?" for rationale.

### To Decrypt, Attacker Needs Both:

1. **Target app's private key** - to decrypt outer layer
2. **Throwaway private key** - to decrypt inner layer (only on user's clipboard)

### Quantum Resistance Considerations

By omitting the target app's pubkey from the blob:

- **Classical attacker**: Cannot determine intended recipient without context
- **Quantum attacker**: Cannot use Shor's algorithm to derive app's private key from the blob alone (pubkey not present)
- **Welcome's pubkey IS exposed**: This is acceptable as Welcome is a known public service. Quantum attackers could theoretically derive Welcome's key, but the inner payload is still protected by the throwaway key which is never transmitted in the blob.

### What Observers See

| Observer | Fragment URL | Custom URI |
|----------|--------------|------------|
| DNS | Domain only | Nothing |
| ISP/Network | Domain only | Nothing |
| Server logs | **Nothing** (fragment) | N/A |
| CDN/Proxy | **Nothing** (fragment) | N/A |
| Browser history | Full URL | N/A |
| Clipboard | Unlock code only | Unlock code only |

---

## 6. Summary Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                           KEY TELEPORT FLOW                            │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Sender App                                    Target App              │
│  ──────────                                    ──────────              │
│                                                                        │
│  1. User clicks "Teleport to App X"                                    │
│                                                                        │
│  2. Generate throwaway keypair                                         │
│     └── throwawaySecretKey, throwawayPubkey                           │
│                                                                        │
│  3. Encrypt nsec                                                       │
│     └── NIP-44(nsec, userKey + throwawayPubkey)                       │
│                                                                        │
│  4. Create payload { encryptedNsec, npub, v }                         │
│                                                                        │
│  5. Encrypt payload to target app                                      │
│     └── NIP-44(payload, serverKey + targetAppPubkey)                  │
│                                                                        │
│  6. Sign event with server key (no "p" tag)                            │
│     └── Target app pubkey NOT included for quantum resistance         │
│                                                                        │
│  7. Base64 encode → BLOB                                               │
│                                                                        │
│  8. Copy throwaway nsec to clipboard                                   │
│     └── This is the "unlock code"                                     │
│                                                                        │
│  9. Open URL: https://app.com/#keyteleport=BLOB                       │
│     └── Or: nostrapp://auth#keyteleport=BLOB                          │
│                                                 │                      │
│                                                 ▼                      │
│                                    10. Read fragment (JS only)         │
│                                        └── Server never sees blob     │
│                                                                        │
│                                    11. Verify signature                │
│                                                                        │
│                                    12. Decrypt with app's key          │
│                                        └── Success = blob was for us  │
│                                        └── Get { encryptedNsec, npub } │
│                                                                        │
│                                    13. Prompt: "Paste unlock code"     │
│                                                                        │
│  User pastes from clipboard ──────────────────►                        │
│                                                                        │
│                                    14. Decrypt with throwaway key      │
│                                        └── Get user's nsec            │
│                                                                        │
│                                    15. Store encrypted locally         │
│                                                                        │
│                                    ✓ User authenticated!               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Dependencies

```json
{
  "dependencies": {
    "nostr-tools": "^2.7.2"
  }
}
```
