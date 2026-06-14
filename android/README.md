# Expense Report — Android app

Replaces FolderSync (photos) and the Google Apps Script (email) with a single,
battery-thin native app. The user takes a photo with the **normal camera (even from
the lock screen)** and it syncs silently; email receipts are handled server-side.

## Architecture

```
core/   Pure Kotlin/JVM logic — NO Android deps. Unit-tested with just JDK+Gradle.
        ReceiptGate · UploadQueue · UploadOutcome · NetworkPolicy · MediaScan
app/    Android app. Thin glue that wires `core` to the OS + the backend.
```

The app is deliberately thin. All intelligence is either in `core` (tested) or on the
Vercel backend (Gemini, Sheets, Gmail). The app only:
1. **Detects** new photos via a WorkManager **content-URI trigger** (OS wakes it; no
   service, no polling → ~0 idle battery).
2. **Gates** each on-device with ML Kit text recognition → `core.ReceiptGate`
   (permissive; ~0.1 J/photo). Non-receipts are dropped without uploading.
3. **Captures bytes** of candidates immediately (survives photo deletion).
4. **Uploads** candidates to `POST /api/inbound` honoring `core.NetworkPolicy`
   (prefer WiFi/charging, but a deadline fallback so nothing is ever stranded).
5. A **periodic sweep** backstop re-scans from the checkpoint to catch any missed
   triggers — the guarantee that no receipt is lost.

See `../.claude/.../memory/android-app-plan.md` for the full design + energy math.

## Build the APK (Android Studio)

1. Install **Android Studio** (brings the Android SDK).
2. `File → Open` → select `android/app`.
3. Let Gradle sync. The `core` logic is pulled in automatically as a composite build.
4. Set config (any of: edit `app/gradle.properties`, `~/.gradle/gradle.properties`,
   or pass `-P` flags):
   - `BASE_URL` — your backend (default `https://simpleexpensereport.vercel.app`)
   - `INBOUND_TOKEN` — must match a backend `INBOUND_TOKENS` / `CRON_SECRET` value
   - `GOOGLE_WEB_CLIENT_ID` — optional, enables Google Sign-In
5. `Build → Build APK(s)`, or:
   ```
   cd android/app
   ./gradlew :app:assembleRelease -PINBOUND_TOKEN=xxxx
   ```
   The APK lands in `app/app/build/outputs/apk/`.

### Distribute without Google Play
Self-signed APK is fine for the team. Share the file (Drive/Firebase App Distribution);
each tester taps it and allows "install from this source" once. Keep the OAuth app in
**Testing** mode (add testers as test users) so restricted Gmail scopes work without
verification.

## Run the unit tests (no Android SDK needed)

```
cd android/core
./gradlew test          # 33 tests: gate, queue, policy, checkpoint, http-outcome
```
(Requires only a JDK 17 + Gradle. The `app` module needs the Android SDK to compile.)

## Status

- `core` — **complete and unit-tested** (33 tests green on JDK 17).
- `app` — **complete, review/Android-Studio-grade**. Written against the documented
  Android APIs but NOT compiled here (this machine has no Android SDK). Expect to
  resolve minor API/version nits on first sync in Android Studio.

## Phase 3 — real-device reliability checklist

These cannot be validated on an emulator; run on a real Android phone.

**Happy paths**
- [ ] Photograph a paper receipt with the stock camera → row appears in the Sheet; "Receipt added" notification.
- [ ] Photograph from the **lock screen** → still captured after unlock.
- [ ] Take several receipts quickly → all sync (burst coalescing works).
- [ ] Email a receipt (attachment + body-only, e.g. Uber) → row appears (backend cron).

**Non-happy / reliability**
- [ ] Photograph a non-receipt (selfie, landscape) → NOT uploaded (gate drops it); no row.
- [ ] Airplane mode, take a receipt, wait, re-enable network → uploads (offline queue + retry).
- [ ] Take a receipt, then delete it from the gallery before sync → still uploads (bytes captured at detection).
- [ ] Force-stop the app, take a receipt, wait for the periodic sweep → captured (backstop).
- [ ] Reboot the phone, take a receipt → captured (trigger re-armed by sweep/launch).
- [ ] Same receipt twice (or app retries after a lost ack) → only ONE row (server dedup).
- [ ] Wrong/expired token → app prompts re-auth, does not silently drop the receipt.

**Battery**
- [ ] Leave idle overnight off-charger → negligible battery use attributed to the app.
- [ ] Confirm uploads prefer WiFi/charging but still go out within the deadline on cellular.
- [ ] Check OEM battery manager (Xiaomi/Samsung) isn't killing the sweep; whitelist if needed.
