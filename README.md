# opencode mobile remote

Check on your [opencode](https://opencode.ai) sessions from your phone, approve work with one
tap, and get notified when something finishes or breaks.

Built for the situation where you start a long task, walk away from the laptop, and opencode
sits waiting for you to approve a command.

```
   your phone                cloudflare                your laptop
  ┌──────────┐   wss/https  ┌──────────────┐   wss    ┌───────────────┐
  │ Expo app │ ───────────▶ │ Worker +     │ ◀─────── │ bridge (node) │
  │          │              │ Durable Obj  │          │               │
  └──────────┘              │  per machine │          └───────┬───────┘
       ▲                    └──────────────┘                  │ http
       │  expo push                                     ┌─────▼─────────┐
       └────────────────────────────────────────────── │ opencode serve │
                                                          └───────────────┘
```

The laptop never accepts an inbound connection. The bridge dials out to the relay and holds a
websocket open, which is why this works from home, a café or a tethered phone with no port
forwarding and no VPN. One Durable Object per laptop keeps each machine's data separate.

## What it does

- **Approvals** as push notifications, answered with *Allow once*, *Always* or *Reject*.
- **Live progress** for every session: working or idle, current plan, recent output, token cost.
- **Start work** from the phone, or send a follow-up prompt to a running session.
- **Review diffs** before deciding, and **abort** a session that has gone off the rails.
- **Done notifications** when a session finishes, **error notifications** when it fails.

## What you need first

- **Node.js 20 or newer** — <https://nodejs.org> (pick the LTS version)
- **opencode CLI** — `npm install -g opencode-ai`
- **A Cloudflare account** — free is fine — <https://dash.cloudflare.com/sign-up>
- **An Android phone**

Three pieces to set up, in this order: the relay, the app, the bridge.

---

## Step 1 — Deploy your relay

The relay is a tiny Cloudflare Worker that holds the connection between your phone and your
laptop, and sends your push notifications. Everyone gets their own.

**1. Get the code and install its dependencies**

```bash
git clone https://github.com/YOUR_USERNAME/opencode-mobile-remote.git
cd opencode-mobile-remote
npm install
```

**2. Log in to Cloudflare** (opens a browser, one time)

```bash
npx wrangler login
```

**3. Deploy**, and copy the URL it prints

```bash
npm run relay:deploy
```

It ends with something like:

```
Deployed opencode-mobile-relay triggers
  https://opencode-mobile-relay.your-subdomain.workers.dev
```

**Write that URL down.** The app needs it. Keep the `https://` for the app, and swap it to
`wss://` when you start the bridge in step 3.

You only do this once. If you ever change your Cloudflare account, or lose the URL, just run
`npm run relay:deploy` again.

---

## Step 2 — Get the app on your phone

### Option A — build an APK yourself (no account needed)

You need Android Studio with its SDK and a phone connected by USB with **Developer options →
USB debugging** turned on.

```powershell
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
cd app
npm install
npx expo prebuild --platform android
cd android
.\gradlew.bat assembleRelease
adb install -r app\build\outputs\apk\release\app-release.apk
```

> ⚠️ **Put this project somewhere with no spaces in the path**, like `C:\dev\opencode-mobile`.
> In `C:\Users\you\My Projects\...` the Android build fails with
> `ninja: error: manifest 'build.ninja' still dirty after 100 tries`, which costs an hour to
> diagnose.

> 💡 On a laptop with 16 GB or less that is also running other services, add this to
> `app/android/gradle.properties` or the build gets killed by memory pressure:
> ```
> org.gradle.jvmargs=-Xmx2560m -XX:MaxMetaspaceSize=768m
> org.gradle.workers.max=2
> org.gradle.parallel=false
> android.enableAapt2Daemon=false
> reactNativeArchitectures=arm64-v8a
> ```

### Option B — Expo Go

```bash
cd app && npm install && npx expo start
```

Scan the QR code with Expo Go. Everything works except background push notifications
(Android removed remote push from Expo Go in SDK 53).

---

## Step 3 — Run the bridge on your laptop

The bridge talks to opencode, watches everything that happens, and dials out to your relay.

```powershell
cd opencode-mobile-remote
$env:OPENCODE_BRIDGE_RELAY_URL="wss://opencode-mobile-relay.your-subdomain.workers.dev"
npm run bridge
```

It prints this:

```
  opencode mobile bridge is running
  opencode server : http://127.0.0.1:4599
  working dir     : C:\dev\opencode-mobile

  ┌─────────────────────────────────────────────┐
  │  Pair this phone in the app:  K7QP-3F2M      │
  │  valid for 15 min                            │
  └─────────────────────────────────────────────┘
```

Leave it running. Codes rotate every 15 minutes and a fresh one prints each time.

### Pair your phone

1. Open the app and enter the **machine id** and **pairing code** from above.
2. Enter your **relay URL** from step 1 (the app remembers it afterwards).
3. Tap **Pair this phone**.

You should land on the Approvals tab, and the Sessions tab will fill with your work.

---

## Step 4 — Use the same server for your terminal

This part trips everyone up. opencode sessions live inside whichever server is running them,
so your terminal and the bridge **must share one server**:

```bash
opencode attach http://127.0.0.1:4599
```

Work in that window and your sessions appear on your phone. Sessions started by plain
`opencode` (which starts its own private server) will **not** show up in the app.

To run the server yourself instead:

```bash
opencode serve --port 4599 --hostname 127.0.0.1              # terminal 1
$env:OPENCODE_BRIDGE_URL="http://127.0.0.1:4599"; npm run bridge   # terminal 2
opencode attach http://127.0.0.1:4599                       # terminal 3
```

## Adding another laptop

Every laptop is its own machine with its own id and pairing code, and they all share the same
relay — nothing extra to deploy. Copy this project onto the second laptop (again: **no spaces
in the path**), run step 3 there, and pair your phone with that laptop's code.

The app remembers one laptop at a time, so switch machines by unpairing in Settings and
entering the new code.

---

## Push notifications

Approve-work notifications only arrive if the phone can be reached when the laptop is not
looking at it, so push needs Firebase credentials. Android has no way around this.

1. Create a Firebase project and a service account key (FCM v1):
   <https://docs.expo.dev/push-notifications/fcm-credentials/>
2. With an EAS build: `npx eas-cli@latest credentials -p android` and upload the key.
   With a local build: drop `google-services.json` into `app/android/app/`.

Check **Settings → Push notifications** in the app. It should read *ready*.

Without it the app still updates live while it is open, you just get no background alerts.

---

## Configuration

| Setting | Bridge (environment variable) | App |
| --- | --- | --- |
| Relay URL | `OPENCODE_BRIDGE_RELAY_URL` | asked once, then Settings |
| Machine name | `OPENCODE_BRIDGE_NAME` | shown in the header |
| Existing opencode server | `OPENCODE_BRIDGE_URL` (otherwise the bridge starts one) | n/a |
| Port | `OPENCODE_BRIDGE_PORT` (default 4599) | n/a |
| Working directory | `OPENCODE_BRIDGE_DIR` (default: current directory) | picked in New task |
| opencode auth | `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME` | n/a |

The bridge keeps its machine id and secret in `~/.opencode-mobile/config.json`, and a mirror
of pending approvals in `~/.opencode-mobile/state.json` so a restart cannot lose an approval
you still owe an answer to.

## Security

- Your laptop is never exposed. It only makes outbound connections.
- The relay stores salted hashes of the machine secret and every phone's secret. It never sees
  them in plain text.
- Pairing codes are single use, expire after 15 minutes, and lock out after 8 wrong attempts.
- Only the bridge can create pairing codes; a phone can never add another phone.
- The relay keeps the last 60 notification titles per machine. It does not store message
  content, transcripts or any file contents.
- Revoke a phone any time from Settings, which also closes its live socket.
- If you set `OPENCODE_SERVER_PASSWORD`, the bridge uses it automatically, and the opencode
  server stays bound to `127.0.0.1`.

## Troubleshooting

**"The bridge is offline"** — the bridge is not running, or cannot reach the relay.
`npm run relay:deploy` output and `npm run relay:tail` show what the relay sees.

**Sessions are empty in the app** — you are probably using plain `opencode`. Start it with
`opencode attach http://127.0.0.1:4599` instead.

**"Invalid or expired pairing code"** — codes last 15 minutes. Read the current one from the
bridge window, or restart the bridge for a fresh one.

**No notifications** — Settings → Push notifications must read *ready*. On Android that needs
a development build with Firebase credentials, not Expo Go.

**`ninja: error: manifest 'build.ninja' still dirty after 100 tries`** — your project path
contains a space. Move it somewhere like `C:\dev\opencode-mobile`.

**Gradle dies with no error** — you are out of memory. Close other apps, or use the lean
`gradle.properties` values shown in step 2.

## Developing

```bash
npm run typecheck        # bridge + relay
npm test                 # relay tests, running in the Workers runtime
npm run e2e              # real opencode + real bridge + relay under wrangler dev
npm run app:typecheck    # app
npm run app:lint         # app
```

`npm run e2e` starts everything on free ports in a temporary directory, drives the whole
pairing and RPC path, and cleans up after itself. No cloud account and no model provider
needed.

```
bridge/    node process on your laptop: talks to opencode, dials the relay
relay/     Cloudflare Worker + one Durable Object per machine
app/       Expo React Native app (expo-router)
shared/    types shared by all three
scripts/   end to end test
```

## License

MIT — see [LICENSE](LICENSE).