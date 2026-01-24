# Key Teleport - Client Implementation Spec

## Overview

Key Teleport enables secure, private transfer of Nostr identities between apps. This spec covers the **receiver side** - the app that receives and imports a teleported key.

### Design Principles

1. **No server fetch** - Everything needed is in the URL blob
2. **Fragment URLs** - Blob in `#fragment` so your server never sees it
3. **Double encryption** - Target app key + throwaway key
4. **User confirmation** - Unlock code ensures user intent
5. **No traces** - Nothing logged, nothing stored until user confirms
6. **No recipient tag** - Your app's pubkey is NOT in the blob (see rationale below)

### Why No Recipient Tag in Teleport Blobs?

Standard Nostr events typically include a `["p", recipientPubkey]` tag. **KeyTeleport deliberately omits this.**

**Rationale:**

1. **Quantum resistance** - Exposed public keys could theoretically be reversed to private keys using Shor's algorithm. By not including your app's pubkey in the blob, an attacker capturing the blob cannot directly target your key.

2. **You validate via decryption** - NIP-44 uses authenticated encryption (ChaCha20-Poly1305). Your app simply attempts decryption:
   - Success → blob was intended for your app
   - Auth error → blob was not for your app (ignore it)

3. **No relay routing** - Teleport blobs travel via clipboard or QR code, not relays. There's no routing layer that needs the recipient pubkey.

4. **Privacy** - Intercepted blobs don't reveal the target application.

**What IS in the blob:**
- Sender's pubkey (e.g., Welcome) - needed for signature verification
- Encrypted payload - only your app can decrypt it

**What is NOT in the blob:**
- Your app's pubkey
- User's npub (encrypted inside)
- Throwaway pubkey (user has it separately)

---

## 1. Prerequisites

### App Keypair

Your app needs a persistent keypair for receiving teleported keys:

```typescript
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

// Generate ONCE and store securely (env variable, secure storage)
const appSecretKey = generateSecretKey();  // Uint8Array (32 bytes)
const appPubkeyHex = getPublicKey(appSecretKey);
const appNsec = nip19.nsecEncode(appSecretKey);
const appNpub = nip19.npubEncode(appPubkeyHex);

// Store in .env
// APP_PRIVKEY=nsec1...
```

**Important:** This keypair is for receiving teleports, not for user identity. Store it securely on your server or in your native app's secure storage.

---

## 2. App Registration

Before users can teleport to your app, they must register it in their sender app (e.g., Welcome).

### Registration Flow

1. User goes to your app's "Setup Key Teleport" page
2. User pastes the sender's public key (npub)
3. Your app generates a registration blob
4. User copies blob and pastes into sender app

### Generating Registration Blob

```typescript
import { nip19, nip44, finalizeEvent, getPublicKey } from "nostr-tools";

const KEYTELEPORT_KIND = 30078;

interface AppRegistration {
  url: string;          // Your app's URL or custom URI scheme
  name: string;         // Display name
  description?: string;
  metadata?: object;    // Reserved for future use
}

function generateRegistrationBlob(
  senderNpub: string,        // Sender's public key (e.g., Welcome's npub)
  appSecretKey: Uint8Array,  // Your app's secret key
  registration: AppRegistration
): string {
  // 1. Decode sender's npub
  const { data: senderPubkeyHex } = nip19.decode(senderNpub);

  // 2. Create registration content
  const content = {
    url: registration.url,
    name: registration.name,
    description: registration.description,
    metadata: registration.metadata || {},
  };

  // 3. Encrypt to sender's pubkey
  const conversationKey = nip44.v2.utils.getConversationKey(
    appSecretKey,
    senderPubkeyHex as string
  );
  const encryptedContent = nip44.v2.encrypt(JSON.stringify(content), conversationKey);

  // 4. Create and sign event
  const event = finalizeEvent({
    kind: KEYTELEPORT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", senderPubkeyHex as string],
      ["type", "keyteleport-app-registration"],
    ],
    content: encryptedContent,
  }, appSecretKey);

  // 5. Base64 encode
  return btoa(JSON.stringify(event));
}
```

### Registration UI Example

```html
<h2>Setup Key Teleport</h2>

<div class="step">
  <h3>Step 1: Enter Sender's Public Key</h3>
  <input type="text" id="sender-npub" placeholder="npub1..." />
</div>

<div class="step">
  <h3>Step 2: Copy Registration Blob</h3>
  <button id="generate-btn">Generate Blob</button>
  <textarea id="blob-output" readonly hidden></textarea>
  <button id="copy-btn" hidden>Copy to Clipboard</button>
</div>

<div class="step">
  <h3>Step 3: Complete Setup</h3>
  <p>Paste the blob into your sender app (e.g., Welcome) to complete registration.</p>
</div>

<script type="module">
  import { nip19, nip44, finalizeEvent } from "nostr-tools";

  // Your app's keypair (loaded from secure storage)
  const APP_SECRET_KEY = /* load from env/secure storage */;

  document.getElementById("generate-btn").onclick = () => {
    const senderNpub = document.getElementById("sender-npub").value.trim();

    try {
      const blob = generateRegistrationBlob(senderNpub, APP_SECRET_KEY, {
        url: "https://yourapp.com",  // or "yourapp://auth"
        name: "Your App Name",
        description: "What your app does",
      });

      document.getElementById("blob-output").value = blob;
      document.getElementById("blob-output").hidden = false;
      document.getElementById("copy-btn").hidden = false;
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  document.getElementById("copy-btn").onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById("blob-output").value);
    document.getElementById("copy-btn").textContent = "Copied!";
  };
</script>
```

---

## 3. Receiving Teleported Keys

When a user teleports their key, they're redirected to your app with the blob in the URL fragment.

### URL Format

```
https://yourapp.com/#keyteleport=<BASE64_BLOB>
```

Or for native apps:
```
yourapp://auth#keyteleport=<BASE64_BLOB>
```

**Important:** The blob is in the fragment (`#`), so your server never sees it. Only client-side JavaScript can read it.

### Teleport Payload Structure

```typescript
interface TeleportPayload {
  encryptedNsec: string;  // NIP-44 encrypted (user's key + throwaway pubkey)
  npub: string;           // User's public key
  v: number;              // Protocol version (1)
}
```

### Decoding the Blob

```typescript
import { nip19, nip44, verifyEvent } from "nostr-tools";

interface TeleportPayload {
  encryptedNsec: string;
  npub: string;
  v: number;
}

function decodeTeleportBlob(
  blob: string,
  appSecretKey: Uint8Array
): { payload: TeleportPayload; senderPubkey: string } {
  // 1. Base64 decode
  const eventJson = atob(blob);
  const event = JSON.parse(eventJson);

  // 2. Verify signature (proves authenticity)
  if (!verifyEvent(event)) {
    throw new Error("Invalid signature - blob may be tampered");
  }

  // 3. Decrypt content with your app's key
  //    NOTE: There is no "p" tag - the blob doesn't contain your pubkey.
  //    Decryption success = blob was intended for you.
  //    Decryption failure = blob was for a different app (auth error from Poly1305).
  const conversationKey = nip44.v2.utils.getConversationKey(
    appSecretKey,
    event.pubkey  // Sender's pubkey
  );

  let decrypted: string;
  try {
    decrypted = nip44.v2.decrypt(event.content, conversationKey);
  } catch (err) {
    // NIP-44 auth failure means wrong key - this blob isn't for us
    throw new Error("Decryption failed - blob may be for a different app");
  }

  const payload: TeleportPayload = JSON.parse(decrypted);

  // 4. Validate version
  if (payload.v !== 1) {
    throw new Error(`Unsupported protocol version: ${payload.v}`);
  }

  return {
    payload,
    senderPubkey: event.pubkey,
  };
}
```

### Decrypting the Key

The user must provide the "unlock code" (throwaway nsec) to decrypt their actual key:

```typescript
function decryptUserKey(
  encryptedNsec: string,  // From payload
  userNpub: string,       // From payload
  unlockCode: string      // User pastes this (throwaway nsec)
): string {
  // 1. Decode unlock code
  const { type, data: throwawaySecretKey } = nip19.decode(unlockCode);
  if (type !== "nsec") {
    throw new Error("Invalid unlock code format");
  }

  // 2. Decode user's npub
  const { data: userPubkeyHex } = nip19.decode(userNpub);

  // 3. Derive conversation key: throwaway + user's pubkey
  const conversationKey = nip44.v2.utils.getConversationKey(
    throwawaySecretKey as Uint8Array,
    userPubkeyHex as string
  );

  // 4. Decrypt
  const nsec = nip44.v2.decrypt(encryptedNsec, conversationKey);

  // 5. Validate result
  const { type: nsecType } = nip19.decode(nsec);
  if (nsecType !== "nsec") {
    throw new Error("Decryption failed - invalid unlock code?");
  }

  return nsec;
}
```

---

## 4. Complete Integration

### Full Handler

```typescript
import { nip19, nip44, verifyEvent } from "nostr-tools";

// Your app's secret key (load from secure storage)
const APP_SECRET_KEY: Uint8Array = /* ... */;

interface TeleportResult {
  npub: string;
  nsec: string;
}

async function handleKeyTeleport(): Promise<TeleportResult | null> {
  // 1. Check for teleport in URL fragment
  const hash = window.location.hash;
  if (!hash.includes("keyteleport=")) {
    return null;
  }

  // 2. Extract blob from fragment
  const params = new URLSearchParams(hash.slice(1));
  const blob = params.get("keyteleport");
  if (!blob) {
    return null;
  }

  // 3. Immediately clear URL (don't leave blob in history)
  history.replaceState(null, "", window.location.pathname);

  try {
    // 4. Decode and verify blob
    const { payload } = decodeTeleportBlob(decodeURIComponent(blob), APP_SECRET_KEY);

    // 5. Show user what's happening
    const userConfirmed = await showTeleportUI(payload.npub);
    if (!userConfirmed) {
      return null;
    }

    // 6. Get unlock code from user
    const unlockCode = await promptForUnlockCode();
    if (!unlockCode) {
      return null;
    }

    // 7. Decrypt the key
    const nsec = decryptUserKey(
      payload.encryptedNsec,
      payload.npub,
      unlockCode
    );

    // 8. Success! Store securely
    await storeUserKeySecurely(nsec, payload.npub);

    return {
      npub: payload.npub,
      nsec,
    };
  } catch (err) {
    console.error("Key teleport failed:", err);
    showError("Failed to import key: " + err.message);
    return null;
  }
}

// Call on page load
handleKeyTeleport().then(result => {
  if (result) {
    console.log("User authenticated:", result.npub);
    // Redirect to main app, show success, etc.
  }
});
```

### UI Components

```typescript
async function showTeleportUI(npub: string): Promise<boolean> {
  // Show modal explaining what's happening
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "teleport-modal";
    modal.innerHTML = `
      <div class="teleport-content">
        <h2>Key Teleport</h2>
        <p>Importing identity:</p>
        <code>${npub.slice(0, 20)}...</code>
        <p>You'll need to paste your unlock code to continue.</p>
        <button id="teleport-continue">Continue</button>
        <button id="teleport-cancel">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("teleport-continue").onclick = () => {
      modal.remove();
      resolve(true);
    };
    document.getElementById("teleport-cancel").onclick = () => {
      modal.remove();
      resolve(false);
    };
  });
}

async function promptForUnlockCode(): Promise<string | null> {
  return new Promise(resolve => {
    const modal = document.createElement("div");
    modal.className = "teleport-modal";
    modal.innerHTML = `
      <div class="teleport-content">
        <h2>Enter Unlock Code</h2>
        <p>Paste the unlock code from your clipboard:</p>
        <input type="password" id="unlock-input" placeholder="nsec1..." />
        <p class="hint">The code was copied when you clicked "Teleport"</p>
        <button id="unlock-submit">Unlock</button>
        <button id="unlock-cancel">Cancel</button>
        <p id="unlock-error" class="error" hidden></p>
      </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById("unlock-input") as HTMLInputElement;
    const errorEl = document.getElementById("unlock-error");

    // Try to auto-paste from clipboard
    navigator.clipboard.readText().then(text => {
      if (text.startsWith("nsec1")) {
        input.value = text;
      }
    }).catch(() => {
      // Clipboard access denied, user will paste manually
    });

    document.getElementById("unlock-submit").onclick = () => {
      const code = input.value.trim();
      if (!code.startsWith("nsec1")) {
        errorEl.textContent = "Invalid format - should start with nsec1";
        errorEl.hidden = false;
        return;
      }
      modal.remove();
      resolve(code);
    };

    document.getElementById("unlock-cancel").onclick = () => {
      modal.remove();
      resolve(null);
    };
  });
}

async function storeUserKeySecurely(nsec: string, npub: string): Promise<void> {
  // Store encrypted in IndexedDB, secure storage, etc.
  // See your app's key storage implementation
}

function showError(message: string): void {
  alert(message);  // Replace with your UI
}
```

---

## 5. Native App Implementation

For native iOS/Android apps, register a custom URI scheme.

### iOS (Info.plist)

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>yourapp</string>
    </array>
    <key>CFBundleURLName</key>
    <string>com.yourcompany.yourapp</string>
  </dict>
</array>
```

### Android (AndroidManifest.xml)

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="yourapp" />
</intent-filter>
```

### Handle URI in App

```typescript
// React Native example
import { Linking } from "react-native";

Linking.addEventListener("url", ({ url }) => {
  if (url.includes("keyteleport=")) {
    const hash = url.split("#")[1];
    const params = new URLSearchParams(hash);
    const blob = params.get("keyteleport");
    // ... same decoding logic as web
  }
});
```

---

## 6. Security Checklist

- [ ] **Store app secret key securely** - Environment variable, Keychain, secure storage
- [ ] **Clear URL immediately** - Don't leave blob in browser history
- [ ] **Verify event signature** - Ensures blob wasn't tampered
- [ ] **Validate unlock code format** - Must be valid nsec
- [ ] **Store user key encrypted** - Never plaintext at rest
- [ ] **Don't log the blob** - Fragment URLs shouldn't be logged, but be careful with error logging

---

## 7. Error Handling

| Error | Cause | User Message |
|-------|-------|--------------|
| Invalid signature | Blob tampered or wrong sender | "Invalid teleport link" |
| Decryption failed (outer) | Wrong app key (blob for different app) | "This teleport link isn't for this app" |
| Invalid unlock code format | User pasted wrong thing | "Invalid unlock code format" |
| Decryption failed (inner) | Wrong unlock code | "Incorrect unlock code - please try again" |
| Unsupported version | Future protocol version | "Please update the app" |

**Note:** Since there's no recipient tag in the blob, decryption failure on the outer layer means the blob was encrypted for a different app's pubkey. This is expected behavior when users accidentally open a teleport link in the wrong app.

---

## 8. Summary Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                      RECEIVING A TELEPORTED KEY                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. User clicks teleport link or scans QR                              │
│     └── https://yourapp.com/#keyteleport=<BLOB>                       │
│                                                                        │
│  2. App reads fragment (server never sees it)                          │
│     └── const blob = new URLSearchParams(hash).get("keyteleport")     │
│                                                                        │
│  3. Clear URL immediately                                              │
│     └── history.replaceState(null, "", pathname)                      │
│                                                                        │
│  4. Verify signature                                                   │
│     └── verifyEvent(event) → proves blob is authentic                 │
│                                                                        │
│  5. Decrypt outer layer (your app's key)                               │
│     └── NIP-44 decrypt → { encryptedNsec, npub, v }                   │
│     └── Success = blob was for you (no "p" tag - decryption validates)│
│                                                                        │
│  6. Show confirmation UI                                               │
│     └── "Importing identity: npub1..."                                │
│                                                                        │
│  7. Prompt for unlock code                                             │
│     └── User pastes nsec1... from clipboard                           │
│                                                                        │
│  8. Decrypt inner layer (throwaway key)                                │
│     └── NIP-44 decrypt → user's actual nsec                           │
│                                                                        │
│  9. Store encrypted locally                                            │
│     └── IndexedDB, Keychain, etc.                                     │
│                                                                        │
│  ✓ User authenticated!                                                 │
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

Or via CDN:

```javascript
import { nip19, nip44, verifyEvent } from "https://esm.sh/nostr-tools@2.7.2";
import * as nip44 from "https://esm.sh/nostr-tools@2.7.2/nip44";
```
