plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.expensereport.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.expensereport.app"
        // 26: stable WorkManager content-URI triggers + scoped media + modern APIs.
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"

        buildConfigField("String", "BASE_URL", "\"${project.findProperty("BASE_URL") ?: "https://simpleexpensereport.vercel.app"}\"")
        buildConfigField("String", "INBOUND_TOKEN", "\"${project.findProperty("INBOUND_TOKEN") ?: ""}\"")
        // Set in local.properties as GOOGLE_WEB_CLIENT_ID for Google Sign-In (optional in test mode).
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${project.findProperty("GOOGLE_WEB_CLIENT_ID") ?: ""}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("com.expensereport:core") // the unit-tested pure logic (composite build)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // On-device OCR for the receipt gate (no network, ~0.1 J/photo).
    implementation("com.google.mlkit:text-recognition:16.0.1")

    // Google Sign-In via Credential Manager (one-tap, account already on device).
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    // Multipart upload.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
