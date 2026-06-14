// Standalone, pure-Kotlin/JVM build for the app's decision logic. It has NO Android
// dependencies, so it compiles and unit-tests with only a JDK + Gradle — no Android
// SDK or emulator. The Android :app module consumes these same sources via a
// composite build (see android/app/settings.gradle.kts).
rootProject.name = "core"
